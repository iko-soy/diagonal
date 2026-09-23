import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostReply } from "../src/background/host";
import { AutoOrganizer, organizedKeyOf, type OrganizePayload } from "../src/background/organize";
import type { Runtime } from "../src/background/runtime";
import { newGroupRecord, emptyState, type State } from "../src/background/state";
import { settings as makeSettings } from "./helpers";

/** AutoOrganizer against a small in-memory tab strip standing in for `chrome.tabs`. */

type LiveTab = { id: number; windowId: number; index: number; groupId: number; url: string; title: string; status: string; pinned: boolean };

let live: LiveTab[];
let nextGroup: number;
let state: State;
let calls: OrganizePayload[];
let replies: HostReply<unknown>[];
let fallbacks: number[];

const liveTab = (id: number, over: Partial<LiveTab> = {}): LiveTab => ({
  id, windowId: 1, index: id, groupId: -1, url: `https://site${id}.com/page`, title: `Tab ${id}`, status: "complete", pinned: false, ...over,
});

function remember(t: LiveTab, extra: object = {}): void {
  state.tabs[t.id] = { id: t.id, windowId: t.windowId, groupId: t.groupId, index: t.index, url: t.url, title: t.title, pinned: t.pinned, status: t.status, createdAt: 0, lastActivatedAt: 0, ...extra };
}

function setup(tabs: LiveTab[]): AutoOrganizer {
  live = tabs;
  for (const t of tabs) remember(t);
  const rt: Runtime = {
    state: () => state,
    settings: () => makeSettings(),
    commit: () => undefined,
    now: () => 1_000_000,
    host: async <T,>(_op: string, payload: object) => {
      calls.push(JSON.parse(JSON.stringify(payload)));
      return (replies.shift() ?? { ok: true, result: { groups: [], leftovers: [] } }) as HostReply<T>;
    },
    naming: { touch: () => undefined } as unknown as Runtime["naming"],
    refreshBadge: () => undefined,
    log: () => undefined,
  };
  return new AutoOrganizer(rt, { scheduleFallback: (when) => fallbacks.push(when) });
}

beforeEach(() => {
  state = emptyState();
  calls = [];
  replies = [];
  fallbacks = [];
  nextGroup = 100;
  (globalThis as any).chrome = {
    tabs: {
      query: async (q: { windowId?: number; groupId?: number }) =>
        live.filter((t) => (q.windowId === undefined || t.windowId === q.windowId) && (q.groupId === undefined || t.groupId === q.groupId)).map((t) => ({ ...t })),
      group: async ({ tabIds, groupId }: { tabIds: number[]; groupId?: number }) => {
        const id = groupId ?? nextGroup++;
        for (const t of live) if (tabIds.includes(t.id)) t.groupId = id;
        return id;
      },
      ungroup: async () => undefined,
    },
    tabGroups: { update: async () => undefined },
    windows: { getAll: async () => [{ id: 1, incognito: false }] },
  };
});

afterEach(() => {
  delete (globalThis as any).chrome;
});

describe("auto-organize", () => {
  it("groups loose tabs the model clusters, and remembers it looked at them", async () => {
    const auto = setup([liveTab(1), liveTab(2), liveTab(3)]);
    replies.push({ ok: true, result: { groups: [{ title: "Rust async", emoji: "🦀", color: "orange", members: [0, 1] }], leftovers: [2] } });
    await auto.run(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].items.map((i) => i.title)).toEqual(["Tab 1", "Tab 2", "Tab 3"]);
    expect(live.map((t) => t.groupId)).toEqual([100, 100, -1]);
    expect(state.groups[100]).toMatchObject({ origin: "organize", managed: true, title: "Rust async" });
    expect(state.tabs[3].organizedKey).toBe(organizedKeyOf(live[2]));

    await auto.run(1);
    expect(calls).toHaveLength(1); // nothing changed: no second call
  });

  it("a new tab is sent first, with the leftovers it may pair with and Diagonal's groups it may join", async () => {
    const auto = setup([liveTab(1, { groupId: 50 }), liveTab(2), liveTab(3)]);
    state.groups[50] = newGroupRecord(50, 1, "opener", "blue", { managed: true, stripTitle: "🦀 Rust", title: "Rust" });
    state.tabs[2].organizedKey = organizedKeyOf(live[1]);
    replies.push({ ok: true, result: { groups: [{ title: "Rust", emoji: "🦀", color: "blue", existing: 0, members: [0] }], leftovers: [1] } });
    await auto.run(1);
    expect(calls[0].items.map((i) => i.title)).toEqual(["Tab 3", "Tab 2"]);
    expect(calls[0].existingGroups).toEqual([expect.objectContaining({ g: 0, title: "Rust" })]);
    expect(live.find((t) => t.id === 3)!.groupId).toBe(50);
  });

  it("leaves alone tabs you took out of a group, pinned tabs, new tab pages and tabs still loading", async () => {
    const auto = setup([
      liveTab(1),
      liveTab(2, { pinned: true }),
      liveTab(3, { url: "brave://newtab/" }),
      liveTab(4, { status: "loading" }),
      liveTab(5),
      liveTab(6),
    ]);
    state.tabs[1].keepLoose = "https://site1.com/page";
    await auto.run(1);
    expect(calls[0].items.map((i) => i.title)).toEqual(["Tab 5", "Tab 6"]);
  });

  it("one loose tab with nothing to join waits for company", async () => {
    const auto = setup([liveTab(1)]);
    await auto.run(1);
    expect(calls).toHaveLength(0);
  });

  it("a failed call leaves the tabs fresh and schedules a retry", async () => {
    const auto = setup([liveTab(1), liveTab(2)]);
    replies.push({ ok: false, error: { code: "TIMEOUT", message: "slow" } });
    await auto.run(1);
    expect(state.tabs[1].organizedKey).toBeUndefined();
    expect(fallbacks.length).toBe(1);
  });

  it("does not call the host while it is paused", async () => {
    const auto = setup([liveTab(1), liveTab(2)]);
    state.host.pausedUntil = 2_000_000;
    await auto.run(1);
    expect(calls).toHaveLength(0);
  });

  it("debounces: several touches in a row make one run", async () => {
    vi.useFakeTimers();
    try {
      const auto = setup([liveTab(1), liveTab(2)]);
      auto.touch(1);
      auto.touch(1);
      auto.touch(1);
      await vi.advanceTimersByTimeAsync(makeSettings().autoOrganizeDelayMs + 10);
      expect(calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
