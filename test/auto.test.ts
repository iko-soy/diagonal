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
let respond: ((payload: OrganizePayload, opts?: object) => HostReply<unknown> | undefined) | undefined;

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
    host: async <T,>(_op: string, payload: object, opts?: object) => {
      calls.push(JSON.parse(JSON.stringify(payload)));
      return (respond?.(payload as OrganizePayload, opts) ?? replies.shift() ?? { ok: true, result: { groups: [], leftovers: [] } }) as HostReply<T>;
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
  respond = undefined;
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

  it("sorts tabs the browser discarded, which keep their title and address", async () => {
    const auto = setup([liveTab(1, { status: "unloaded" }), liveTab(2)]);
    await auto.run(1);
    expect(calls[0].items.map((i) => i.title)).toEqual(["Tab 1", "Tab 2"]);
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

  it("one tab the model refuses is found and set aside; the others are still sorted", async () => {
    const auto = setup([liveTab(1), liveTab(2), liveTab(3, { title: "Refused" }), liveTab(4), liveTab(5)]);
    // Apple's filter refuses any request carrying tab 3; anything else becomes one topic.
    respond = (p) =>
      p.items.some((i) => i.title === "Refused")
        ? { ok: false, error: { code: "GUARDRAIL", message: "blocked" } }
        : { ok: true, result: { groups: [{ title: "Site pages", emoji: "📚", color: "blue", existing: p.existingGroups.length ? 0 : undefined, members: p.items.map((i) => i.i) }], leftovers: [] } };
    await auto.run(1);
    expect(live.find((t) => t.id === 3)!.groupId).toBe(-1);
    expect(live.filter((t) => t.id !== 3).every((t) => t.groupId === 100)).toBe(true);
    expect(state.tabs[3].organizeRefused).toBe(organizedKeyOf(live[2]));
    expect(fallbacks).toHaveLength(0); // not a host problem: no retry scheduled

    const n = calls.length;
    live.push(liveTab(6));
    remember(live[5]);
    await auto.run(1);
    expect(calls.slice(n).flatMap((c) => c.items.map((i) => i.title))).toEqual(["Tab 6"]); // the refused tab is not sent again

    const m = calls.length;
    live[2].title = "Readable now";
    await auto.run(1);
    expect(calls.length).toBeGreaterThan(m); // a new title: it gets another chance
  });

  it("a refused request is tried once more without what the pages say", async () => {
    const auto = setup([liveTab(1), liveTab(2)]);
    state.tabs[1].description = "Something the filter dislikes";
    respond = (p) =>
      p.items.some((i) => i.description)
        ? { ok: false, error: { code: "GUARDRAIL", message: "blocked" } }
        : { ok: true, result: { groups: [{ title: "Pair", emoji: "📚", color: "blue", members: [0, 1] }], leftovers: [] } };
    await auto.run(1);
    expect(calls).toHaveLength(2);
    expect(live.map((t) => t.groupId)).toEqual([100, 100]);
  });

  it("tabs that changed while the model was thinking are left out of its answer", async () => {
    const auto = setup([liveTab(1), liveTab(2), liveTab(3), liveTab(4)]);
    respond = () => {
      live[1].url = "https://elsewhere.com/"; // tab 2 went to another page
      live = live.filter((t) => t.id !== 4); // tab 4 was closed
      return { ok: true, result: { groups: [{ title: "Site pages", emoji: "📚", color: "blue", members: [0, 1, 2] }, { title: "Other", emoji: "📚", color: "red", members: [3] }], leftovers: [] } };
    };
    await auto.run(1);
    expect(live.map((t) => [t.id, t.groupId])).toEqual([[1, 100], [2, -1], [3, 100]]);
    expect(state.tabs[1].organizedKey).toBeDefined();
    expect(state.tabs[2].organizedKey).toBeUndefined(); // looked at again on its new page
  });

  it("a new group left with one tab after the others moved on is not made", async () => {
    const auto = setup([liveTab(1), liveTab(2), liveTab(3)]);
    respond = () => {
      live[1].groupId = 77; // you dragged tab 2 into a group of yours meanwhile
      return { ok: true, result: { groups: [{ title: "Pair", emoji: "📚", color: "blue", members: [0, 1] }], leftovers: [2] } };
    };
    await auto.run(1);
    expect(live.find((t) => t.id === 1)!.groupId).toBe(-1);
    expect(nextGroup).toBe(100);
  });

  it("an unread count ticking over is not a new page", async () => {
    const auto = setup([liveTab(1, { title: "(3) Inbox" }), liveTab(2)]);
    await auto.run(1);
    expect(calls).toHaveLength(1);
    live[0].title = "(4) Inbox";
    await auto.run(1);
    expect(calls).toHaveLength(1);
  });

  it("a host that stops answering stops the run after one smaller try", async () => {
    const auto = setup(Array.from({ length: 10 }, (_, i) => liveTab(i + 1)));
    respond = () => ({ ok: false, error: { code: "TIMEOUT", message: "slow" } });
    await auto.run(1);
    expect(calls.map((c) => c.items.length)).toEqual([10, 5]);
    expect(fallbacks).toHaveLength(1);
    expect(Object.values(state.tabs).some((t) => t.organizeRefused)).toBe(false);
  });
});
