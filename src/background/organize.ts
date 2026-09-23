import { COLORS, isColor, type GroupColor } from "../shared/colors";
import { labelOf, repairLabel, safeEmoji, stripTitle } from "../shared/label";
import { colorFor, isInternalUrl, promptAddress, provisionalTitle } from "../shared/url";
import { membersHash, memberUrls, toItems, type Member, type NameItem } from "./naming";
import { addToGroup, createManagedGroup, groupExists, ungroup, type Runtime } from "./runtime";
import { markDirty, type State } from "./state";

/** Section 3/9: "Organize all tabs" — cluster ungrouped tabs in batches sized to the model's window. */

export const ORGANIZE_ITEM_CAP = 18;
export const EXISTING_GROUPS_CAP = 12;
export const CHAR_BUDGET = 10_000;
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

/** Rough rendered size of one item line, the unit the character budget is spent in. */
export const itemChars = (m: Pick<Member, "title" | "url" | "description">): number =>
  Math.min(120, m.title.length) + promptAddress(m.url).length + Math.min(300, m.description?.length ?? 1) + 12;

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

/** Existing groups a batch may add tabs to: extension-managed topic groups in this window. */
export function existingGroupsFor(state: State, windowId: number, extraIds: number[] = []): { ids: number[]; list: ExistingGroup[] } {
  const groups = Object.values(state.groups)
    .filter((g) => g.windowId === windowId && g.managed && g.origin !== "tidy" && (g.stripTitle || g.title))
    .sort((a, b) => Number(extraIds.includes(b.id)) - Number(extraIds.includes(a.id)))
    .slice(0, EXISTING_GROUPS_CAP);
  const list = groups.map((g, i) => ({
    g: i,
    title: labelOf(g.stripTitle || g.title),
    samples: Object.values(state.tabs)
      .filter((t) => t.groupId === g.id)
      .slice(0, 2)
      .map((t) => t.title.slice(0, 60)),
  }));
  return { ids: groups.map((g) => g.id), list };
}

export async function organizeWindow(rt: Runtime, windowId: number): Promise<OrganizeReport> {
  const settings = rt.settings();
  const tabs = (await chrome.tabs.query({ windowId })).filter((t) => organizable(t)).sort((a, b) => a.index - b.index);
  const report: OrganizeReport = { grouped: 0, groups: 0, left: 0 };
  if (tabs.length < 2) {
    report.left = tabs.length;
    return report;
  }
  const members: Member[] = tabs.map((t) => ({
    id: t.id!,
    index: t.index,
    url: t.url ?? "",
    title: t.title ?? "",
    status: t.status,
    description: rt.state().tabs[t.id!]?.description,
    lastActive: t.lastAccessed ?? 0,
  }));
  const previous: Record<number, number> = {};
  const createdIds: number[] = [];
  const queue = makeBatches(members);
  rt.state().inFlight = { groupId: -1, startedAt: rt.now() };
  rt.refreshBadge();
  try {
    while (queue.length) {
      const batch = queue.shift()!;
      const { ids: existingIds, list: existingGroups } = existingGroupsFor(rt.state(), windowId, createdIds);
      const maxGroups = maxGroupsFor(batch.length);
      const payload: OrganizePayload = {
        items: toItems(batch, settings),
        existingGroups,
        allowNew: true,
        maxGroups,
        minGroupSize: settings.organizeMinGroupSize,
      };
      let reply = await rt.host<OrganizeResult>("organize", payload);
      if (!reply.ok && reply.error.code === "OVER_BUDGET" && batch.length > 1) {
        const half = Math.ceil(batch.length / 2);
        queue.unshift(batch.slice(0, half), batch.slice(half));
        continue;
      }
      if (!reply.ok && reply.error.code === "BAD_MODEL_OUTPUT") reply = await rt.host<OrganizeResult>("organize", payload, { strict: true });
      if (!reply.ok) {
        report.error = `${reply.error.code}: ${reply.error.message}`;
        report.left += batch.length + queue.flat().length;
        break;
      }
      const batchIds = batch.map((m) => m.id);
      const plan = planFromResult(reply.result, batchIds, existingIds, settings.organizeMinGroupSize, maxGroups, (ids) =>
        colorFor(members.find((m) => m.id === ids[0])?.url ?? ""),
      );
      await applyPlan(rt, plan, windowId, members, previous, createdIds);
      report.grouped += plan.joins.reduce((n, j) => n + j.tabIds.length, 0) + plan.creates.reduce((n, c) => n + c.tabIds.length, 0);
      report.left += plan.leftovers.length;
    }
  } finally {
    const s = rt.state();
    if (s.inFlight?.groupId === -1) s.inFlight = undefined;
    report.groups = createdIds.length;
    if (Object.keys(previous).length) s.lastOrganize = { at: rt.now(), previous };
    rt.commit();
    rt.refreshBadge();
  }
  return report;
}

async function applyPlan(
  rt: Runtime,
  plan: Plan,
  windowId: number,
  members: Member[],
  previous: Record<number, number>,
  createdIds: number[],
): Promise<void> {
  const settings = rt.settings();
  const byId = new Map(members.map((m) => [m.id, m]));
  for (const j of plan.joins) {
    if (!(await addToGroup(rt, j.tabIds, j.groupId))) continue;
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
    if (groupId === undefined) continue;
    createdIds.push(groupId);
    for (const id of c.tabIds) previous[id] = -1;
    const g = rt.state().groups[groupId];
    if (g && !named) {
      markDirty(g, rt.now());
      rt.naming.touch(groupId);
    }
  }
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

export { COLORS };
