import { PARKED_EMOJI, RESTORED_EMOJI } from "../shared/emoji";
import { labelOf, stripTitle } from "../shared/label";
import { isInternalUrl } from "../shared/url";
import { addToGroup, createManagedGroup, groupExists, ungroup, updateGroup, type Runtime } from "./runtime";
import type { Settings } from "./settings";
import type { ArchivedTab, State, SweepMove } from "./state";

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
  lastAccessed?: number;
}

export const idleMs = (tab: TidyTab, state: State, now: number): number =>
  now - Math.max(tab.lastAccessed ?? 0, state.tabs[tab.id]?.lastActivatedAt ?? 0);

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
    if ((!g || g.origin === "user") && !settings.tidyUserGroups) return false;
  }
  if (excluded(tab.url, settings.tidyExclusions)) return false;
  return idleMs(tab, state, now) >= settings.parkAfterHours * HOUR;
}

export function parkCandidates(tabs: TidyTab[], state: State, settings: Settings, now: number): TidyTab[] {
  const parking = parkingGroupIds(state);
  return tabs.filter((t) => isParkCandidate(t, state, settings, now, parking));
}

export function archiveCandidates(tabs: TidyTab[], state: State, settings: Settings, now: number): TidyTab[] {
  if (!settings.archiveAfterHours) return [];
  const parking = parkingGroupIds(state);
  return tabs.filter((t) => parking.has(t.groupId) && !t.active && !t.audible && idleMs(t, state, now) >= settings.archiveAfterHours * HOUR);
}

/** Prepend entries newest first and drop the oldest past the cap. */
export function addToArchive(archive: ArchivedTab[], entries: ArchivedTab[], cap: number): ArchivedTab[] {
  return [...entries.sort((a, b) => b.archivedAt - a.archivedAt), ...archive].slice(0, cap);
}

export const parkedTitle = (settings: Settings): string => stripTitle("Parked", PARKED_EMOJI, settings.emoji);

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
    lastAccessed: t.lastAccessed,
  }));

export interface SweepReport {
  candidates: number;
  parked: number;
  archived: number;
}

/**
 * The 30-minute sweep (manual = "Tidy now" / "Park N tabs": ignores the threshold and the Ask
 * consent, still respects eligibility).
 */
export async function runSweep(rt: Runtime, manual = false): Promise<SweepReport> {
  const settings = rt.settings();
  const report: SweepReport = { candidates: 0, parked: 0, archived: 0 };
  if (settings.tidyMode === "off" && !manual) {
    rt.state().tidyCandidates = 0;
    rt.refreshBadge();
    return report;
  }
  const now = rt.now();
  let tabs = await liveTabs();
  const candidates = parkCandidates(tabs, rt.state(), settings, now);
  report.candidates = candidates.length;
  const park = manual || (settings.tidyMode === "auto" && candidates.length >= settings.tidyThreshold);
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

async function parkTabs(rt: Runtime, candidates: TidyTab[]): Promise<number> {
  const settings = rt.settings();
  const moves: SweepMove[] = [];
  const byWindow = new Map<number, TidyTab[]>();
  for (const t of candidates) byWindow.set(t.windowId, [...(byWindow.get(t.windowId) ?? []), t]);
  for (const [windowId, tabs] of byWindow) {
    const ids = tabs.map((t) => t.id);
    const s = rt.state();
    for (const t of tabs) {
      moves.push({ tabId: t.id, groupId: t.groupId, index: t.index, windowId });
      const rec = s.tabs[t.id];
      const from = t.groupId !== -1 ? s.groups[t.groupId] : undefined;
      if (rec) rec.parkedFrom = from ? labelOf(from.stripTitle || from.title) || undefined : undefined;
    }
    let parking = Object.values(s.groups).find((g) => g.origin === "tidy" && g.windowId === windowId)?.id;
    if (parking !== undefined && !(await groupExists(parking))) parking = undefined;
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
      for (const t of tabs) {
        if (!t.discarded) await chrome.tabs.discard(t.id).catch(() => undefined);
      }
    }
  }
  rt.state().lastSweep = { at: rt.now(), moves };
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
  let restored = 0;
  for (const m of [...last.moves].sort((a, b) => a.index - b.index)) {
    const t = live.get(m.tabId);
    if (!t) continue;
    if (m.groupId !== -1 && (await groupExists(m.groupId))) await addToGroup(rt, [m.tabId], m.groupId);
    else await ungroup(rt, [m.tabId]);
    await chrome.tabs.move(m.tabId, { windowId: m.windowId, index: m.index }).catch(() => undefined);
    // Moving a tab next to its old neighbours may pull it into a group they share; re-assert.
    if (m.groupId !== -1 && (await groupExists(m.groupId))) await addToGroup(rt, [m.tabId], m.groupId);
    const rec = rt.state().tabs[m.tabId];
    if (rec) {
      rec.parkedFrom = undefined;
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
    await createManagedGroup(rt, ids, windowId, "organize", { title: stripTitle("Restored", RESTORED_EMOJI, rt.settings().emoji), color: "grey" }, { userNamed: true });
  }
  return ids.length;
}
