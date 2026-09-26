import { PARKED_EMOJI, RESTORED_EMOJI } from "../shared/emoji";
import { labelOf, stripTitle } from "../shared/label";
import { isInternalUrl } from "../shared/url";
import { addToGroup, createManagedGroup, groupExists, ungroup, updateGroup, type Runtime } from "./runtime";
import type { Settings } from "./settings";
import { newGroupRecord, type ArchivedTab, type GroupRecord, type State, type SweepMove } from "./state";

/** Section 7: park stale tabs in a collapsed group, then archive and close them. No model calls. */

export const HOUR = 3_600_000;
export const UNDO_WINDOW_MS = HOUR;

export interface TidyTab {
  id: number;
  windowId: number;
  groupId: number;
  index: number;
  url?: string;
  title?: string;
  favIconUrl?: string;
  pinned: boolean;
  active: boolean;
  audible?: boolean;
  incognito?: boolean;
  discarded?: boolean;
  autoDiscardable?: boolean;
  lastAccessed?: number;
}

/**
 * The engine's record wins over Chromium's lastAccessed: after a restart Chromium stamps restored tabs
 * nobody has looked at yet with the restore time, which would keep them from ever going stale.
 */
export const idleMs = (tab: TidyTab, state: State, now: number): number =>
  now - (state.tabs[tab.id]?.lastActivatedAt ?? tab.lastAccessed ?? now);

/** How long a tab has sat in Parked. Tabs found there with no parking time start their clock now. */
export const parkedMs = (tab: TidyTab, state: State, now: number): number => {
  const at = state.tabs[tab.id]?.parkedAt;
  return at === undefined ? 0 : now - at;
};

/** Exclusions are substrings of the URL; a pattern written as /…/ is a regular expression. */
export function excluded(url: string, patterns: string[]): boolean {
  const u = url.toLowerCase();
  return patterns.some((p) => {
    const m = /^\/(.+)\/([a-z]*)$/.exec(p);
    if (m) {
      try {
        return new RegExp(m[1], m[2]).test(url);
      } catch {
        return false;
      }
    }
    return u.includes(p.toLowerCase());
  });
}

export const parkingGroupIds = (state: State): Set<number> =>
  new Set(Object.values(state.groups).filter((g) => g.origin === "tidy").map((g) => g.id));

export function isParkCandidate(tab: TidyTab, state: State, settings: Settings, now: number, parking = parkingGroupIds(state)): boolean {
  if (tab.pinned || tab.active || tab.audible || tab.incognito) return false;
  if (!tab.url || isInternalUrl(tab.url)) return false;
  if (parking.has(tab.groupId)) return false;
  if (tab.groupId !== -1) {
    const g = state.groups[tab.groupId];
    if (g?.keep) return false;
    // Groups you made or renamed are yours, like Diagonal's other rules treat them.
    if ((!g || g.origin === "user" || g.userNamed) && !settings.tidyUserGroups) return false;
  }
  if (excluded(tab.url, settings.tidyExclusions)) return false;
  return idleMs(tab, state, now) >= settings.parkAfterHours * HOUR;
}

export function parkCandidates(tabs: TidyTab[], state: State, settings: Settings, now: number): TidyTab[] {
  const parking = parkingGroupIds(state);
  return tabs.filter((t) => isParkCandidate(t, state, settings, now, parking));
}

/** Tabs that have sat in Parked for the archive time, counted from when they were parked. */
export function archiveCandidates(tabs: TidyTab[], state: State, settings: Settings, now: number): TidyTab[] {
  if (!settings.archiveAfterHours) return [];
  const parking = parkingGroupIds(state);
  return tabs.filter(
    (t) =>
      parking.has(t.groupId) &&
      !t.active &&
      !t.audible &&
      !(t.url && excluded(t.url, settings.tidyExclusions)) &&
      parkedMs(t, state, now) >= settings.archiveAfterHours * HOUR,
  );
}

/** Prepend entries newest first and drop the oldest past the cap. */
export function addToArchive(archive: ArchivedTab[], entries: ArchivedTab[], cap: number): ArchivedTab[] {
  return [...entries.sort((a, b) => b.archivedAt - a.archivedAt), ...archive].slice(0, cap);
}

export const parkedTitle = (settings: Settings): string => stripTitle("Parked", PARKED_EMOJI, settings.emoji);

/** A grey group titled like Parked: Diagonal's Parked group, even where an older version lost track of it. */
export const looksParked = (g: { title?: string; color: string }, settings: Settings): boolean =>
  g.color === "grey" && (g.title ?? "") === parkedTitle(settings);

/** Make a group Diagonal's Parked group again. */
export function adoptParked(g: GroupRecord, settings: Settings): void {
  Object.assign(g, { origin: "tidy", managed: true, userNamed: true, stripTitle: parkedTitle(settings) });
}

// ---------------------------------------------------------------------------------------------

const liveTabs = async (): Promise<TidyTab[]> =>
  (await chrome.tabs.query({})).filter((t) => !t.incognito).map((t) => ({
    id: t.id!,
    windowId: t.windowId,
    groupId: t.groupId ?? -1,
    index: t.index,
    url: t.url,
    title: t.title,
    favIconUrl: t.favIconUrl,
    pinned: t.pinned,
    active: t.active,
    audible: t.audible,
    incognito: t.incognito,
    discarded: t.discarded,
    autoDiscardable: t.autoDiscardable,
    lastAccessed: t.lastAccessed,
  }));

export interface SweepReport {
  candidates: number;
  parked: number;
  archived: number;
}

let sweeps: Promise<unknown> = Promise.resolve();

/**
 * The 30-minute sweep (manual = "Tidy now" / "Park N tabs": ignores the threshold and the Ask
 * consent, still respects eligibility). One at a time: two at once would park, and archive, the
 * same tabs twice.
 */
export function runSweep(rt: Runtime, manual = false): Promise<SweepReport> {
  const next = sweeps.then(() => sweep(rt, manual));
  sweeps = next.catch(() => undefined);
  return next;
}

async function sweep(rt: Runtime, manual: boolean): Promise<SweepReport> {
  const settings = rt.settings();
  const report: SweepReport = { candidates: 0, parked: 0, archived: 0 };
  if (settings.tidyMode === "off" && !manual) {
    rt.state().tidyCandidates = 0;
    rt.refreshBadge();
    return report;
  }
  const now = rt.now();
  let tabs = await liveTabs();
  startParkedClocks(rt.state(), tabs, now);
  const candidates = parkCandidates(tabs, rt.state(), settings, now);
  report.candidates = candidates.length;
  // Auto parks whatever is stale; the threshold only decides when Ask mode puts a count on the badge.
  const park = manual || settings.tidyMode === "auto";
  if (park && candidates.length) {
    report.parked = await parkTabs(rt, candidates);
    tabs = await liveTabs();
  }
  if (settings.tidyMode !== "off" || manual) report.archived = await archiveStale(rt, tabs);
  rt.state().tidyCandidates = park ? 0 : candidates.length;
  rt.commit();
  rt.refreshBadge();
  return report;
}

/** Tabs already in Parked with no parking time (from before it was recorded) start their archive clock now. */
function startParkedClocks(s: State, tabs: TidyTab[], now: number): void {
  const parking = parkingGroupIds(s);
  for (const t of tabs) {
    const rec = s.tabs[t.id];
    if (rec && parking.has(t.groupId) && rec.parkedAt === undefined) rec.parkedAt = now;
  }
}

/** What undo needs to make a group again if parking emptied it, named as it was. */
const groupShape = (g: GroupRecord): SweepMove["group"] => ({
  origin: g.origin,
  managed: g.managed,
  userNamed: g.userNamed,
  title: g.title,
  emoji: g.emoji,
  stripTitle: g.stripTitle,
  color: g.color,
  colorLocked: g.colorLocked,
  keep: g.keep,
  membersHash: g.membersHash,
  memberUrls: g.memberUrls,
  lastNamedAt: g.lastNamedAt,
});

/**
 * The window's Parked group: the one on record, or a group already showing the Parked title (one an
 * older version lost track of after a restart), which becomes Parked again.
 */
async function parkingGroupIn(rt: Runtime, windowId: number): Promise<number | undefined> {
  const s = rt.state();
  const known = Object.values(s.groups).find((g) => g.origin === "tidy" && g.windowId === windowId)?.id;
  if (known !== undefined && (await groupExists(known))) return known;
  const settings = rt.settings();
  const shown = (await chrome.tabGroups.query({ windowId }).catch(() => [])).filter((g) => looksParked(g, settings));
  for (const g of shown) {
    const rec = s.groups[g.id] ?? newGroupRecord(g.id, windowId, "tidy", "grey");
    adoptParked(rec, settings);
    s.groups[g.id] = rec;
  }
  return shown[0]?.id;
}

async function parkTabs(rt: Runtime, candidates: TidyTab[]): Promise<number> {
  const settings = rt.settings();
  const now = rt.now();
  const moves: SweepMove[] = [];
  const byWindow = new Map<number, TidyTab[]>();
  for (const t of candidates) byWindow.set(t.windowId, [...(byWindow.get(t.windowId) ?? []), t]);
  for (const [windowId, tabs] of byWindow) {
    const ids = tabs.map((t) => t.id);
    const s = rt.state();
    for (const t of tabs) {
      const from = t.groupId !== -1 ? s.groups[t.groupId] : undefined;
      moves.push({ tabId: t.id, groupId: t.groupId, index: t.index, windowId, group: from && groupShape(from) });
      const rec = s.tabs[t.id];
      if (rec) {
        rec.parkedFrom = from ? labelOf(from.stripTitle || from.title) || undefined : undefined;
        rec.parkedAt = now;
      }
    }
    let parking = await parkingGroupIn(rt, windowId);
    if (parking === undefined) {
      parking = await createManagedGroup(rt, ids, windowId, "tidy", { title: parkedTitle(settings), color: "grey", collapsed: true }, { userNamed: true });
    } else {
      await addToGroup(rt, ids, parking);
      await updateGroup(rt, parking, { collapsed: true });
    }
    if (parking === undefined) continue;
    try {
      await chrome.tabGroups.move(parking, { index: -1 });
    } catch (e) {
      rt.log("could not move parking group to the end", e);
    }
    if (settings.discardParked) {
      // An extension's discard skips Chromium's own checks, so honour a tab marked "never discard".
      for (const t of tabs) {
        if (!t.discarded && t.autoDiscardable !== false) await chrome.tabs.discard(t.id).catch(() => undefined);
      }
    }
  }
  // Sweeps inside the undo window add up, so Undo puts back everything parked in that hour.
  const last = rt.state().lastSweep;
  const kept = last && now - last.at < UNDO_WINDOW_MS ? last.moves.filter((m) => !moves.some((n) => n.tabId === m.tabId)) : [];
  rt.state().lastSweep = { at: now, moves: [...kept, ...moves] };
  rt.commit();
  return moves.length;
}

async function archiveStale(rt: Runtime, tabs: TidyTab[]): Promise<number> {
  const settings = rt.settings();
  const now = rt.now();
  const stale = archiveCandidates(tabs, rt.state(), settings, now);
  if (!stale.length) return 0;
  const s = rt.state();
  const entries: ArchivedTab[] = stale.map((t) => ({
    url: t.url ?? "",
    title: t.title || t.url || "",
    favIconUrl: t.favIconUrl?.startsWith("data:") && t.favIconUrl.length > 4096 ? undefined : t.favIconUrl,
    groupTitle: s.tabs[t.id]?.parkedFrom,
    archivedAt: now,
    lastActivatedAt: now - idleMs(t, s, now),
  }));
  s.archive = addToArchive(s.archive, entries, settings.archiveCap);
  rt.commit();
  await chrome.tabs.remove(stale.map((t) => t.id)).catch((e) => rt.log("archive close failed", e));
  return stale.length;
}

/** Undo the last sweep within the hour: each tab back to its group and position. */
export async function undoSweep(rt: Runtime): Promise<number> {
  const last = rt.state().lastSweep;
  if (!last || rt.now() - last.at > UNDO_WINDOW_MS) return 0;
  const live = new Map((await chrome.tabs.query({})).map((t) => [t.id!, t]));
  // Parking every tab of a group removes it: undo makes it again, once, with its title and colour.
  const remade = new Map<number, number>();
  const target = async (m: SweepMove): Promise<number | undefined> => {
    if (m.groupId === -1) return undefined;
    const again = remade.get(m.groupId);
    if (again !== undefined) return again;
    return (await groupExists(m.groupId)) ? m.groupId : undefined;
  };
  let restored = 0;
  for (const m of [...last.moves].sort((a, b) => a.index - b.index)) {
    const t = live.get(m.tabId);
    if (!t) continue;
    let groupId = await target(m);
    if (groupId !== undefined) await addToGroup(rt, [m.tabId], groupId);
    else if (m.groupId !== -1 && m.group) {
      const g = m.group;
      groupId = await createManagedGroup(rt, [m.tabId], m.windowId, g.origin, { title: g.stripTitle ?? "", color: g.color }, { ...g });
      if (groupId !== undefined) remade.set(m.groupId, groupId);
    } else {
      rt.state().ownUngroups[m.tabId] = rt.now(); // back to loose is the worker's move, not the user pulling it out
      await ungroup(rt, [m.tabId]);
    }
    await chrome.tabs.move(m.tabId, { windowId: m.windowId, index: m.index }).catch(() => undefined);
    // Moving a tab next to its old neighbours may pull it into a group they share; re-assert.
    groupId = await target(m);
    if (groupId !== undefined) await addToGroup(rt, [m.tabId], groupId);
    else if ((await chrome.tabs.get(m.tabId).catch(() => undefined))?.groupId !== -1) {
      rt.state().ownUngroups[m.tabId] = rt.now();
      await ungroup(rt, [m.tabId]);
    }
    const rec = rt.state().tabs[m.tabId];
    if (rec) {
      rec.parkedFrom = undefined;
      rec.parkedAt = undefined;
      rec.lastActivatedAt = rt.now(); // un-parking is a touch: do not re-park on the next sweep
    }
    restored++;
  }
  rt.state().lastSweep = undefined;
  rt.commit();
  return restored;
}

export async function restoreArchived(rt: Runtime, archivedAt: number, url: string, windowId?: number): Promise<boolean> {
  const s = rt.state();
  const i = s.archive.findIndex((a) => a.archivedAt === archivedAt && a.url === url);
  if (i < 0) return false;
  const [entry] = s.archive.splice(i, 1);
  rt.commit();
  await chrome.tabs.create({ url: entry.url, windowId, active: false });
  return true;
}

export function forgetArchived(rt: Runtime, archivedAt: number, url: string): boolean {
  const s = rt.state();
  const i = s.archive.findIndex((a) => a.archivedAt === archivedAt && a.url === url);
  if (i < 0) return false;
  s.archive.splice(i, 1);
  rt.commit();
  return true;
}

export async function restoreAll(rt: Runtime, windowId: number): Promise<number> {
  const s = rt.state();
  const entries = [...s.archive].reverse(); // oldest first so the strip reads in archive order
  if (!entries.length) return 0;
  s.archive = [];
  rt.commit();
  const ids: number[] = [];
  for (const e of entries) {
    const t = await chrome.tabs.create({ url: e.url, windowId, active: false });
    if (t.id !== undefined) ids.push(t.id);
  }
  if (ids.length) {
    await createManagedGroup(rt, ids, windowId, "organize", { title: stripTitle("Restored", RESTORED_EMOJI, rt.settings().emoji), color: "grey" }, { userNamed: true, restored: true });
  }
  return ids.length;
}
