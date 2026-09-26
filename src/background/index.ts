import { stripTitle } from "../shared/label";
import { applyEvent, bury, type Action, type EngineEvent, type GroupSnapshot, type TabSnapshot } from "./engine";
import { callHost, chromeSender, explain, HOST_MANIFEST_PATH, REQUEST_ERRORS, SETUP_ERRORS, type HostOpts, type HostReply, type Op } from "./host";
import { GLOBAL_PAUSE_AFTER, GLOBAL_PAUSE_MS, Naming, RATE_LIMIT_PAUSES_MS, type Member, type NamePayload, type NameResult } from "./naming";
import { AutoOrganizer, organizeWindow, undoOrganize, UNDO_WINDOW_MS as ORGANIZE_UNDO_MS } from "./organize";
import { FitChecker } from "./fit";
import { addToGroup, createManagedGroup, ungroup, updateGroup, type Runtime } from "./runtime";
import { withDefaults, type Settings } from "./settings";
import { markDirty, migrate, newGroupRecord, type GroupRecord, type HostError, type PingResult, type RemovedGroup, type State, type TabRecord } from "./state";
import { readDisk, shouldReload, TRIED_KEY, UPDATE_CHECK_MINUTES } from "./selfupdate";
import { adoptParked, forgetArchived, looksParked, parkedTitle, restoreAll, restoreArchived, runSweep, undoSweep, UNDO_WINDOW_MS as SWEEP_UNDO_MS } from "./tidy";

/** Event wiring only: every rule lives in engine / naming / organize / tidy. */

const GROUPS_SUPPORTED = typeof chrome.tabGroups?.query === "function";

const ALARM_NAMING = "naming-fallback";
const ALARM_TIDY = "tidy-sweep";
const ALARM_HOST = "host-retry";
const ALARM_AUTO = "auto-organize";
const ALARM_UPDATE = "self-update";
const HOST_RETRY_MS = 600_000;
/** Records made after this were made by this worker, so after a restart they describe the new session. */
const WORKER_STARTED_AT = Date.now();

// ----- state cache ------------------------------------------------------------------------------

let state: State;
let settings: Settings;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let busyCount = 0;

const ready: Promise<void> = (async () => {
  const stored = await chrome.storage.local.get(["state", "settings"]);
  state = migrate(stored.state);
  settings = withDefaults(stored.settings);
  const f = state.inFlight;
  if (f && Date.now() - f.startedAt > settings.timeoutMs + 5000) state.inFlight = undefined;
})();

/** One `storage.local.set` per event burst: mutations in the same tick share a write. */
function commit(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    chrome.storage.local.set({ state }).catch((e) => console.error("[diagonal] save failed", e));
  }, 0);
}

// ----- logging ---------------------------------------------------------------------------------

async function pushRing(key: string, entry: unknown, cap: number): Promise<void> {
  try {
    const got = await chrome.storage.session.get(key);
    const ring = Array.isArray(got[key]) ? got[key] : [];
    ring.push(entry);
    await chrome.storage.session.set({ [key]: ring.slice(-cap) });
  } catch {
    /* storage.session is best-effort */
  }
}

function log(...args: unknown[]): void {
  if (!settings?.debugLog) return;
  console.log("[diagonal]", ...args);
  void pushRing("debugLog", { at: Date.now(), msg: args.map((a) => (a instanceof Error ? a.message : typeof a === "string" ? a : JSON.stringify(a))).join(" ") }, 200);
}

function logError(where: string, e: unknown): void {
  console.error(`[diagonal] ${where}`, e);
  if (settings?.debugLog) void pushRing("debugLog", { at: Date.now(), msg: `${where}: ${e instanceof Error ? e.message : String(e)}` }, 200);
}

// ----- host ------------------------------------------------------------------------------------

let modelQueue: Promise<unknown> = Promise.resolve();

/** Naming and organizing both run the model: one call at a time, so they never compete for it. */
function oneModelCall<T>(fn: () => Promise<T>): Promise<T> {
  const next = modelQueue.then(fn, fn);
  modelQueue = next.catch(() => undefined);
  return next;
}

async function host<T>(op: Op, payload: object, extra: Partial<HostOpts> = {}): Promise<HostReply<T>> {
  const opts: HostOpts = { model: settings.model, timeoutMs: settings.timeoutMs, emoji: settings.emoji, debug: settings.debugLog, ...extra };
  busy(true);
  try {
    const call = () => callHost<T>(chromeSender, op, payload, opts);
    const reply = op === "ping" ? await call() : await oneModelCall(call);
    const h = state.host;
    if (reply.ok) {
      h.lastOkAt = Date.now();
      h.consecutiveFailures = 0;
      h.consecutiveTimeouts = 0;
      if (op !== "ping") {
        h.rateLimitStep = 0; // a ping doesn't use the model, so it says nothing about its limit
        // A model answer (a manual Organize or Name now during a pause) proves the helper works again.
        if (h.pausedUntil) recovered();
      }
      if (reply.meta?.ms !== undefined) void pushRing("latency", reply.meta.ms, 100);
    } else {
      recordHostError(reply.error);
    }
    log(op, reply.ok ? "ok" : reply.error.code, reply.ok ? reply.meta : reply.error.message);
    commit();
    return reply;
  } finally {
    busy(false);
  }
}

function recordHostError(e: HostError): void {
  // About one request's tabs, not the host's health: the caller retries or sets those tabs aside.
  if (REQUEST_ERRORS.has(e.code)) return;
  const h = state.host;
  const now = Date.now();
  h.lastError = { ...e, at: now };
  h.consecutiveFailures += 1;
  if (e.code === "TIMEOUT") h.consecutiveTimeouts = (h.consecutiveTimeouts ?? 0) + 1;
  let pause = 0;
  if (e.code === "RATE_LIMITED") {
    const step = h.rateLimitStep ?? 0;
    pause = RATE_LIMIT_PAUSES_MS[Math.min(step, RATE_LIMIT_PAUSES_MS.length - 1)];
    h.rateLimitStep = step + 1;
  }
  if (SETUP_ERRORS.has(e.code) || h.consecutiveFailures >= GLOBAL_PAUSE_AFTER) pause = Math.max(pause, GLOBAL_PAUSE_MS);
  if (pause) {
    h.pausedUntil = now + pause;
    chrome.alarms.create(ALARM_HOST, { when: now + Math.min(pause, HOST_RETRY_MS) });
  }
  refreshBadge();
}

async function ping(): Promise<HostReply<PingResult>> {
  const reply = await host<PingResult>("ping", {});
  const h = state.host;
  if (reply.ok) {
    h.lastPing = { ...reply.result, at: Date.now() };
    if (reply.result.licenseRequired) {
      recordHostError({ code: "LICENSE_REQUIRED", message: reply.result.fmMessage });
    } else if (!reply.result.fmAvailable) {
      recordHostError({ code: "MODEL_UNAVAILABLE", message: reply.result.fmMessage || "fm reports the model unavailable" });
    } else if (!reply.result.schemasOk) {
      recordHostError({ code: "SCHEMA_MISSING", message: reply.result.schemaMessage || "fm could not write Diagonal's schema files" });
    } else {
      recovered();
    }
  }
  commit();
  refreshBadge();
  return reply;
}

/** The helper answers again: lift the pause and pick up what waited for it. */
function recovered(): void {
  const h = state.host;
  h.pausedUntil = undefined;
  h.lastError = undefined;
  chrome.alarms.clear(ALARM_HOST);
  void naming.sweepDirty();
  void autoOrganizer.sweep();
}

// ----- badge -----------------------------------------------------------------------------------

function busy(on: boolean): void {
  busyCount = Math.max(0, busyCount + (on ? 1 : -1));
  refreshBadge();
}

function hostUnhealthy(): boolean {
  const h = state.host;
  const now = Date.now();
  if (h.pausedUntil && h.pausedUntil > now) return true;
  return !!h.lastError && SETUP_ERRORS.has(h.lastError.code) && (!h.lastOkAt || h.lastOkAt < (h.lastError.at ?? 0));
}

function refreshBadge(): void {
  if (!state) return;
  let text = "";
  let color = "#5f6368";
  if (hostUnhealthy()) {
    text = "!";
    color = "#d93025";
  } else if (busyCount > 0 || state.inFlight) {
    text = "…";
  } else if (settings.tidyMode === "ask" && (state.tidyCandidates ?? 0) >= settings.tidyThreshold) {
    text = String(state.tidyCandidates);
    color = "#1a73e8";
  }
  chrome.action.setBadgeText({ text }).catch(() => undefined);
  chrome.action.setBadgeBackgroundColor({ color }).catch(() => undefined);
}

// ----- runtime handle --------------------------------------------------------------------------

async function scheduleFallback(when: number): Promise<void> {
  const at = Math.max(when, Date.now() + 30_000);
  const existing = await chrome.alarms.get(ALARM_NAMING);
  if (existing && existing.scheduledTime <= at && existing.scheduledTime > Date.now()) return;
  await chrome.alarms.create(ALARM_NAMING, { when: at });
}

async function liveMembers(groupId: number): Promise<Member[] | undefined> {
  try {
    const tabs = await chrome.tabs.query({ groupId });
    return tabs.map((t) => ({
      id: t.id!,
      index: t.index,
      url: t.url ?? "",
      title: t.title ?? "",
      status: t.status,
      description: state.tabs[t.id!]?.description,
      lastActive: Math.max(t.lastAccessed ?? 0, state.tabs[t.id!]?.lastActivatedAt ?? 0),
    }));
  } catch {
    return undefined;
  }
}

const naming: Naming = new Naming({
  now: () => Date.now(),
  state: () => state,
  settings: () => settings,
  commit,
  liveMembers,
  callName: (payload: NamePayload, opts: HostOpts) => host<NameResult>("name", payload, opts),
  writeTitle: (groupId, title) => updateGroup(rt, groupId, { title }),
  scheduleFallback: (when) => void scheduleFallback(when),
  busy: () => refreshBadge(),
  hostFailed: () => refreshBadge(),
  hostOk: () => refreshBadge(),
  log,
});

const rt: Runtime = {
  state: () => state,
  settings: () => settings,
  commit,
  now: () => Date.now(),
  host,
  naming,
  refreshBadge,
  log,
};

async function scheduleAutoFallback(when: number): Promise<void> {
  const at = Math.max(when, Date.now() + 30_000);
  const existing = await chrome.alarms.get(ALARM_AUTO);
  if (existing && existing.scheduledTime <= at && existing.scheduledTime > Date.now()) return;
  await chrome.alarms.create(ALARM_AUTO, { when: at });
}

const autoOrganizer = new AutoOrganizer(rt, { scheduleFallback: (when) => void scheduleAutoFallback(when) });
const fitChecker = new FitChecker(rt);

// ----- engine glue -----------------------------------------------------------------------------

let chain: Promise<unknown> = Promise.resolve();

/** Browser events are handled one at a time, in order, each wrapped so one error cannot stop the rest. */
function serial(where: string, fn: () => Promise<void>): Promise<void> {
  const next = chain.then(async () => {
    await ready;
    try {
      await fn();
    } catch (e) {
      logError(where, e);
    }
  });
  chain = next;
  return next;
}

const snapTab = (t: chrome.tabs.Tab): TabSnapshot => ({
  id: t.id!,
  windowId: t.windowId,
  groupId: t.groupId ?? -1,
  index: t.index,
  url: t.url,
  pendingUrl: t.pendingUrl,
  title: t.title,
  pinned: t.pinned,
  openerTabId: t.openerTabId,
  incognito: t.incognito,
  status: t.status,
  lastAccessed: t.lastAccessed,
});

const snapGroup = (g: chrome.tabGroups.TabGroup): GroupSnapshot => ({
  id: g.id,
  windowId: g.windowId,
  title: g.title,
  color: g.color,
  collapsed: g.collapsed,
});

async function feed(event: EngineEvent): Promise<void> {
  const actions = applyEvent(state, event, { now: Date.now(), settings });
  commit();
  for (const a of actions) await run(a);
}

async function run(a: Action): Promise<void> {
  switch (a.type) {
    case "createGroup": {
      const id = await createManagedGroup(rt, a.tabIds, a.windowId, a.origin, { title: a.title, color: a.color }, { userNamed: false });
      if (id !== undefined) {
        markDirty(state.groups[id], Date.now());
        naming.touch(id);
      }
      break;
    }
    case "addToGroup":
      await addToGroup(rt, a.tabIds, a.groupId);
      break;
    case "ungroup":
      for (const id of a.tabIds) state.ownUngroups[id] = Date.now();
      await ungroup(rt, a.tabIds);
      break;
    case "unpark": {
      const rec = state.tabs[a.tabId];
      if (rec) rec.organizedKey = undefined;
      state.ownUngroups[a.tabId] = Date.now();
      await ungroup(rt, [a.tabId]);
      if ((await chrome.tabs.query({ groupId: a.groupId }).catch(() => [])).length) await updateGroup(rt, a.groupId, { collapsed: true });
      break;
    }
    case "loose":
      autoOrganizer.touch(a.windowId);
      break;
    case "scheduleDissolve":
      // Re-checked after the delay so Cmd+Shift+T right after a close does not flicker.
      setTimeout(() => {
        void serial("dissolve", async () => {
          const members = await chrome.tabs.query({ groupId: a.groupId }).catch(() => []);
          await feed({ type: "dissolveCheck", groupId: a.groupId, memberIds: members.map((t) => t.id!) });
        });
      }, a.delayMs);
      break;
    case "dirty":
      naming.touch(a.groupId);
      break;
    case "checkFit":
      fitChecker.touch();
      break;
  }
}

async function tabById(id: number): Promise<chrome.tabs.Tab | undefined> {
  return chrome.tabs.get(id).catch(() => undefined);
}

// ----- reconcile -------------------------------------------------------------------------------

/**
 * On startup and install: rebuild the state model from the live browser. Tab and group ids change
 * across restarts, so records are matched by id first and then by URL (tabs) or title and colour
 * (groups), which keeps managed groups managed after the browser restarts.
 */
async function reconcile(reason: "startup" | "installed"): Promise<void> {
  const [tabs, groups] = await Promise.all([chrome.tabs.query({}), chrome.tabGroups.query({})]);
  const now = Date.now();
  const liveTabIds = new Set(tabs.map((t) => t.id));
  // Records of tabs that are gone, by address: after a restart every tab has a new id.
  const byUrl = new Map<string, TabRecord>(Object.values(state.tabs).filter((t) => !liveTabIds.has(t.id)).map((t) => [t.url, t]));
  const nextTabs: Record<number, TabRecord> = {};
  for (const t of tabs) {
    if (t.incognito || t.id === undefined) continue;
    const url = t.url || t.pendingUrl || "";
    const same = state.tabs[t.id]?.url === url ? state.tabs[t.id] : undefined;
    // An event handled before this ran may have recorded a restored tab as new: its old record knows more.
    const old = byUrl.get(url);
    const prev = old && (!same || same.createdAt >= WORKER_STARTED_AT) ? old : same;
    // Chromium stamps a restored tab it has not shown yet with the restore time, so after a restart the
    // stored time is the truer one for every tab but the one on screen.
    const lastSeen =
      reason === "startup" && prev && !t.active ? prev.lastActivatedAt : Math.max(prev?.lastActivatedAt ?? 0, t.lastAccessed ?? 0);
    nextTabs[t.id] = {
      id: t.id,
      windowId: t.windowId,
      groupId: t.groupId ?? -1,
      index: t.index,
      url,
      title: t.title ?? "",
      pinned: t.pinned,
      status: t.status,
      openerTabId: t.openerTabId,
      description: prev?.description,
      parkedFrom: prev?.parkedFrom,
      parkedAt: prev?.parkedAt,
      keepLoose: prev?.keepLoose,
      organizedKey: prev?.organizedKey,
      organizeRefused: prev?.organizeRefused,
      handPlaced: prev?.handPlaced,
      fitPending: prev?.fitPending,
      createdAt: prev?.createdAt ?? now,
      lastActivatedAt: lastSeen || now,
    };
  }
  const liveGroupIds = new Set(groups.map((g) => g.id));
  const unmatched = new Map(Object.values(state.groups).map((g) => [g.id, g]));
  // Made by this worker for a group it did not know: after a restart, that is a restored group whose
  // events were handled before this ran, and the record from before the restart is the one to keep.
  const fresh = (g: GroupRecord) => g.origin === "user" && (g.registeredAt ?? 0) >= WORKER_STARTED_AT;
  const lookalike = (title: string, color: string): GroupRecord | RemovedGroup | undefined => {
    if (title === "") return undefined;
    const alike = (o: GroupRecord) => (o.stripTitle ?? "") === title && o.color === color;
    return (
      [...unmatched.values()].find((o) => alike(o) && !liveGroupIds.has(o.id) && !fresh(o)) ??
      Object.values(state.removedGroups)
        .filter(alike)
        .sort((a, b) => b.removedAt - a.removedAt)[0]
    );
  };
  const nextGroups: Record<number, GroupRecord> = {};
  for (const g of groups) {
    const title = g.title ?? "";
    let prev: GroupRecord | undefined = unmatched.get(g.id);
    if (prev && (prev.stripTitle ?? "") !== title) prev = undefined;
    const before = !prev || fresh(prev) ? lookalike(title, g.color) : undefined;
    if (before) prev = before;
    let rec: GroupRecord;
    if (prev) {
      unmatched.delete(prev.id);
      delete state.removedGroups[prev.id];
      const { removedAt: _, ...kept } = prev as RemovedGroup;
      rec = { ...kept, id: g.id, windowId: g.windowId, color: g.color, stripTitle: title };
      if (before) rec.registeredAt = undefined;
    } else {
      // Untitled so far may still mean restored: its title can arrive next and match (engine.ts groupUpdated).
      rec = newGroupRecord(g.id, g.windowId, "user", g.color, { managed: settings.nameUserGroups, userNamed: !!title, stripTitle: title, registeredAt: now });
    }
    // Earlier versions turned Parked into a plain group after a restart: give it back its job.
    if (rec.origin === "user" && looksParked(g, settings)) adoptParked(rec, settings);
    if (rec.managed) {
      rec.dirty = true;
      rec.dirtyAt = 0;
      rec.dirtySeq = (rec.dirtySeq ?? 0) + 1;
    }
    nextGroups[g.id] = rec;
  }
  // Groups not seen now (a closed window, a quit that did not save) may still come back: keep them a day.
  for (const old of unmatched.values()) if (!liveGroupIds.has(old.id) && !fresh(old)) bury(state, old, now);
  state.tabs = nextTabs;
  state.groups = nextGroups;
  state.pendingCreates = [];
  state.ownWrites = {};
  state.ownUngroups = {};
  state.ownAdds = {};
  // Undo lists name tabs by id, and after a restart none of those ids exist.
  if (reason === "startup" || (state.lastSweep && now - state.lastSweep.at > SWEEP_UNDO_MS)) state.lastSweep = undefined;
  if (reason === "startup" || (state.lastOrganize && now - state.lastOrganize.at > ORGANIZE_UNDO_MS)) state.lastOrganize = undefined;
  commit();
}

/** Tabs open before install never ran the content script: read their descriptions now. */
async function injectBacklog(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  for (const t of tabs) {
    if (t.id === undefined || t.discarded || t.incognito || state.tabs[t.id]?.description) continue;
    chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["content.js"] }).catch(() => undefined);
  }
}

let reconciled: Promise<void> | undefined;

async function boot(reason: "startup" | "installed"): Promise<void> {
  // Queued before anything else this wake handles (serial waits for `ready` itself): after a restart
  // Chromium replays the restored groups right after onStartup, and they must meet the reconciled state.
  reconciled = serial("reconcile", () => reconcile(reason));
  await reconciled;
  if (!(await chrome.alarms.get(ALARM_TIDY))) chrome.alarms.create(ALARM_TIDY, { periodInMinutes: 30, delayInMinutes: 1 });
  if (reason === "installed") void injectBacklog();
  await ping();
  await naming.sweepDirty();
  if (reason === "startup") void runSweep(rt).catch((e) => logError("tidy", e));
  await autoOrganizer.sweep();
  refreshBadge();
}

// ----- browser events --------------------------------------------------------------------------

// Every Chromium browser has tabs, but not all let extensions manage tab groups (chrome.tabGroups,
// Chromium 89+): without it Diagonal stays idle and the popup says why.
if (GROUPS_SUPPORTED) {
  chrome.runtime.onStartup.addListener(() => void boot("startup"));
  chrome.runtime.onInstalled.addListener(() => void boot("installed"));

  chrome.tabs.onCreated.addListener((tab) =>
    serial("tabs.onCreated", async () => {
      const opener = tab.openerTabId !== undefined ? await tabById(tab.openerTabId) : undefined;
      await feed({ type: "tabCreated", tab: snapTab(tab), opener: opener && snapTab(opener) });
    }),
  );

  chrome.tabs.onUpdated.addListener((_id, change, tab) => {
    if (!("title" in change || "url" in change || "status" in change || "groupId" in change || "pinned" in change)) return;
    void serial("tabs.onUpdated", () => feed({ type: "tabUpdated", tab: snapTab(tab) }));
  });

  const refetch = (where: string) => (tabId: number) =>
    void serial(where, async () => {
      const t = await tabById(tabId);
      if (t) await feed({ type: "tabUpdated", tab: snapTab(t) });
    });
  chrome.tabs.onMoved.addListener(refetch("tabs.onMoved"));
  chrome.tabs.onAttached.addListener(refetch("tabs.onAttached"));

  chrome.tabs.onRemoved.addListener((tabId) => void serial("tabs.onRemoved", () => feed({ type: "tabRemoved", tabId })));

  chrome.tabs.onReplaced.addListener((added, removed) =>
    void serial("tabs.onReplaced", async () => {
      // Chromium swapped in a new tab (a prerendered page, a discarded tab coming back): it is the same
      // tab to the user, so it keeps what Diagonal knew about it, including choices the user made.
      const rec = state.tabs[removed];
      delete state.tabs[removed];
      const t = await tabById(added);
      if (t) {
        if (rec && !state.tabs[added]) state.tabs[added] = { ...rec, id: added };
        await feed({ type: "tabUpdated", tab: snapTab(t) });
      }
    }),
  );

  chrome.tabs.onActivated.addListener(({ tabId }) => void serial("tabs.onActivated", () => feed({ type: "tabActivated", tabId })));

  // A group is read when its turn comes, not as Chromium sent it: a restored group reports itself
  // untitled and then titled, and replaying the stale "untitled" would read as you clearing the title.
  const refetchGroup = (where: string, type: "groupCreated" | "groupUpdated") => (g: chrome.tabGroups.TabGroup) =>
    void serial(where, async () => {
      const now = await chrome.tabGroups.get(g.id).catch(() => undefined);
      if (now) await feed({ type, group: snapGroup(now) });
    });
  chrome.tabGroups.onCreated.addListener(refetchGroup("tabGroups.onCreated", "groupCreated"));
  chrome.tabGroups.onUpdated.addListener(refetchGroup("tabGroups.onUpdated", "groupUpdated"));
  chrome.tabGroups.onRemoved.addListener((g) => void serial("tabGroups.onRemoved", () => feed({ type: "groupRemoved", groupId: g.id })));
}

// ----- self-update -------------------------------------------------------------------------------

/** After `brew upgrade`, reload into the new files on disk so nobody has to click reload. */
async function checkForUpdate(): Promise<void> {
  const self = await chrome.management.getSelf().catch(() => undefined);
  if (self?.installType !== "development") return; // store installs update themselves
  if (busyCount > 0) return; // a model call is in flight; the next check picks it up
  const disk = await readDisk(fetch, (p) => chrome.runtime.getURL(p));
  const lastTried = (await chrome.storage.local.get(TRIED_KEY))[TRIED_KEY] as string | undefined;
  if (!shouldReload({ running: chrome.runtime.getManifest().version, lastTried, ...disk })) return;
  await chrome.storage.local.set({ [TRIED_KEY]: disk.onDisk });
  console.info(`[diagonal] reloading into ${disk.onDisk} from disk`);
  chrome.runtime.reload();
}

void (async () => {
  if (!(await chrome.alarms.get(ALARM_UPDATE))) chrome.alarms.create(ALARM_UPDATE, { periodInMinutes: UPDATE_CHECK_MINUTES, delayInMinutes: 1 });
})();

chrome.alarms.onAlarm.addListener((alarm) => {
  void (async () => {
    if (alarm.name === ALARM_UPDATE) return void checkForUpdate().catch((e) => logError("self-update", e));
    await ready;
    if (alarm.name === ALARM_NAMING) await naming.sweepDirty();
    else if (alarm.name === ALARM_AUTO) await autoOrganizer.sweep();
    else if (alarm.name === ALARM_TIDY) {
      await reconciled; // an overdue sweep right after a restart waits for the new tab and group ids
      await runSweep(rt).catch((e) => logError("tidy", e));
    }
    else if (alarm.name === ALARM_HOST) {
      const r = await ping();
      if (!r.ok || hostUnhealthy()) chrome.alarms.create(ALARM_HOST, { when: Date.now() + HOST_RETRY_MS });
    }
  })();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.settings) return;
  void (async () => {
    await ready;
    const before = settings;
    settings = withDefaults(changes.settings.newValue);
    if (before.emoji !== settings.emoji) await rewriteTitles(before);
    if (before.nameUserGroups !== settings.nameUserGroups) applyNameUserGroups();
    if (before.tidyMode !== settings.tidyMode || before.tidyThreshold !== settings.tidyThreshold) await runSweep(rt).catch(() => undefined);
    if (!before.autoOrganize && settings.autoOrganize) await autoOrganizer.sweep();
    refreshBadge();
  })();
});

/** "Name groups I make too" applies to the groups you already made, not only to new ones. */
function applyNameUserGroups(): void {
  for (const g of Object.values(state.groups)) {
    if (g.origin !== "user" || g.userNamed) continue;
    g.managed = settings.nameUserGroups;
    if (g.managed) {
      markDirty(g, Date.now());
      naming.touch(g.id);
    }
  }
  commit();
}

/** Emoji switched on or off: rewrite the titles the extension wrote. */
async function rewriteTitles(before: Settings): Promise<void> {
  for (const g of Object.values(state.groups)) {
    // Parked is always "user named", so its title is compared instead: one you typed stays.
    if (g.origin === "tidy") {
      if ((g.stripTitle ?? "") === parkedTitle(before)) await updateGroup(rt, g.id, { title: parkedTitle(settings) });
    } else if (g.managed && !g.userNamed && g.title) await updateGroup(rt, g.id, { title: stripTitle(g.title, g.emoji, settings.emoji) });
  }
}

async function nameGroupNow(groupId: number): Promise<void> {
  const g = state.groups[groupId];
  if (!g) return;
  // An explicit request overrides "don't name" and a hand-typed title for this group, and the model's
  // answer goes on the strip even when it is close to the label it gave before.
  g.managed = true;
  g.userNamed = false;
  g.title = undefined;
  g.lastNamedAt = undefined;
  commit();
  await naming.nameNow(groupId);
}

// ----- messages (content script, popup, options) -----------------------------------------------

type Msg = { kind?: string; cmd?: string; [k: string]: any };

chrome.runtime.onMessage.addListener((msg: Msg, sender, sendResponse) => {
  if (msg?.kind === "meta") {
    const tabId = sender.tab?.id;
    if (tabId !== undefined && !sender.tab?.incognito && typeof msg.description === "string") {
      void serial("meta", () => feed({ type: "meta", tabId, description: msg.description }));
    }
    return false;
  }
  // Commands come only from the extension's own pages (popup, options — the latter opens in a tab).
  if (!msg?.cmd || sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(""))) return false;
  ready
    .then(() => handleCommand(msg))
    .then((r) => sendResponse({ ok: true, result: r }))
    .catch((e) => {
      logError(`cmd ${msg.cmd}`, e);
      sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
    });
  return true;
});

async function handleCommand(msg: Msg): Promise<unknown> {
  switch (msg.cmd) {
    case "status":
      void checkForUpdate().catch((e) => logError("self-update", e)); // opening the popup checks too
      return statusFor(msg.windowId);
    case "ping":
      return ping();
    case "selftest":
      return selfTest();
    case "organize":
      return organizeWindow(rt, msg.windowId);
    case "undoOrganize":
      return undoOrganize(rt);
    case "tidyNow":
      return runSweep(rt, true);
    case "undoSweep":
      return undoSweep(rt);
    case "restore":
      return restoreArchived(rt, msg.archivedAt, msg.url, msg.windowId);
    case "forget":
      return forgetArchived(rt, msg.archivedAt, msg.url);
    case "restoreAll":
      return restoreAll(rt, msg.windowId);
    case "groupKeep": {
      const g = state.groups[msg.groupId];
      if (g) g.keep = !!msg.keep;
      commit();
      return !!g;
    }
    case "groupDontName": {
      const g = state.groups[msg.groupId];
      if (g) {
        g.userNamed = true;
        g.dirty = false;
      }
      commit();
      return !!g;
    }
    case "groupNameNow":
      await nameGroupNow(msg.groupId);
      return true;
    case "groupUngroup": {
      const members = await chrome.tabs.query({ groupId: msg.groupId });
      await ungroup(rt, members.map((t) => t.id!));
      return true;
    }
    case "exportArchive":
      return state.archive;
    case "diagnostics": {
      const got = await chrome.storage.session.get(["latency", "debugLog"]);
      return { latency: got.latency ?? [], debugLog: got.debugLog ?? [], host: state.host };
    }
    default:
      throw new Error(`unknown command ${msg.cmd}`);
  }
}

async function selfTest(): Promise<unknown> {
  const t0 = Date.now();
  const p = await ping();
  const pingMs = Date.now() - t0;
  const fixture: NamePayload = {
    items: [
      { i: 0, title: "Tokio - An asynchronous Rust runtime", url: "https://tokio.rs/", description: "Tokio is an asynchronous runtime for the Rust programming language." },
      { i: 1, title: "async-std", url: "https://async.rs/", description: "Async version of the Rust standard library." },
      { i: 2, title: "Asynchronous Programming in Rust", url: "https://rust-lang.github.io/async-book/" },
    ],
    siblingTitles: [],
  };
  const t1 = Date.now();
  const name = p.ok ? await host<NameResult>("name", fixture) : undefined;
  return { ping: p, pingMs, name, nameMs: name ? Date.now() - t1 : undefined };
}

async function statusFor(windowId: number | undefined): Promise<unknown> {
  const now = Date.now();
  const h = state.host;
  const groupsInWindow = Object.values(state.groups).filter((g) => windowId === undefined || g.windowId === windowId);
  const parking = groupsInWindow.find((g) => g.origin === "tidy");
  const parkedCount = parking ? (await chrome.tabs.query({ groupId: parking.id }).catch(() => [])).length : 0;
  let health: "ok" | "unknown" | "degraded" = h.lastOkAt ? "ok" : "unknown";
  if (hostUnhealthy()) health = "degraded";
  return {
    health,
    message: hostUnhealthy() ? explain(h.lastError, chrome.runtime.id) : "",
    lastError: h.lastError,
    lastPing: h.lastPing,
    timeoutHint: (h.consecutiveTimeouts ?? 0) >= 3,
    inFlight: !!state.inFlight || naming.pendingCount > 0,
    tidyMode: settings.tidyMode,
    tidyThreshold: settings.tidyThreshold,
    tidyCandidates: state.tidyCandidates ?? 0,
    parkedCount,
    canUndoSweep: !!state.lastSweep && now - state.lastSweep.at < SWEEP_UNDO_MS,
    canUndoOrganize: !!state.lastOrganize && now - state.lastOrganize.at < ORGANIZE_UNDO_MS,
    archive: state.archive,
    groups: await Promise.all(
      groupsInWindow
        .filter((g) => g.origin !== "tidy")
        .map(async (g) => ({
          id: g.id,
          title: g.stripTitle || g.title || "",
          color: g.color,
          origin: g.origin,
          managed: g.managed,
          userNamed: g.userNamed,
          keep: !!g.keep,
          dirty: g.dirty,
          size: (await chrome.tabs.query({ groupId: g.id }).catch(() => [])).length,
        })),
    ),
    groupsSupported: GROUPS_SUPPORTED,
    extensionId: chrome.runtime.id,
    manifestPath: HOST_MANIFEST_PATH,
  };
}

// Make the badge right as soon as the worker wakes, whatever woke it.
void ready.then(refreshBadge);
