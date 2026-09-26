import { describe, expect, it } from "vitest";
import { existingGroupsFor, makeBatches, maxGroupsFor, organizable, planFromResult } from "../src/background/organize";
import { newGroupRecord } from "../src/background/state";
import { emptyState } from "../src/background/state";

const t = (n: number, over: { title?: string; description?: string } = {}) => ({
  id: n, title: over.title ?? `Tab ${n}`, url: `https://site${n}.com/page`, description: over.description,
});

describe("batching", () => {
  it("caps batches at 36 items", () => {
    const b = makeBatches(Array.from({ length: 80 }, (_, i) => t(i)));
    expect(b.map((x) => x.length)).toEqual([36, 36, 8]);
  });

  it("also respects the character budget", () => {
    const long = "x".repeat(300);
    const b = makeBatches(Array.from({ length: 30 }, (_, i) => t(i, { title: long, description: long })), 18, 5000);
    for (const batch of b) expect(batch.reduce((n, x) => n + 120 + x.url.length + 300 + 12, 0)).toBeLessThanOrEqual(5000 + 500);
    expect(b.length).toBeGreaterThan(2);
    expect(b.flat()).toHaveLength(30);
  });

  it("counts Chinese and Japanese characters double, as fm's tokenizer does", () => {
    const en = makeBatches(Array.from({ length: 30 }, (_, i) => t(i, { description: "x".repeat(300) })), 36, 5000);
    const zh = makeBatches(Array.from({ length: 30 }, (_, i) => t(i, { description: "中".repeat(300) })), 36, 5000);
    expect(zh.length).toBeGreaterThan(en.length);
    expect(zh.flat()).toHaveLength(30);
  });

  it("maxGroups = min(8, ceil(items / 3))", () => {
    expect(maxGroupsFor(18)).toBe(6);
    expect(maxGroupsFor(4)).toBe(2);
    expect(maxGroupsFor(60)).toBe(8);
  });

  it("only takes ungrouped, unpinned web tabs", () => {
    expect(organizable({ groupId: -1, pinned: false, url: "https://a.com" })).toBe(true);
    expect(organizable({ groupId: 3, pinned: false, url: "https://a.com" })).toBe(false);
    expect(organizable({ groupId: -1, pinned: true, url: "https://a.com" })).toBe(false);
    expect(organizable({ groupId: -1, pinned: false, url: "brave://settings" })).toBe(false);
  });
});

describe("applying a reply", () => {
  const ids = [100, 101, 102, 103, 104, 105];
  const color = () => "cyan" as const;

  it("maps indexes to tabs, joins existing groups, folds singletons into leftovers", () => {
    const plan = planFromResult(
      {
        groups: [
          { title: "Lisbon trip", emoji: "✈️", color: "blue", existing: -1, members: [0, 1, 2] },
          { title: "", emoji: "", color: "", existing: 0, members: [3] },
          { title: "Lonely one", emoji: "📚", color: "red", existing: -1, members: [4] },
        ],
        leftovers: [],
      },
      ids, [555], 2, 8, color,
    );
    expect(plan.creates).toEqual([{ tabIds: [100, 101, 102], label: "Lisbon trip", emoji: "✈️", color: "blue" }]);
    expect(plan.joins).toEqual([{ groupId: 555, tabIds: [103] }]);
    expect(plan.leftovers.sort()).toEqual([104, 105]);
  });

  it("drops duplicate and out-of-range indexes; every tab ends up exactly once", () => {
    const plan = planFromResult(
      { groups: [{ title: "Rust async", emoji: "🦀", color: "nope", members: [0, 0, 1, 9, -1] }, { title: "Cooking ideas", emoji: "🍳", color: "green", members: [1, 2] }], leftovers: [] },
      ids, [], 2, 8, color,
    );
    const all = [...plan.creates.flatMap((c) => c.tabIds), ...plan.joins.flatMap((j) => j.tabIds), ...plan.leftovers];
    expect(all.sort()).toEqual([...ids].sort());
    expect(plan.creates[0].color).toBe("cyan"); // invalid colour replaced
  });

  it("keeps at most maxGroups new groups, largest first", () => {
    const plan = planFromResult(
      { groups: [{ title: "Aa bb", emoji: "", color: "red", members: [0, 1] }, { title: "Cc dd", emoji: "", color: "red", members: [2, 3, 4] }], leftovers: [] },
      ids, [], 2, 1, color,
    );
    expect(plan.creates.map((c) => c.tabIds)).toEqual([[102, 103, 104]]);
    expect(plan.leftovers.sort()).toEqual([100, 101, 105]);
  });

  it("an invalid label keeps the group but leaves naming to the naming loop", () => {
    const plan = planFromResult({ groups: [{ title: "Tabs", emoji: "🦀", color: "red", members: [0, 1] }], leftovers: [] }, ids, [], 2, 8, color);
    expect(plan.creates[0].label).toBeUndefined();
  });

  it("honours organizeMinGroupSize", () => {
    const plan = planFromResult({ groups: [{ title: "Rust async", emoji: "🦀", color: "red", members: [0, 1] }], leftovers: [] }, ids, [], 3, 8, color);
    expect(plan.creates).toEqual([]);
  });
});

describe("existing groups", () => {
  it("lists managed topic groups in the window with sample titles, capped at 12", () => {
    const s = emptyState();
    for (let i = 0; i < 15; i++) s.groups[i] = newGroupRecord(i, 1, "organize", "red", { stripTitle: `✈️ Trip ${i}` });
    s.groups[50] = newGroupRecord(50, 1, "tidy", "grey", { stripTitle: "Parked" });
    s.groups[51] = newGroupRecord(51, 2, "organize", "grey", { stripTitle: "Other window" });
    s.tabs[1] = { id: 1, windowId: 1, groupId: 0, index: 0, url: "u", title: "Hotel", pinned: false, createdAt: 0, lastActivatedAt: 0 };
    const { ids, list } = existingGroupsFor(s, 1);
    expect(ids).toHaveLength(12);
    expect(ids).not.toContain(50);
    expect(ids).not.toContain(51);
    expect(list[0]).toEqual({ g: 0, title: "Trip 0", samples: ["Hotel"] });
  });

  it("offers the groups in use when there are more than 12, not the oldest", () => {
    const s = emptyState();
    for (let i = 0; i < 15; i++) s.groups[i] = newGroupRecord(i, 1, "organize", "red", { stripTitle: `G ${i}`, lastNamedAt: 1000 - i });
    s.tabs[1] = { id: 1, windowId: 1, groupId: 14, index: 0, url: "u", title: "Now", pinned: false, createdAt: 0, lastActivatedAt: 5000 };
    const { ids } = existingGroupsFor(s, 1);
    expect(ids[0]).toBe(14);
    expect(ids).toContain(0);
    expect(ids).not.toContain(13);
  });

  it("leaves out the Restored group, which is not a topic", () => {
    const s = emptyState();
    s.groups[1] = newGroupRecord(1, 1, "organize", "grey", { userNamed: true, stripTitle: "♻️ Restored", restored: true });
    s.groups[2] = newGroupRecord(2, 1, "organize", "red", { stripTitle: "🦀 Rust" });
    expect(existingGroupsFor(s, 1).ids).toEqual([2]);
  });

  it("groups created by batch n come first for batch n+1", () => {
    const s = emptyState();
    for (let i = 0; i < 15; i++) s.groups[i] = newGroupRecord(i, 1, "organize", "red", { stripTitle: `G ${i}` });
    expect(existingGroupsFor(s, 1, [14]).ids[0]).toBe(14);
  });
});
