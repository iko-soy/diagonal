import type { GroupColor } from "../shared/colors";
import type { HostOpts, HostReply, Op } from "./host";
import type { Naming } from "./naming";
import type { Settings } from "./settings";
import { newGroupRecord, type GroupOrigin, type GroupRecord, type State } from "./state";

/** What the feature modules need from the worker: the live state, settings and a host handle. */
export interface Runtime {
  state(): State;
  settings(): Settings;
  commit(): void;
  now(): number;
  host<T>(op: Op, payload: object, opts?: Partial<HostOpts>): Promise<HostReply<T>>;
  naming: Naming;
  refreshBadge(): void;
  log(...args: unknown[]): void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Chromium refuses group edits mid-drag ("Tabs cannot be edited right now"): retry 5× at 500 ms. */
export async function withEditRetry<T>(fn: () => Promise<T>, tries = 5): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt >= tries || !/cannot be edited|dragging|user may be/i.test(msg)) throw e;
      await sleep(500);
    }
  }
}

/** Write a group's title/colour and remember it as our own write, so onUpdated does not read it as a user edit. */
export async function updateGroup(
  rt: Runtime,
  groupId: number,
  props: { title?: string; color?: GroupColor; collapsed?: boolean },
): Promise<boolean> {
  const s = rt.state();
  const own = { ...(s.ownWrites[groupId] ?? {}), at: rt.now() };
  if (props.title !== undefined) own.title = props.title;
  if (props.color !== undefined) own.color = props.color;
  s.ownWrites[groupId] = own;
  rt.commit();
  try {
    await withEditRetry(() => chrome.tabGroups.update(groupId, props));
    const g = rt.state().groups[groupId];
    if (g) {
      if (props.title !== undefined) g.stripTitle = props.title;
      if (props.color !== undefined) g.color = props.color;
    }
    return true;
  } catch (e) {
    rt.log("tabGroups.update failed", groupId, e);
    return false;
  }
}

/** Create a group the extension owns and register it before `tabGroups.onCreated` is handled. */
export async function createManagedGroup(
  rt: Runtime,
  tabIds: number[],
  windowId: number,
  origin: GroupOrigin,
  props: { title: string; color: GroupColor; collapsed?: boolean },
  extra: Partial<GroupRecord> = {},
): Promise<number | undefined> {
  const s = rt.state();
  s.pendingCreates.push({ windowId, origin, at: rt.now() });
  let groupId: number;
  try {
    groupId = await withEditRetry(() => chrome.tabs.group({ tabIds: tabIds as [number, ...number[]], createProperties: { windowId } }));
  } catch (e) {
    rt.log("tabs.group failed", e);
    return undefined;
  }
  const live = rt.state();
  const rec = live.groups[groupId] ?? newGroupRecord(groupId, windowId, origin, props.color);
  Object.assign(rec, { origin, managed: true, windowId, color: props.color }, extra);
  live.groups[groupId] = rec;
  for (const id of tabIds) if (live.tabs[id]) live.tabs[id].groupId = groupId;
  await updateGroup(rt, groupId, props);
  rt.commit();
  return groupId;
}

export async function addToGroup(rt: Runtime, tabIds: number[], groupId: number): Promise<boolean> {
  try {
    await withEditRetry(() => chrome.tabs.group({ tabIds: tabIds as [number, ...number[]], groupId }));
    return true;
  } catch (e) {
    rt.log("tabs.group into existing failed", e);
    return false;
  }
}

export async function ungroup(rt: Runtime, tabIds: number[]): Promise<void> {
  if (!tabIds.length) return;
  try {
    await withEditRetry(() => chrome.tabs.ungroup(tabIds as [number, ...number[]]));
  } catch (e) {
    rt.log("tabs.ungroup failed", e);
  }
}

export async function existingTabIds(ids: number[]): Promise<Set<number>> {
  const all = await chrome.tabs.query({});
  const have = new Set(all.map((t) => t.id!));
  return new Set(ids.filter((id) => have.has(id)));
}

export async function groupExists(groupId: number): Promise<boolean> {
  try {
    await chrome.tabGroups.get(groupId);
    return true;
  } catch {
    return false;
  }
}
