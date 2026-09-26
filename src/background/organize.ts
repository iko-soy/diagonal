import { COLORS, isColor, type GroupColor } from "../shared/colors";
import { labelOf, repairLabel, safeEmoji, stripTitle, titleKey } from "../shared/label";
import { colorFor, isInternalUrl, promptAddress, provisionalTitle } from "../shared/url";
import { pathKey } from "./engine";
import { membersHash, memberUrls, settled, toItems, type Member, type NameItem } from "./naming";
import { addToGroup, createManagedGroup, groupExists, ungroup, type Runtime } from "./runtime";
import type { HostReply } from "./host";
import { markDirty, type GroupRecord, type HostError, type HostErrorCode, type State, type TabRecord } from "./state";

/** Section 3/9: "Organize all tabs" — cluster ungrouped tabs in batches sized to the model's window. */

export const ORGANIZE_ITEM_CAP = 36;
export const EXISTING_GROUPS_CAP = 12;
// About the host's 7,000-token budget in English characters. Chinese and Japanese cost about twice the tokens
// per character, so their characters count double (weightedLength); the host measures exactly and shortens.
export const CHAR_BUDGET = 24_000;
export const INSTRUCTION_CHARS = 1_400; // ~320 tokens of rules, emoji and colour lists
export const EXISTING_GROUP_CHARS = 90;
export const UNDO_WINDOW_MS = 3_600_000;

export interface ExistingGroup {
  g: number;
  title: string;
  samples?: string[];
}

export interface OrganizePayload {
  items: NameItem[];
  existingGroups: ExistingGroup[];
  /** Every group label in the window: a new group the host names must not repeat one. */
  siblingTitles?: string[];
  allowNew: boolean;
  maxGroups: number;
  minGroupSize: number;
}

export interface ProposedGroup {
  title: string;
  emoji: string;
  color: string;
  existing?: number;
  members: number[];
}

export interface OrganizeResult {
  groups: ProposedGroup[];
  leftovers: number[];
}

export interface Plan {
  joins: { groupId: number; tabIds: number[] }[];
  creates: { tabIds: number[]; label?: string; emoji: string; color: GroupColor }[];
  leftovers: number[];
}

export const maxGroupsFor = (n: number): number => Math.min(8, Math.ceil(n / 3));

export const organizable = (t: { groupId?: number; pinned?: boolean; url?: string; incognito?: boolean }): boolean =>
  (t.groupId ?? -1) === -1 && !t.pinned && !t.incognito && !isInternalUrl(t.url);

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/g;
export const weightedLength = (s: string): number => s.length + (s.match(CJK)?.length ?? 0);

/** Rough rendered size of one item line, the unit the character budget is spent in. */
export const itemChars = (m: Pick<Member, "title" | "url" | "description">): number =>
  weightedLength(m.title.slice(0, 120)) + promptAddress(m.url).length + weightedLength((m.description ?? " ").slice(0, 500)) + 12;

/** Split tabs (in strip order) into batches of ≤ cap items that also fit the character budget. */
export function makeBatches<T extends Pick<Member, "title" | "url" | "description">>(
  tabs: T[],
  cap = ORGANIZE_ITEM_CAP,
  budget = CHAR_BUDGET - INSTRUCTION_CHARS - EXISTING_GROUPS_CAP * EXISTING_GROUP_CHARS,
): T[][] {
  const batches: T[][] = [];
  let cur: T[] = [];
  let chars = 0;
  for (const t of tabs) {
    const c = itemChars(t);
    if (cur.length && (cur.length >= cap || chars + c > budget)) {
      batches.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(t);
    chars += c;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

/**
 * Turn a model reply into concrete moves, re-checking what the host validated: indexes in range
 * and used once, `existing` in range, colours from the fixed set, small new groups folded away.
 */
export function planFromResult(
  result: OrganizeResult,
  batchTabIds: number[],
  existingGroupIds: number[],
  minGroupSize: number,
  maxGroups: number,
  fallbackColor: (tabIds: number[]) => GroupColor,
): Plan {
  const used = new Set<number>();
  const plan: Plan = { joins: [], creates: [], leftovers: [] };
  const take = (members: unknown): number[] => {
    const out: number[] = [];
    if (!Array.isArray(members)) return out;
    for (const i of members) {
      if (Number.isInteger(i) && i >= 0 && i < batchTabIds.length && !used.has(i)) {
        used.add(i);
        out.push(i);
      }
    }
    return out;
  };
  const proposals = Array.isArray(result?.groups) ? result.groups : [];
  const newGroups: { idx: number[]; p: ProposedGroup }[] = [];
  for (const p of proposals) {
    const idx = take(p.members);
    if (!idx.length) continue;
    const ex = typeof p.existing === "number" && p.existing >= 0 && p.existing < existingGroupIds.length ? p.existing : -1;
    if (ex >= 0) {
      const groupId = existingGroupIds[ex];
      const join = plan.joins.find((j) => j.groupId === groupId);
      const tabIds = idx.map((i) => batchTabIds[i]);
      if (join) join.tabIds.push(...tabIds);
      else plan.joins.push({ groupId, tabIds });
    } else {
      newGroups.push({ idx, p });
    }
  }
  newGroups.sort((a, b) => b.idx.length - a.idx.length);
  newGroups.forEach(({ idx, p }, n) => {
    if (idx.length < Math.max(2, minGroupSize) || n >= maxGroups) {
      plan.leftovers.push(...idx.map((i) => batchTabIds[i]));
      return;
    }
    const tabIds = idx.map((i) => batchTabIds[i]);
    plan.creates.push({
      tabIds,
      label: repairLabel(p.title),
      emoji: safeEmoji(p.emoji),
      color: isColor(p.color) ? p.color : fallbackColor(tabIds),
    });
  });
  for (let i = 0; i < batchTabIds.length; i++) if (!used.has(i)) plan.leftovers.push(batchTabIds[i]);
  return plan;
}

export interface OrganizeReport {
  grouped: number;
  groups: number;
  left: number;
  error?: string;
}

/** Existing groups a batch may add tabs to: Diagonal's topic groups in this window, the ones in use first. */
export function existingGroupsFor(state: State, windowId: number, extraIds: number[] = []): { ids: number[]; list: ExistingGroup[] } {
  const members = new Map<number, TabRecord[]>();
  for (const t of Object.values(state.tabs)) if (t.groupId !== -1) members.set(t.groupId, [...(members.get(t.groupId) ?? []), t]);
  const inUse = (g: GroupRecord): number =>
    Math.max(g.dirtyAt ?? 0, g.lastNamedAt ?? 0, ...(members.get(g.id) ?? []).map((t) => t.lastActivatedAt ?? 0));
  const groups = Object.values(state.groups)
    .filter((g) => g.windowId === windowId && g.managed && g.origin !== "tidy" && !g.restored && (g.stripTitle || g.title))
    .map((g) => ({ g, first: extraIds.includes(g.id), at: inUse(g) }))
    .sort((a, b) => Number(b.first) - Number(a.first) || b.at - a.at)
    .slice(0, EXISTING_GROUPS_CAP)
    .map(({ g }) => g);
  const list = groups.map((g, i) => ({
    g: i,
    title: labelOf(g.stripTitle || g.title),
    samples: (members.get(g.id) ?? []).slice(0, 2).map((t) => t.title.slice(0, 60)),
  }));
  return { ids: groups.map((g) => g.id), list };
}

/** Errors about what was sent rather than about the host: a smaller or plainer request may go through. */
const CONTENT_ERRORS = new Set<HostErrorCode>(["OVER_BUDGET", "GUARDRAIL", "BAD_MODEL_OUTPUT"]);
const MAX_TIMEOUT_SPLITS = 1;

/** One organize call, with the retries that can rescue the same tabs: strict output, then no page text. */
async function askOrganize(rt: Runtime, part: Member[], windowId: number, existingGroups: ExistingGroup[], withDescriptions: boolean): Promise<HostReply<OrganizeResult>> {
  const settings = rt.settings();
  const s = rt.state();
  const payload: OrganizePayload = {
    items: toItems(part, settings, withDescriptions),
    existingGroups,
    siblingTitles: Object.values(s.groups)
      .filter((g) => g.windowId === windowId && g.origin !== "tidy")
      .map((g) => labelOf(g.stripTitle || g.title))
      .filter(Boolean)
      .slice(0, 20),
    allowNew: part.length >= 2,
    maxGroups: maxGroupsFor(part.length),
    minGroupSize: settings.organizeMinGroupSize,
  };
  let reply = await rt.host<OrganizeResult>("organize", payload);
  if (!reply.ok && reply.error.code === "BAD_MODEL_OUTPUT") reply = await rt.host<OrganizeResult>("organize", payload, { strict: true });
  if (!reply.ok && reply.error.code === "GUARDRAIL" && payload.items.some((i) => i.description)) {
    // What a page says is the likeliest thing to trip Apple's filter; its title and address rarely do.
    payload.items = toItems(part, settings, false);
    reply = await rt.host<OrganizeResult>("organize", payload);
  }
  return reply;
}

/** One organize run over a window: what it made, what it moved, and whether the host stopped it. */
export interface SortRun {
  windowId: number;
  createdIds: number[];
  previous: Record<number, number>;
  grouped: number;
  left: number;
  timeoutSplits: number;
  /** Auto-organize: remember what was looked at, so the same tabs are not sent again unchanged. */
  stamp: boolean;
  stopped?: HostError;
}

export const newRun = (windowId: number, stamp: boolean): SortRun => ({ windowId, createdIds: [], previous: {}, grouped: 0, left: 0, timeoutSplits: 0, stamp });

/**
 * Sort one part of a window. A reply about the tabs themselves (too long, refused by Apple's filter, not
 * valid output) splits the part in halves, so one page the model won't handle leaves the others sorted; a
 * tab that fails alone is set aside until its page or title changes. Tabs that changed while the model was
 * thinking are left out of its answer.
 */
export async function sortPart(rt: Runtime, part: Member[], run: SortRun, probe = false): Promise<void> {
  if (!part.length || run.stopped) return;
  const { ids: existingIds, list: existingGroups } = existingGroupsFor(rt.state(), run.windowId, run.createdIds);
  if (part.length < 2 && !existingIds.length && !probe) {
    run.left += part.length;
    return; // one tab and nothing to join: no call can place it (a probe still learns whether the model takes it)
  }
  const reply = await askOrganize(rt, part, run.windowId, existingGroups, true);
  if (!reply.ok) {
    const e = reply.error;
    const timedOut = e.code === "TIMEOUT" && part.length > 4 && run.timeoutSplits < MAX_TIMEOUT_SPLITS;
    if (part.length > 1 && (CONTENT_ERRORS.has(e.code) || timedOut)) {
      if (timedOut) run.timeoutSplits++;
      const half = Math.ceil(part.length / 2);
      await sortPart(rt, part.slice(0, half), run, true);
      await sortPart(rt, part.slice(half), run, true);
      return;
    }
    if (CONTENT_ERRORS.has(e.code)) {
      const rec = rt.state().tabs[part[0].id];
      if (rec) rec.organizeRefused = organizedKeyOf(part[0]);
      rt.log("organize: set aside a tab the model would not sort", e.code);
      run.left += 1;
      return;
    }
    run.stopped = e;
    return;
  }
  const settings = rt.settings();
  const plan = planFromResult(reply.result, part.map((m) => m.id), existingIds, settings.organizeMinGroupSize, maxGroupsFor(part.length), (ids) =>
    colorFor(part.find((m) => m.id === ids[0])?.url ?? ""),
  );
  const unchanged = await stillAsSent(rt, part, run.windowId);
  const trimmed = trimPlan(rt.state(), plan, unchanged, settings.organizeMinGroupSize);
  const failed = await applyPlan(rt, trimmed, run.windowId, part, run.previous, run.createdIds);
  const placed = [...trimmed.joins, ...trimmed.creates].reduce((n, x) => n + x.tabIds.filter((id) => !failed.has(id)).length, 0);
  run.grouped += placed;
  run.left += part.length - placed;
  if (run.stamp) {
    const s = rt.state();
    for (const m of part) {
      const rec = s.tabs[m.id];
      if (rec && unchanged.has(m.id) && !failed.has(m.id)) rec.organizedKey = organizedKeyOf(m);
    }
  }
}

/** The tabs of a part that are still loose, in this window, on the page and title the model saw. */
async function stillAsSent(rt: Runtime, part: Member[], windowId: number): Promise<Set<number>> {
  const live = new Map((await chrome.tabs.query({ windowId }).catch(() => [])).map((t) => [t.id!, t]));
  const s = rt.state();
  return new Set(
    part
      .filter((m) => {
        const t = live.get(m.id);
        return !!t && organizable(t) && !s.tabs[m.id]?.keepLoose && organizedKeyOf(t) === organizedKeyOf(m);
      })
      .map((m) => m.id),
  );
}

/** A plan with the tabs that moved on taken out: a new group left too small is not made, a join into a group gone is dropped. */
export function trimPlan(state: State, plan: Plan, keep: Set<number>, minGroupSize: number): Plan {
  const out: Plan = { joins: [], creates: [], leftovers: plan.leftovers.filter((id) => keep.has(id)) };
  for (const j of plan.joins) {
    const tabIds = j.tabIds.filter((id) => keep.has(id));
    const g = state.groups[j.groupId];
    if (tabIds.length && g?.managed && !g.restored) out.joins.push({ ...j, tabIds });
    else out.leftovers.push(...tabIds);
  }
  for (const c of plan.creates) {
    const tabIds = c.tabIds.filter((id) => keep.has(id));
    if (tabIds.length >= Math.max(2, minGroupSize)) out.creates.push({ ...c, tabIds });
    else out.leftovers.push(...tabIds);
  }
  return out;
}

export async function organizeWindow(rt: Runtime, windowId: number): Promise<OrganizeReport> {
  const s0 = rt.state();
  const tabs = (await chrome.tabs.query({ windowId })).filter((t) => organizable(t)).sort((a, b) => a.index - b.index);
  const report: OrganizeReport = { grouped: 0, groups: 0, left: 0 };
  // A tab the model already would not sort, on the same page, is not sent again.
  const sendable = tabs.filter((t) => s0.tabs[t.id!]?.organizeRefused !== organizedKeyOf(t));
  if (sendable.length < 2) {
    report.left = tabs.length;
    return report;
  }
  const run = newRun(windowId, false);
  rt.state().inFlight = { groupId: -1, startedAt: rt.now() };
  rt.refreshBadge();
  try {
    for (const batch of makeBatches(sendable.map((t) => toMember(rt.state(), t)))) {
      await sortPart(rt, batch, run);
      if (run.stopped) break;
    }
  } finally {
    const s = rt.state();
    if (s.inFlight?.groupId === -1) s.inFlight = undefined;
    report.grouped = run.grouped;
    report.groups = run.createdIds.length;
    report.left = tabs.length - run.grouped;
    if (run.stopped) report.error = `${run.stopped.code}: ${run.stopped.message}`;
    if (Object.keys(run.previous).length) s.lastOrganize = { at: rt.now(), previous: run.previous };
    rt.commit();
    rt.refreshBadge();
  }
  return report;
}

const toMember = (s: State, t: chrome.tabs.Tab): Member => ({
  id: t.id!,
  index: t.index,
  url: t.url ?? "",
  title: t.title ?? "",
  status: t.status,
  description: s.tabs[t.id!]?.description,
  lastActive: t.lastAccessed ?? 0,
});

/** Carry out a plan; returns the tabs whose move failed, which stay as they were. */
export async function applyPlan(
  rt: Runtime,
  plan: Plan,
  windowId: number,
  members: Member[],
  previous: Record<number, number>,
  createdIds: number[],
): Promise<Set<number>> {
  const settings = rt.settings();
  const byId = new Map(members.map((m) => [m.id, m]));
  const failed = new Set<number>();
  for (const j of plan.joins) {
    if (!(await addToGroup(rt, j.tabIds, j.groupId))) {
      for (const id of j.tabIds) failed.add(id);
      continue;
    }
    for (const id of j.tabIds) previous[id] = -1;
    const g = rt.state().groups[j.groupId];
    if (g) {
      markDirty(g, rt.now());
      rt.naming.touch(g.id);
    }
  }
  for (const c of plan.creates) {
    const ms = c.tabIds.map((id) => byId.get(id)!).filter(Boolean);
    const named = !!c.label;
    const title = named ? stripTitle(c.label!, c.emoji, settings.emoji) : provisionalTitle(ms[0]?.url ?? "");
    const groupId = await createManagedGroup(rt, c.tabIds, windowId, "organize", { title, color: c.color }, {
      userNamed: false,
      title: c.label,
      emoji: named ? c.emoji : undefined,
      membersHash: named ? membersHash(ms) : "",
      memberUrls: named ? memberUrls(ms) : undefined,
      lastNamedAt: named ? rt.now() : undefined,
      dirty: false,
    });
    if (groupId === undefined) {
      for (const id of c.tabIds) failed.add(id);
      continue;
    }
    createdIds.push(groupId);
    for (const id of c.tabIds) previous[id] = -1;
    const g = rt.state().groups[groupId];
    if (g && !named) {
      markDirty(g, rt.now());
      rt.naming.touch(groupId);
    }
  }
  return failed;
}

/** Undo within the hour: every tab goes back to the group it was in (organize only takes loose tabs). */
export async function undoOrganize(rt: Runtime): Promise<number> {
  const last = rt.state().lastOrganize;
  if (!last || rt.now() - last.at > UNDO_WINDOW_MS) return 0;
  const live = new Map((await chrome.tabs.query({})).map((t) => [t.id!, t]));
  let restored = 0;
  const toUngroup: number[] = [];
  for (const [idStr, prevGroup] of Object.entries(last.previous)) {
    const id = Number(idStr);
    const t = live.get(id);
    if (!t) continue;
    if (prevGroup === -1) {
      if (t.groupId !== -1) toUngroup.push(id);
    } else if (t.groupId !== prevGroup && (await groupExists(prevGroup))) {
      await addToGroup(rt, [id], prevGroup);
    }
    restored++;
  }
  await ungroup(rt, toUngroup);
  rt.state().lastOrganize = undefined;
  rt.commit();
  return restored;
}

/** What auto-organize remembers about a tab: it looks again only when the page or title changes. */
export const organizedKeyOf = (t: { url?: string; title?: string }): string => `${pathKey(t.url)}\n${titleKey(t.title)}`;

export const AUTO_RETRY_MS = 300_000;
export const AUTO_CONTINUE_MS = 1_500;

export interface AutoDeps {
  /** Wake the worker later even if it is suspended before the debounce timer fires. */
  scheduleFallback(when: number): void;
}

/**
 * Section 3 without the button: loose tabs are organized on their own once a window has been
 * quiet for `autoOrganizeDelayMs`. Each run sends one batch, new or changed tabs first, together
 * with the window's other loose tabs and Diagonal's groups, so a new tab can join an existing group
 * or pair up with a tab that was left over earlier. A tab the model leaves loose is not sent again
 * until its page or title changes or another tab arrives to pair it with.
 */
export class AutoOrganizer {
  private timers = new Map<number, ReturnType<typeof setTimeout>>();
  private running = false;
  private queued = new Set<number>();

  constructor(
    private rt: Runtime,
    private deps: AutoDeps,
  ) {}

  touch(windowId: number, delayMs = this.rt.settings().autoOrganizeDelayMs): void {
    if (!this.rt.settings().autoOrganize) return;
    const old = this.timers.get(windowId);
    if (old) clearTimeout(old);
    this.timers.set(
      windowId,
      setTimeout(() => {
        this.timers.delete(windowId);
        void this.run(windowId);
      }, delayMs),
    );
    this.deps.scheduleFallback(this.rt.now() + delayMs + 60_000);
  }

  /** Every window, now: on boot, when the host recovers, and from the fallback alarm. */
  async sweep(): Promise<void> {
    if (!this.rt.settings().autoOrganize) return;
    const windows = await chrome.windows.getAll({ windowTypes: ["normal"] }).catch(() => []);
    for (const w of windows) if (w.id !== undefined && !w.incognito) await this.run(w.id);
  }

  async run(windowId: number): Promise<void> {
    if (this.running) {
      this.queued.add(windowId);
      return;
    }
    this.running = true;
    try {
      await this.once(windowId);
    } catch (e) {
      this.rt.log("auto-organize failed", e);
    } finally {
      this.running = false;
      const next = this.queued.values().next();
      if (!next.done) {
        this.queued.delete(next.value);
        void this.run(next.value);
      }
    }
  }

  private async once(windowId: number): Promise<void> {
    const rt = this.rt;
    const settings = rt.settings();
    if (!settings.autoOrganize) return;
    const pausedUntil = rt.state().host.pausedUntil;
    if (pausedUntil && pausedUntil > rt.now()) return; // the host-retry ping sweeps again when it recovers
    const tabs = (await chrome.tabs.query({ windowId }).catch(() => [])).sort((a, b) => a.index - b.index);
    const s = rt.state();
    // Still-loading tabs are skipped here; finishing the load touches the window again. Discarded tabs keep
    // their title and address, so they're sorted like loaded ones.
    const loose = tabs.filter((t) => {
      const rec = s.tabs[t.id!];
      return organizable(t) && settled(t) && !rec?.keepLoose && rec?.organizeRefused !== organizedKeyOf(t);
    });
    const fresh = loose.filter((t) => s.tabs[t.id!]?.organizedKey !== organizedKeyOf(t));
    if (!fresh.length) return;
    if (loose.length < 2 && !existingGroupsFor(s, windowId).ids.length) return; // one loose tab and nothing to join: wait for company
    const ordered = [...fresh, ...loose.filter((t) => !fresh.includes(t))].map((t) => toMember(s, t));
    const batch = makeBatches(ordered)[0];
    const run = newRun(windowId, true);
    await sortPart(rt, batch, run);
    rt.commit();
    if (run.stopped) {
      rt.log("auto-organize", run.stopped.code);
      this.deps.scheduleFallback(rt.now() + AUTO_RETRY_MS);
      return;
    }
    const sent = new Set(batch.map((m) => m.id));
    if (fresh.some((t) => !sent.has(t.id!))) this.touch(windowId, AUTO_CONTINUE_MS);
  }
}

export { COLORS };
