import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Runtime } from "../src/background/runtime";
import { emptyState, newGroupRecord, type State } from "../src/background/state";
import { HOUR, runSweep, undoSweep } from "../src/background/tidy";
import { settings as makeSettings } from "./helpers";

/** The tidy sweep against a small in-memory strip with Chromium's group rules: an emptied group is removed. */

type LiveTab = {
  id: number; windowId: number; index: number; groupId: number; url: string; title: string;
  pinned: boolean; active: boolean; discarded: boolean; autoDiscardable: boolean; lastAccessed: number;
};
type LiveGroup = { id: number; windowId: number; title: string; color: string; collapsed: boolean };

const T0 = 10_000 * HOUR;
let now: number;
let live: LiveTab[];
let groups: Map<number, LiveGroup>;
let nextGroup: number;
let state: State;
let discarded: number[];

const liveTab = (id: number, over: Partial<LiveTab> = {}): LiveTab => ({
  id, windowId: 1, index: id, groupId: -1, url: `https://site${id}.com/p`, title: `Tab ${id}`,
  pinned: false, active: false, discarded: false, autoDiscardable: true, lastAccessed: T0 - 60 * HOUR, ...over,
});

function remember(t: LiveTab): void {
  state.tabs[t.id] = { id: t.id, windowId: t.windowId, groupId: t.groupId, index: t.index, url: t.url, title: t.title, pinned: t.pinned, createdAt: 0, lastActivatedAt: t.lastAccessed };
}

const dropEmpty = () => {
  for (const id of [...groups.keys()]) if (!live.some((t) => t.groupId === id)) groups.delete(id);
};

const rt: Runtime = {
  state: () => state,
  settings: () => makeSettings(),
  commit: () => undefined,
  now: () => now,
  host: async () => ({ ok: false, error: { code: "FM_ERROR", message: "not used" } }) as never,
  naming: { touch: () => undefined } as unknown as Runtime["naming"],
  refreshBadge: () => undefined,
  log: () => undefined,
};

beforeEach(() => {
  now = T0;
  state = emptyState();
  groups = new Map();
  nextGroup = 500;
  discarded = [];
  (globalThis as any).chrome = {
    tabs: {
      query: async (q: { windowId?: number; groupId?: number }) =>
        live.filter((t) => (q.windowId === undefined || t.windowId === q.windowId) && (q.groupId === undefined || t.groupId === q.groupId)).map((t) => ({ ...t })),
      get: async (id: number) => ({ ...live.find((t) => t.id === id)! }),
      group: async ({ tabIds, groupId, createProperties }: { tabIds: number[]; groupId?: number; createProperties?: { windowId: number } }) => {
        let id = groupId;
        if (id === undefined) {
          id = nextGroup++;
          groups.set(id, { id, windowId: createProperties?.windowId ?? 1, title: "", color: "grey", collapsed: false });
        }
        for (const t of live) if (tabIds.includes(t.id)) t.groupId = id;
        dropEmpty();
        return id;
      },
      ungroup: async (ids: number[]) => {
        for (const t of live) if (ids.includes(t.id)) t.groupId = -1;
        dropEmpty();
      },
      move: async () => undefined,
      discard: async (id: number) => {
        discarded.push(id);
        live.find((t) => t.id === id)!.discarded = true;
      },
      remove: async (ids: number[]) => {
        live = live.filter((t) => !ids.includes(t.id));
        dropEmpty();
      },
    },
    tabGroups: {
      get: async (id: number) => {
        const g = groups.get(id);
        if (!g) throw new Error(`No group with id: ${id}.`);
        return { ...g };
      },
      query: async (q: { windowId?: number }) => [...groups.values()].filter((g) => q.windowId === undefined || g.windowId === q.windowId).map((g) => ({ ...g })),
      update: async (id: number, props: Partial<LiveGroup>) => Object.assign(groups.get(id)!, props),
      move: async () => undefined,
    },
  };
});

afterEach(() => {
  delete (globalThis as any).chrome;
});

function strip(tabs: LiveTab[], made: LiveGroup[] = []): void {
  live = tabs;
  for (const g of made) groups.set(g.id, g);
  for (const t of tabs) remember(t);
}

const parkedGroupId = () => Object.values(state.groups).find((g) => g.origin === "tidy")?.id;

describe("tidy sweep", () => {
  it("parks a stale tab and closes it only after it has sat in Parked for the archive time", async () => {
    strip([liveTab(1), liveTab(2, { active: true })]);
    expect(await runSweep(rt)).toMatchObject({ parked: 1, archived: 0 });
    expect(live.find((t) => t.id === 1)!.groupId).toBe(parkedGroupId());
    expect(state.tabs[1].parkedAt).toBe(T0);

    now = T0 + 47 * HOUR;
    expect(await runSweep(rt)).toMatchObject({ archived: 0 });
    now = T0 + 48 * HOUR;
    expect(await runSweep(rt)).toMatchObject({ archived: 1 });
    expect(state.archive.map((a) => a.url)).toEqual(["https://site1.com/p"]);
  });

  it("two sweeps at once archive a tab once", async () => {
    strip([liveTab(1, { groupId: 9 }), liveTab(2, { active: true })], [{ id: 9, windowId: 1, title: "💤 Parked", color: "grey", collapsed: true }]);
    state.groups[9] = newGroupRecord(9, 1, "tidy", "grey", { userNamed: true, stripTitle: "💤 Parked" });
    state.tabs[1].parkedAt = T0 - 49 * HOUR;
    await Promise.all([runSweep(rt), runSweep(rt, true)]);
    expect(state.archive).toHaveLength(1);
  });

  it("a Parked group whose record an older version lost is Parked again", async () => {
    strip([liveTab(1, { groupId: 50 }), liveTab(2)], [{ id: 50, windowId: 1, title: "💤 Parked", color: "grey", collapsed: true }]);
    state.groups[50] = newGroupRecord(50, 1, "user", "grey", { userNamed: true, stripTitle: "💤 Parked" });
    await runSweep(rt);
    expect(live.find((t) => t.id === 2)!.groupId).toBe(50);
    expect(groups.size).toBe(1);
    expect(state.groups[50]).toMatchObject({ origin: "tidy", managed: true });
  });

  it("does not discard a tab marked never to be discarded", async () => {
    strip([liveTab(1), liveTab(2, { autoDiscardable: false }), liveTab(3, { active: true })]);
    await runSweep(rt);
    expect(discarded).toEqual([1]);
  });
});

describe("undo tidy", () => {
  it("brings back a group that parking emptied, with its title", async () => {
    strip(
      [liveTab(1, { active: true }), liveTab(2, { groupId: 7 }), liveTab(3, { groupId: 7 })],
      [{ id: 7, windowId: 1, title: "🦀 Rust async", color: "orange", collapsed: false }],
    );
    state.groups[7] = newGroupRecord(7, 1, "organize", "orange", { title: "Rust async", emoji: "🦀", stripTitle: "🦀 Rust async" });
    await runSweep(rt);
    expect(groups.has(7)).toBe(false);

    expect(await undoSweep(rt)).toBe(2);
    const back = live.find((t) => t.id === 2)!.groupId;
    expect(back).not.toBe(-1);
    expect(live.find((t) => t.id === 3)!.groupId).toBe(back);
    expect(groups.get(back)).toMatchObject({ title: "🦀 Rust async", color: "orange" });
    expect(state.groups[back]).toMatchObject({ origin: "organize", title: "Rust async", userNamed: false });
    expect(state.tabs[2].parkedAt).toBeUndefined();
  });

  it("puts loose tabs back as the worker's own move, so they are not taken for tabs you pulled out", async () => {
    strip([liveTab(1, { active: true }), liveTab(4)]);
    await runSweep(rt);
    await undoSweep(rt);
    expect(live.find((t) => t.id === 4)!.groupId).toBe(-1);
    expect(state.ownUngroups[4]).toBeDefined();
  });

  it("covers every sweep in the last hour, not only the latest", async () => {
    strip([liveTab(1, { active: true }), liveTab(2), liveTab(3, { lastAccessed: T0 - 23.5 * HOUR })]);
    state.tabs[3].lastActivatedAt = T0 - 23.5 * HOUR;
    await runSweep(rt, true);
    now = T0 + HOUR / 2;
    await runSweep(rt);
    expect(live.filter((t) => t.groupId !== -1).map((t) => t.id)).toEqual([2, 3]);
    expect(await undoSweep(rt)).toBe(2);
  });
});
