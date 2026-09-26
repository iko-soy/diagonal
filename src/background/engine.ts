import type { GroupColor } from "../shared/colors";
import { isColor } from "../shared/colors";
import { colorFor, isInternalUrl, parse, provisionalTitle, trimText } from "../shared/url";
import type { Settings } from "./settings";
import { markDirty, newGroupRecord, type GroupOrigin, type GroupRecord, type RemovedGroup, type State, type TabRecord } from "./state";

/**
 * Section 5: the structural rules as a pure function `(State, Event) → (State, Action[])`.
 * The worker feeds it browser events and executes the actions; nothing here touches `chrome`.
 */

export interface TabSnapshot {
  id: number;
  windowId: number;
  groupId: number;
  index: number;
  url?: string;
  pendingUrl?: string;
  title?: string;
  pinned: boolean;
  openerTabId?: number;
  incognito?: boolean;
  status?: string;
  lastAccessed?: number;
}

export interface GroupSnapshot {
  id: number;
  windowId: number;
  title?: string;
  color: string;
  collapsed?: boolean;
}

export type EngineEvent =
  | { type: "tabCreated"; tab: TabSnapshot; opener?: TabSnapshot }
  | { type: "tabUpdated"; tab: TabSnapshot }
  | { type: "tabRemoved"; tabId: number }
  | { type: "tabActivated"; tabId: number }
  | { type: "groupCreated"; group: GroupSnapshot }
  | { type: "groupUpdated"; group: GroupSnapshot }
  | { type: "groupRemoved"; groupId: number }
  | { type: "meta"; tabId: number; description: string }
  | { type: "dissolveCheck"; groupId: number; memberIds: number[] };

export type Action =
  | { type: "createGroup"; tabIds: number[]; windowId: number; title: string; color: GroupColor; origin: GroupOrigin }
  | { type: "addToGroup"; tabIds: number[]; groupId: number }
  | { type: "ungroup"; tabIds: number[] }
  | { type: "scheduleDissolve"; groupId: number; delayMs: number }
  | { type: "dirty"; groupId: number }
  | { type: "loose"; windowId: number }
  | { type: "unpark"; tabId: number; groupId: number }
  | { type: "checkFit" };

export interface Ctx {
  now: number;
  settings: Settings;
}

export const DISSOLVE_DELAY_MS = 1500;
export const OWN_CREATE_WINDOW_MS = 2000;
export const OWN_WRITE_WINDOW_MS = 60_000;
/** A group moved to another window is removed and recreated with the same id within milliseconds. */
export const REVIVE_WINDOW_MS = 10_000;
export const REMOVED_KEEP_MS = 24 * 3_600_000;
export const REMOVED_CAP = 20;

/** The pure form: never touches `prev`. */
export function step(prev: State, event: EngineEvent, ctx: Ctx): { state: State; actions: Action[] } {
  const state: State = structuredClone(prev);
  return { state, actions: applyEvent(state, event, ctx) };
}

/**
 * The same rules applied to the worker's live state object in place, so code that is awaiting
 * a model call and holds that object never works on a replaced copy.
 */
export function applyEvent(state: State, event: EngineEvent, ctx: Ctx): Action[] {
  const actions: Action[] = [];
  prune(state, ctx.now);
  handlers[event.type](state, event as never, ctx, actions);
  return actions;
}

type Handler<E> = (s: State, e: E, ctx: Ctx, out: Action[]) => void;
type Handlers = { [K in EngineEvent["type"]]: Handler<Extract<EngineEvent, { type: K }>> };

const handlers: Handlers = {
  tabCreated(s, { tab, opener }, ctx, out) {
    if (tab.incognito) return;
    const known = !!s.tabs[tab.id];
    const rec = upsertTab(s, tab, ctx.now);
    if (rec.groupId !== -1) {
      // Born inside a group with no page that led to it ("New tab in group"): the user put it there.
      // A link opened from a grouped tab has an opener and stays Diagonal's to check.
      const g = s.groups[rec.groupId];
      const newPage = tab.openerTabId === undefined || isInternalUrl(tab.pendingUrl || tab.url);
      if (!known && newPage && g && !revivedLately(g, ctx.now)) rec.handPlaced = true;
      dirty(s, rec.groupId, ctx, out);
    }
    const before = out.length;
    openerRule(s, tab, opener ?? snapshotOf(s, tab.openerTabId), ctx, out);
    if (out.length === before) loose(rec, ctx, out);
  },

  tabUpdated(s, { tab }, ctx, out) {
    if (tab.incognito) return;
    const before = s.tabs[tab.id];
    const rec = upsertTab(s, tab, ctx.now);
    if (!before) {
      if (rec.groupId !== -1) dirty(s, rec.groupId, ctx, out);
      else loose(rec, ctx, out);
      return;
    }
    const titleChanged = before.title !== rec.title;
    const pathChanged = pathKey(before.url) !== pathKey(rec.url);
    if (pathChanged) rec.keepLoose = undefined; // a new page is fair game again
    if (before.groupId !== rec.groupId) {
      left(s, before.groupId, ctx, out);
      if (inTransit(s, before.groupId, rec.groupId, ctx.now)) {
        // Chromium moves a group to another window by removing it, ungrouping its tabs and grouping
        // them again under the same id: nobody chose anything, so the tab keeps what it had.
        delete s.ownAdds[rec.id];
        if (rec.groupId !== -1) dirty(s, rec.groupId, ctx, out);
        else loose(rec, ctx, out);
        return;
      }
      rec.fitPending = undefined;
      if (s.groups[before.groupId]?.origin === "tidy") rec.parkedAt = undefined; // out of Parked
      if (rec.groupId !== -1) {
        rec.keepLoose = undefined; // in a group now: there is no loose choice left to protect
        // Into a group: ours if the worker put it there, otherwise the user did and it stays.
        if (s.ownAdds[rec.id] !== undefined) {
          delete s.ownAdds[rec.id];
          rec.handPlaced = undefined;
        } else {
          rec.handPlaced = true;
        }
      } else {
        rec.handPlaced = undefined;
      }
      if (rec.groupId !== -1) dirty(s, rec.groupId, ctx, out);
      else if (before.groupId !== -1) {
        // Out of a group: ours if the worker dissolved it, otherwise the user's choice to keep it loose.
        if (s.ownUngroups[rec.id] !== undefined) {
          delete s.ownUngroups[rec.id];
          loose(rec, ctx, out);
        } else {
          rec.keepLoose = pathKey(rec.url);
        }
      }
      return;
    }
    if (rec.groupId === -1) {
      const loaded = before.status !== "complete" && rec.status === "complete";
      if (titleChanged || pathChanged || loaded || before.pinned !== rec.pinned) loose(rec, ctx, out);
      return;
    }
    // Only a tab that had finished a page moves on: a new tab's first load redirecting (http to https,
    // a link shortener) is still its first page.
    if (pathChanged && before.status === "complete" && fitCheckable(s, rec, ctx.settings)) rec.fitPending = true;
    if (rec.fitPending && rec.status === "complete") out.push({ type: "checkFit" });
    if (titleChanged || pathChanged) dirty(s, rec.groupId, ctx, out);
    else if (before.status !== "complete" && rec.status === "complete" && s.groups[rec.groupId]?.dirty) {
      // A member finished loading: the naming loop may have been waiting for it.
      out.push({ type: "dirty", groupId: rec.groupId });
    }
  },

  tabRemoved(s, { tabId }, ctx, out) {
    const rec = s.tabs[tabId];
    if (!rec) return;
    delete s.tabs[tabId];
    left(s, rec.groupId, ctx, out);
  },

  tabActivated(s, { tabId }, ctx, out) {
    const rec = s.tabs[tabId];
    if (!rec) return;
    rec.lastActivatedAt = ctx.now;
    // A tab waiting for its fit check is checked once the user has moved on from it.
    if (Object.values(s.tabs).some((t) => t.fitPending && t.id !== tabId)) out.push({ type: "checkFit" });
    // Using a parked tab means it is not stale: it leaves Parked and auto-organize places it.
    if (rec.groupId !== -1 && s.groups[rec.groupId]?.origin === "tidy") {
      rec.parkedFrom = undefined;
      rec.parkedAt = undefined;
      out.push({ type: "unpark", tabId, groupId: rec.groupId });
    }
  },

  groupCreated(s, { group }, ctx, out) {
    registerGroup(s, group, ctx, out);
  },

  groupUpdated(s, { group }, ctx, out) {
    const rec = s.groups[group.id];
    if (!rec) {
      registerGroup(s, group, ctx, out);
      return;
    }
    // A group Chromium restores (a reopened window, the session after a restart) is created untitled
    // and gets its title a moment later: that title and colour can say it is one of Diagonal's back.
    if (rec.registeredAt !== undefined && ctx.now - rec.registeredAt <= REVIVE_WINDOW_MS) {
      const back = buried(s, group.title ?? "", group.color);
      if (back) {
        revive(s, back, group, ctx);
        return;
      }
    }
    rec.windowId = group.windowId;
    const own = s.ownWrites[group.id];
    const title = group.title ?? "";
    if (title !== (rec.stripTitle ?? "")) {
      if (own && own.title === title) {
        rec.stripTitle = title;
      } else if (title === "") {
        // Clearing the title hands naming back to the extension.
        rec.stripTitle = "";
        rec.userNamed = false;
        rec.title = undefined;
        rec.emoji = undefined;
        rec.membersHash = "";
        if (rec.origin === "user" && !ctx.settings.nameUserGroups) rec.managed = false;
        dirty(s, rec.id, ctx, out);
      } else {
        rec.stripTitle = title;
        rec.userNamed = true;
        rec.dirty = false;
      }
    }
    if (isColor(group.color) && group.color !== rec.color) {
      if (!(own && own.color === group.color)) rec.colorLocked = true;
      rec.color = group.color;
    }
  },

  groupRemoved(s, { groupId }, ctx) {
    const rec = s.groups[groupId];
    delete s.groups[groupId];
    delete s.ownWrites[groupId];
    if (rec) bury(s, rec, ctx.now);
  },

  meta(s, { tabId, description }, ctx, out) {
    const rec = s.tabs[tabId];
    if (!rec) return;
    const d = trimText(description, 500) || undefined;
    if (d === rec.description) return;
    rec.description = d;
    if (rec.groupId !== -1) dirty(s, rec.groupId, ctx, out);
  },

  dissolveCheck(s, { groupId, memberIds }, ctx, out) {
    const g = s.groups[groupId];
    if (!g || !shouldDissolve(g, ctx.settings)) return;
    if (memberIds.length === 1) out.push({ type: "ungroup", tabIds: memberIds });
  },
};

function openerRule(s: State, child: TabSnapshot, opener: TabSnapshot | undefined, ctx: Ctx, out: Action[]): void {
  if (!ctx.settings.openerGrouping || child.openerTabId === undefined || !opener) return;
  const url = child.pendingUrl || child.url;
  if (child.pinned || isInternalUrl(url)) return; // 1. blank, internal or pinned child
  if (opener.pinned || opener.incognito || isInternalUrl(opener.url)) return; // 2. pinned opener spawns a plain tab
  if (opener.windowId !== child.windowId) return;
  if (opener.groupId !== -1) {
    // 3. Chromium normally places the child in the opener's group already. If a burst of
    // Cmd-clicks raced the group's creation, the child is still loose: put it in explicitly.
    if (child.groupId === -1 && s.groups[opener.groupId]?.managed) {
      out.push({ type: "addToGroup", tabIds: [child.id], groupId: opener.groupId });
    }
    return;
  }
  if (child.groupId !== -1) return;
  // 4–5. New opener group with the opener's hostname as a placeholder title.
  const openerUrl = opener.url || opener.pendingUrl || "";
  out.push({
    type: "createGroup",
    tabIds: [opener.id, child.id],
    windowId: opener.windowId,
    title: provisionalTitle(openerUrl),
    color: colorFor(openerUrl),
    origin: "opener",
  });
}

/** Groups Diagonal made (opener or topic) go away when one tab is left; the Parked group and yours stay. */
export const shouldDissolve = (g: GroupRecord, settings: Settings): boolean =>
  g.managed && (g.origin === "opener" || g.origin === "organize") && !g.userNamed && settings.dissolveSingletons;

/** Only groups Diagonal made and still names itself, and only tabs it put there, are checked for fit. */
export function fitCheckable(s: State, rec: TabRecord, settings: Settings): boolean {
  const g = s.groups[rec.groupId];
  return (
    settings.autoOrganize &&
    !!g &&
    g.managed &&
    (g.origin === "opener" || g.origin === "organize") &&
    !g.userNamed &&
    !rec.handPlaced &&
    !rec.pinned &&
    !isInternalUrl(rec.url)
  );
}

/** An ungrouped tab changed: auto-organize should look at its window once things settle. */
function loose(rec: TabRecord, ctx: Ctx, out: Action[]): void {
  if (!ctx.settings.autoOrganize || rec.groupId !== -1 || rec.pinned || rec.keepLoose || isInternalUrl(rec.url)) return;
  out.push({ type: "loose", windowId: rec.windowId });
}

/** A tab left `groupId`: the group changed, and an opener group may now be a singleton. */
function left(s: State, groupId: number, ctx: Ctx, out: Action[]): void {
  if (groupId === -1) return;
  const g = s.groups[groupId];
  if (!g) return;
  dirty(s, groupId, ctx, out);
  if (shouldDissolve(g, ctx.settings)) out.push({ type: "scheduleDissolve", groupId, delayMs: DISSOLVE_DELAY_MS });
}

function dirty(s: State, groupId: number, ctx: Ctx, out: Action[]): void {
  const g = s.groups[groupId];
  if (!g) return;
  markDirty(g, ctx.now);
  out.push({ type: "dirty", groupId });
}

function registerGroup(s: State, group: GroupSnapshot, ctx: Ctx, out: Action[]): void {
  const existing = s.groups[group.id];
  const color: GroupColor = isColor(group.color) ? group.color : "grey";
  if (existing) {
    // The worker registered it already (it created the group): drop its pending marker.
    existing.windowId = group.windowId;
    const j = s.pendingCreates.findIndex((p) => p.windowId === group.windowId && p.origin === existing.origin);
    if (j >= 0) s.pendingCreates.splice(j, 1);
    return;
  }
  const i = s.pendingCreates.findIndex((p) => p.windowId === group.windowId && ctx.now - p.at <= OWN_CREATE_WINDOW_MS);
  if (i >= 0) {
    const [pending] = s.pendingCreates.splice(i, 1);
    s.groups[group.id] = newGroupRecord(group.id, group.windowId, pending.origin, color, { stripTitle: group.title ?? "" });
    return;
  }
  // Moved to another window (same id, just removed) or reopened (same title and colour): the same group.
  const moved = s.removedGroups[group.id];
  const back = moved && ctx.now - moved.removedAt <= REVIVE_WINDOW_MS ? moved : buried(s, group.title ?? "", group.color);
  if (back) {
    revive(s, back, group, ctx);
    return;
  }
  const titled = !!group.title;
  const rec = newGroupRecord(group.id, group.windowId, "user", color, {
    managed: ctx.settings.nameUserGroups,
    userNamed: titled,
    stripTitle: group.title ?? "",
    registeredAt: ctx.now,
  });
  s.groups[group.id] = rec;
  if (rec.managed && !titled) dirty(s, group.id, ctx, out);
}

/** Keep a removed group's record for a while, so the group is still Diagonal's if Chromium brings it back. */
export function bury(s: State, rec: GroupRecord, now: number): void {
  s.removedGroups[rec.id] = { ...rec, removedAt: now };
  pruneRemoved(s, now);
}

/** The most recently removed group with this title and colour, if any. */
function buried(s: State, title: string, color: string): RemovedGroup | undefined {
  if (!title) return undefined;
  let best: RemovedGroup | undefined;
  for (const g of Object.values(s.removedGroups)) {
    if ((g.stripTitle ?? "") === title && g.color === color && (!best || g.removedAt > best.removedAt)) best = g;
  }
  return best;
}

function revive(s: State, back: RemovedGroup, group: GroupSnapshot, ctx: Ctx): void {
  const { removedAt: _, registeredAt: __, ...rec } = back;
  delete s.removedGroups[back.id];
  delete s.groups[group.id];
  s.groups[group.id] = {
    ...rec,
    id: group.id,
    windowId: group.windowId,
    color: isColor(group.color) ? group.color : rec.color,
    // An untitled restore gets its title next: keep the known one so that update is not read as an edit.
    stripTitle: group.title || rec.stripTitle,
    revivedAt: ctx.now,
  };
}

const revivedLately = (g: GroupRecord | undefined, now: number): boolean => !!g?.revivedAt && now - g.revivedAt <= REVIVE_WINDOW_MS;

/** Leaving a group Chromium just removed, or joining one it is bringing back: a move, not a choice. */
function inTransit(s: State, from: number, to: number, now: number): boolean {
  const gone = (id: number) => !s.groups[id] && !!s.removedGroups[id];
  if (to === -1) return from !== -1 && gone(from);
  return from === -1 && (gone(to) || revivedLately(s.groups[to], now));
}

function upsertTab(s: State, tab: TabSnapshot, now: number): TabRecord {
  const before = s.tabs[tab.id];
  const url = tab.url || tab.pendingUrl || "";
  const rec: TabRecord = {
    id: tab.id,
    windowId: tab.windowId,
    groupId: tab.groupId ?? -1,
    index: tab.index,
    url,
    title: tab.title ?? before?.title ?? "",
    pinned: tab.pinned,
    status: tab.status,
    createdAt: before?.createdAt ?? now,
    lastActivatedAt: before?.lastActivatedAt ?? tab.lastAccessed ?? now,
  };
  if (tab.openerTabId !== undefined) rec.openerTabId = tab.openerTabId;
  else if (before?.openerTabId !== undefined) rec.openerTabId = before.openerTabId;
  // A description belongs to a page: keep it only while the tab stays on that page.
  if (before?.description && pathKey(before.url) === pathKey(url)) rec.description = before.description;
  if (before?.keepLoose) rec.keepLoose = before.keepLoose;
  if (before?.parkedFrom) rec.parkedFrom = before.parkedFrom;
  if (before?.parkedAt) rec.parkedAt = before.parkedAt;
  if (before?.organizedKey) rec.organizedKey = before.organizedKey;
  if (before?.handPlaced) rec.handPlaced = true;
  if (before?.fitPending) rec.fitPending = true;
  s.tabs[tab.id] = rec;
  return rec;
}

function snapshotOf(s: State, tabId: number | undefined): TabSnapshot | undefined {
  if (tabId === undefined) return undefined;
  const r = s.tabs[tabId];
  return r && { id: r.id, windowId: r.windowId, groupId: r.groupId, index: r.index, url: r.url, title: r.title, pinned: r.pinned };
}

/** Origin + path: a change here is a different page; query, fragment and reload are not. */
export function pathKey(url: string | undefined): string {
  const u = url ? parse(url) : undefined;
  if (!u) return url ?? "";
  const v = u.searchParams.get("v");
  return u.origin + u.pathname + (v ? `?v=${v}` : "");
}

function prune(s: State, now: number): void {
  s.pendingCreates = s.pendingCreates.filter((p) => now - p.at <= OWN_CREATE_WINDOW_MS);
  for (const [id, w] of Object.entries(s.ownWrites)) if (now - w.at > OWN_WRITE_WINDOW_MS) delete s.ownWrites[+id];
  for (const [id, at] of Object.entries(s.ownUngroups)) if (now - at > OWN_WRITE_WINDOW_MS) delete s.ownUngroups[+id];
  for (const [id, at] of Object.entries(s.ownAdds)) if (now - at > OWN_WRITE_WINDOW_MS) delete s.ownAdds[+id];
  pruneRemoved(s, now);
}

function pruneRemoved(s: State, now: number): void {
  const removed = Object.values(s.removedGroups).sort((a, b) => b.removedAt - a.removedAt);
  removed.forEach((g, i) => {
    if (i >= REMOVED_CAP || now - g.removedAt > REMOVED_KEEP_MS) delete s.removedGroups[g.id];
  });
}
