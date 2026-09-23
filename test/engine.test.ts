import { describe, expect, it } from "vitest";
import { step, DISSOLVE_DELAY_MS } from "../src/background/engine";
import { ctx, stateWith, tab } from "./helpers";

describe("opener rule", () => {
  it("Cmd-click from an ungrouped tab creates a group of both, titled with the opener's host", () => {
    const opener = tab(1, { url: "https://www.github.com/rust-lang/rust" });
    const s = stateWith([opener]);
    const child = tab(2, { openerTabId: 1, url: "", pendingUrl: "https://github.com/rust-lang/rust/issues" });
    const { actions } = step(s, { type: "tabCreated", tab: child, opener }, ctx());
    expect(actions).toEqual([
      expect.objectContaining({ type: "createGroup", tabIds: [1, 2], windowId: 1, title: "github.com", origin: "opener" }),
    ]);
  });

  it("Cmd-click from a pinned tab spawns a plain tab", () => {
    const opener = tab(1, { pinned: true });
    const { actions } = step(stateWith([opener]), { type: "tabCreated", tab: tab(2, { openerTabId: 1 }), opener }, ctx());
    expect(actions).toEqual([]);
  });

  it("skips pinned, blank and internal children", () => {
    const opener = tab(1);
    for (const child of [tab(2, { openerTabId: 1, pinned: true }), tab(2, { openerTabId: 1, url: "about:blank" }), tab(2, { openerTabId: 1, url: "brave://newtab/" }), tab(2, { openerTabId: 1, url: "" })]) {
      expect(step(stateWith([opener]), { type: "tabCreated", tab: child, opener }, ctx()).actions).toEqual([]);
    }
  });

  it("Cmd-click from a grouped tab only records membership and marks the group dirty", () => {
    const opener = tab(1, { groupId: 10 });
    const s = stateWith([opener], [{ id: 10, origin: "opener" }]);
    const { state, actions } = step(s, { type: "tabCreated", tab: tab(2, { openerTabId: 1, groupId: 10 }), opener }, ctx());
    expect(actions).toEqual([{ type: "dirty", groupId: 10 }]);
    expect(state.tabs[2].groupId).toBe(10);
    expect(state.groups[10].dirty).toBe(true);
  });

  it("a child that raced the group's creation is added to the opener's group", () => {
    const opener = tab(1, { groupId: 10 });
    const s = stateWith([opener], [{ id: 10, origin: "opener" }]);
    const { actions } = step(s, { type: "tabCreated", tab: tab(2, { openerTabId: 1 }), opener }, ctx());
    expect(actions).toEqual([{ type: "addToGroup", tabIds: [2], groupId: 10 }]);
  });

  it("does nothing when opener grouping is off", () => {
    const opener = tab(1);
    expect(step(stateWith([opener]), { type: "tabCreated", tab: tab(2, { openerTabId: 1 }), opener }, ctx(0, { openerGrouping: false })).actions).toEqual([]);
  });

  it("ignores incognito tabs entirely", () => {
    const opener = tab(1, { incognito: true });
    const { state, actions } = step(stateWith([]), { type: "tabCreated", tab: tab(2, { openerTabId: 1, incognito: true }), opener }, ctx());
    expect(actions).toEqual([]);
    expect(state.tabs[2]).toBeUndefined();
  });
});

describe("dissolve rule", () => {
  it("closing down to one member of an opener group schedules a delayed dissolve", () => {
    const s = stateWith([tab(1, { groupId: 10 }), tab(2, { groupId: 10 })], [{ id: 10, origin: "opener" }]);
    const { actions } = step(s, { type: "tabRemoved", tabId: 2 }, ctx());
    expect(actions).toContainEqual({ type: "scheduleDissolve", groupId: 10, delayMs: DISSOLVE_DELAY_MS });
  });

  it("the delayed check ungroups a lone member", () => {
    const s = stateWith([tab(1, { groupId: 10 })], [{ id: 10, origin: "opener" }]);
    expect(step(s, { type: "dissolveCheck", groupId: 10, memberIds: [1] }, ctx()).actions).toEqual([{ type: "ungroup", tabIds: [1] }]);
  });

  it("reopening within 1.5 s (two members at the check) keeps the group", () => {
    const s = stateWith([tab(1, { groupId: 10 }), tab(3, { groupId: 10 })], [{ id: 10, origin: "opener" }]);
    expect(step(s, { type: "dissolveCheck", groupId: 10, memberIds: [1, 3] }, ctx()).actions).toEqual([]);
  });

  it("organize groups shrink to one member without dissolving", () => {
    const s = stateWith([tab(1, { groupId: 10 }), tab(2, { groupId: 10 })], [{ id: 10, origin: "organize" }]);
    const r1 = step(s, { type: "tabRemoved", tabId: 2 }, ctx());
    expect(r1.actions.some((a) => a.type === "scheduleDissolve")).toBe(false);
    expect(step(r1.state, { type: "dissolveCheck", groupId: 10, memberIds: [1] }, ctx()).actions).toEqual([]);
  });

  it("user groups are never dissolved", () => {
    const s = stateWith([tab(1, { groupId: 10 })], [{ id: 10, origin: "user" }]);
    expect(step(s, { type: "dissolveCheck", groupId: 10, memberIds: [1] }, ctx()).actions).toEqual([]);
  });

  it("respects dissolveSingletons = off", () => {
    const s = stateWith([tab(1, { groupId: 10 })], [{ id: 10, origin: "opener" }]);
    expect(step(s, { type: "dissolveCheck", groupId: 10, memberIds: [1] }, ctx(0, { dissolveSingletons: false })).actions).toEqual([]);
  });

  it("dragging a tab out of a managed group marks it dirty and checks for dissolve", () => {
    const s = stateWith([tab(1, { groupId: 10 }), tab(2, { groupId: 10 })], [{ id: 10, origin: "opener" }]);
    const { actions, state } = step(s, { type: "tabUpdated", tab: tab(2, { groupId: -1 }) }, ctx());
    expect(actions).toContainEqual({ type: "scheduleDissolve", groupId: 10, delayMs: DISSOLVE_DELAY_MS });
    expect(state.groups[10].dirty).toBe(true);
  });
});

describe("group registration and user edits", () => {
  it("a group created by hand is registered as the user's and left alone", () => {
    const { state, actions } = step(stateWith([]), { type: "groupCreated", group: { id: 5, windowId: 1, title: "Taxes", color: "red" } }, ctx());
    expect(state.groups[5]).toMatchObject({ origin: "user", managed: false, userNamed: true });
    expect(actions).toEqual([]);
  });

  it("a group the worker created within 2 s is managed", () => {
    const s = stateWith([]);
    s.pendingCreates.push({ windowId: 1, origin: "opener", at: 1_000_000 });
    const { state } = step(s, { type: "groupCreated", group: { id: 5, windowId: 1, title: "", color: "blue" } }, ctx(1_001_000));
    expect(state.groups[5]).toMatchObject({ origin: "opener", managed: true });
    expect(state.pendingCreates).toEqual([]);
  });

  it("a pending create older than 2 s no longer claims the group", () => {
    const s = stateWith([]);
    s.pendingCreates.push({ windowId: 1, origin: "opener", at: 1_000_000 });
    const { state } = step(s, { type: "groupCreated", group: { id: 5, windowId: 1, title: "", color: "blue" } }, ctx(1_003_000));
    expect(state.groups[5].origin).toBe("user");
  });

  it("a user rename sets userNamed and stops naming; the worker's own writes do not", () => {
    const s = stateWith([], [{ id: 10, origin: "opener", title: "github.com" }]);
    s.ownWrites[10] = { title: "🦀 Rust async runtimes", at: 1_000_000 };
    const own = step(s, { type: "groupUpdated", group: { id: 10, windowId: 1, title: "🦀 Rust async runtimes", color: "blue" } }, ctx());
    expect(own.state.groups[10].userNamed).toBe(false);
    const user = step(own.state, { type: "groupUpdated", group: { id: 10, windowId: 1, title: "My stuff", color: "blue" } }, ctx());
    expect(user.state.groups[10].userNamed).toBe(true);
    expect(user.state.groups[10].dirty).toBe(false);
  });

  it("renaming back to an empty title re-enables naming", () => {
    const s = stateWith([], [{ id: 10, origin: "opener", title: "Mine" }]);
    s.groups[10].userNamed = true;
    const { state, actions } = step(s, { type: "groupUpdated", group: { id: 10, windowId: 1, title: "", color: "blue" } }, ctx());
    expect(state.groups[10].userNamed).toBe(false);
    expect(actions).toEqual([{ type: "dirty", groupId: 10 }]);
  });

  it("a user colour change locks the colour", () => {
    const s = stateWith([], [{ id: 10, origin: "opener", title: "x" }]);
    const { state } = step(s, { type: "groupUpdated", group: { id: 10, windowId: 1, title: "x", color: "pink" } }, ctx());
    expect(state.groups[10].colorLocked).toBe(true);
  });

  it("with 'Name my own groups' on, an untitled user group is managed and queued for naming", () => {
    const { state, actions } = step(stateWith([]), { type: "groupCreated", group: { id: 5, windowId: 1, title: "", color: "red" } }, ctx(0, { nameUserGroups: true }));
    expect(state.groups[5]).toMatchObject({ origin: "user", managed: true, userNamed: false, dirty: true });
    expect(actions).toEqual([{ type: "dirty", groupId: 5 }]);
  });
});

describe("dirty triggers", () => {
  const base = () => stateWith([tab(1, { groupId: 10 }), tab(2, { groupId: 10 })], [{ id: 10, origin: "opener" }]);

  it("title change and path change mark the group dirty", () => {
    expect(step(base(), { type: "tabUpdated", tab: tab(1, { groupId: 10, title: "New" }) }, ctx()).actions).toEqual([{ type: "dirty", groupId: 10 }]);
    expect(step(base(), { type: "tabUpdated", tab: tab(1, { groupId: 10, url: "https://example.com/other" }) }, ctx()).actions).toEqual([{ type: "dirty", groupId: 10 }]);
  });

  it("reload, fragment and query changes do not", () => {
    expect(step(base(), { type: "tabUpdated", tab: tab(1, { groupId: 10, url: "https://example.com/1#top" }) }, ctx()).actions).toEqual([]);
    expect(step(base(), { type: "tabUpdated", tab: tab(1, { groupId: 10, url: "https://example.com/1?utm_source=x" }) }, ctx()).actions).toEqual([]);
    expect(step(base(), { type: "tabUpdated", tab: tab(1, { groupId: 10, status: "loading" }) }, ctx()).actions).toEqual([]);
  });

  it("a description arriving marks the group dirty; the same description again does not", () => {
    const r = step(base(), { type: "meta", tabId: 1, description: "  A   page about things " }, ctx());
    expect(r.actions).toEqual([{ type: "dirty", groupId: 10 }]);
    expect(r.state.tabs[1].description).toBe("A page about things");
    expect(step(r.state, { type: "meta", tabId: 1, description: "A page about things" }, ctx()).actions).toEqual([]);
  });

  it("activation refreshes lastActivatedAt only", () => {
    const r = step(base(), { type: "tabActivated", tabId: 2 }, ctx(5_000_000));
    expect(r.state.tabs[2].lastActivatedAt).toBe(5_000_000);
    expect(r.actions).toEqual([]);
  });

  it("step is pure: the input state is untouched", () => {
    const s = base();
    const before = JSON.stringify(s);
    step(s, { type: "tabRemoved", tabId: 1 }, ctx());
    expect(JSON.stringify(s)).toBe(before);
  });
});
