import type { Ctx, TabSnapshot } from "../src/background/engine";
import { DEFAULT_SETTINGS, type Settings } from "../src/background/settings";
import { emptyState, newGroupRecord, type GroupOrigin, type State } from "../src/background/state";

export const settings = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...over });
export const ctx = (now = 1_000_000, over: Partial<Settings> = {}): Ctx => ({ now, settings: settings(over) });

export function tab(id: number, over: Partial<TabSnapshot> = {}): TabSnapshot {
  return { id, windowId: 1, groupId: -1, index: id, url: `https://example.com/${id}`, title: `Tab ${id}`, pinned: false, status: "complete", ...over };
}

export function stateWith(tabs: TabSnapshot[], groups: { id: number; origin: GroupOrigin; managed?: boolean; title?: string }[] = []): State {
  const s = emptyState();
  for (const t of tabs) {
    s.tabs[t.id] = {
      id: t.id, windowId: t.windowId, groupId: t.groupId, index: t.index, url: t.url ?? "", title: t.title ?? "",
      pinned: t.pinned, status: t.status, createdAt: 0, lastActivatedAt: 0,
    };
  }
  for (const g of groups) {
    s.groups[g.id] = newGroupRecord(g.id, 1, g.origin, "blue", { managed: g.managed ?? g.origin !== "user", stripTitle: g.title, title: g.title });
  }
  return s;
}
