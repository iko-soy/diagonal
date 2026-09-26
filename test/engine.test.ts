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

  it("Cmd-click from a pinned tab spawns a plain tab, left to auto-organize", () => {
    const opener = tab(1, { pinned: true });
    const { actions } = step(stateWith([opener]), { type: "tabCreated", tab: tab(2, { openerTabId: 1 }), opener }, ctx());
    expect(actions).toEqual([{ type: "loose", windowId: 1 }]);
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
    const off = ctx(0, { openerGrouping: false, autoOrganize: false });
    expect(step(stateWith([opener]), { type: "tabCreated", tab: tab(2, { openerTabId: 1 }), opener }, off).actions).toEqual([]);
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

  it("organize groups dissolve at one member too", () => {
    const s = stateWith([tab(1, { groupId: 10 }), tab(2, { groupId: 10 })], [{ id: 10, origin: "organize" }]);
    const r1 = step(s, { type: "tabRemoved", tabId: 2 }, ctx());
    expect(r1.actions).toContainEqual({ type: "scheduleDissolve", groupId: 10, delayMs: DISSOLVE_DELAY_MS });
    expect(step(r1.state, { type: "dissolveCheck", groupId: 10, memberIds: [1] }, ctx()).actions).toEqual([{ type: "ungroup", tabIds: [1] }]);
  });

  it("a group you titled yourself is not dissolved", () => {
    const s = stateWith([tab(1, { groupId: 10 })], [{ id: 10, origin: "organize" }]);
    s.groups[10].userNamed = true;
    expect(step(s, { type: "dissolveCheck", groupId: 10, memberIds: [1] }, ctx()).actions).toEqual([]);
  });

  it("the Parked group is not dissolved", () => {
    const s = stateWith([tab(1, { groupId: 10 })], [{ id: 10, origin: "tidy" }]);
    expect(step(s, { type: "dissolveCheck", groupId: 10, memberIds: [1] }, ctx()).actions).toEqual([]);
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
    expect(step(base(), { type: "tabUpdated", tab: tab(1, { groupId: 10, url: "https://example.com/other" }) }, ctx()).actions).toEqual([
      { type: "checkFit" },
      { type: "dirty", groupId: 10 },
    ]);
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

describe("auto-organize triggers", () => {
  it("a new tab that navigates somewhere real asks for a look at its window", () => {
    const s = stateWith([tab(1, { url: "brave://newtab/" })]);
    const { actions } = step(s, { type: "tabUpdated", tab: tab(1, { url: "https://tokio.rs/" }) }, ctx());
    expect(actions).toEqual([{ type: "loose", windowId: 1 }]);
  });

  it("new tab pages, pinned tabs and grouped tabs do not", () => {
    expect(step(stateWith([]), { type: "tabCreated", tab: tab(1, { url: "brave://newtab/" }) }, ctx()).actions).toEqual([]);
    expect(step(stateWith([]), { type: "tabCreated", tab: tab(1, { pinned: true }) }, ctx()).actions).toEqual([]);
    const g = stateWith([tab(1, { groupId: 10 })], [{ id: 10, origin: "opener" }]);
    expect(step(g, { type: "tabUpdated", tab: tab(1, { groupId: 10, title: "new" }) }, ctx()).actions).not.toContainEqual({ type: "loose", windowId: 1 });
  });

  it("does nothing when auto-organize is off", () => {
    const s = stateWith([tab(1, { url: "brave://newtab/" })]);
    expect(step(s, { type: "tabUpdated", tab: tab(1, { url: "https://tokio.rs/" }) }, ctx(0, { autoOrganize: false })).actions).toEqual([]);
  });

  it("a tab you take out of a group stays loose until it goes to another page", () => {
    const s = stateWith([tab(1, { groupId: 10, url: "https://a.com/x" }), tab(2, { groupId: 10 }), tab(3, { groupId: 10 })], [{ id: 10, origin: "opener" }]);
    const r1 = step(s, { type: "tabUpdated", tab: tab(1, { url: "https://a.com/x" }) }, ctx());
    expect(r1.state.tabs[1].keepLoose).toBe("https://a.com/x");
    expect(r1.actions).not.toContainEqual({ type: "loose", windowId: 1 });
    const r2 = step(r1.state, { type: "tabUpdated", tab: tab(1, { url: "https://a.com/x", title: "retitled" }) }, ctx());
    expect(r2.actions).toEqual([]);
    const r3 = step(r2.state, { type: "tabUpdated", tab: tab(1, { url: "https://b.com/y" }) }, ctx());
    expect(r3.state.tabs[1].keepLoose).toBeUndefined();
    expect(r3.actions).toEqual([{ type: "loose", windowId: 1 }]);
  });

  it("a tab Diagonal ungrouped itself (dissolve) is fair game again", () => {
    const s = stateWith([tab(1, { groupId: 10 })], [{ id: 10, origin: "opener" }]);
    s.ownUngroups[1] = 999_000;
    const { state, actions } = step(s, { type: "tabUpdated", tab: tab(1) }, ctx());
    expect(state.tabs[1].keepLoose).toBeUndefined();
    expect(state.ownUngroups[1]).toBeUndefined();
    expect(actions).toContainEqual({ type: "loose", windowId: 1 });
  });

  it("parking keeps the title of the group the tab came from, for the archive", () => {
    const s = stateWith([tab(1, { groupId: 10 }), tab(2, { groupId: 20 })], [{ id: 10, origin: "organize", title: "Rust async" }, { id: 20, origin: "tidy" }]);
    s.tabs[1].parkedFrom = "Rust async"; // set by the sweep just before it moves the tab
    const moved = step(s, { type: "tabUpdated", tab: tab(1, { groupId: 20 }) }, ctx());
    const discarded = step(moved.state, { type: "tabUpdated", tab: tab(1, { groupId: 20, status: "unloaded" }) }, ctx());
    expect(discarded.state.tabs[1].parkedFrom).toBe("Rust async");
  });

  it("opening a parked tab takes it out of Parked", () => {
    const s = stateWith([tab(1, { groupId: 20 }), tab(2, { groupId: 20 })], [{ id: 20, origin: "tidy" }]);
    s.tabs[1].parkedFrom = "Rust async";
    const { state, actions } = step(s, { type: "tabActivated", tabId: 1 }, ctx());
    expect(actions).toEqual([{ type: "unpark", tabId: 1, groupId: 20 }]);
    expect(state.tabs[1].parkedFrom).toBeUndefined();
  });

  it("activating a tab anywhere else only records the time", () => {
    const s = stateWith([tab(1, { groupId: 10 })], [{ id: 10, origin: "organize" }]);
    const { state, actions } = step(s, { type: "tabActivated", tabId: 1 }, ctx(5_000_000));
    expect(actions).toEqual([]);
    expect(state.tabs[1].lastActivatedAt).toBe(5_000_000);
  });
});

describe("fit check", () => {
  const group = () => stateWith([tab(1, { groupId: 10 }), tab(2, { groupId: 10 }), tab(3, { groupId: 10 })], [{ id: 10, origin: "organize" }]);
  const moveOn = (s = group(), over = {}) =>
    step(s, { type: "tabUpdated", tab: tab(1, { groupId: 10, url: "https://news.example/story", ...over }) }, ctx());

  it("a tab in a Diagonal group that goes to a new page is checked once it has loaded", () => {
    const loading = moveOn(group(), { status: "loading" });
    expect(loading.state.tabs[1].fitPending).toBe(true);
    expect(loading.actions).not.toContainEqual({ type: "checkFit" });
    const loaded = step(loading.state, { type: "tabUpdated", tab: tab(1, { groupId: 10, url: "https://news.example/story" }) }, ctx());
    expect(loaded.actions).toContainEqual({ type: "checkFit" });
  });

  it("switching to another tab checks the pending one", () => {
    const { state } = moveOn(group(), { status: "loading" });
    expect(step(state, { type: "tabActivated", tabId: 2 }, ctx()).actions).toContainEqual({ type: "checkFit" });
    expect(step(state, { type: "tabActivated", tabId: 1 }, ctx()).actions).not.toContainEqual({ type: "checkFit" });
  });

  it("leaves groups you named and groups you made alone", () => {
    const named = group();
    named.groups[10].userNamed = true;
    expect(moveOn(named).state.tabs[1].fitPending).toBeUndefined();
    const yours = stateWith([tab(1, { groupId: 10 }), tab(2, { groupId: 10 })], [{ id: 10, origin: "user" }]);
    expect(moveOn(yours).state.tabs[1].fitPending).toBeUndefined();
    expect(moveOn(group(), {}).state.tabs[1].fitPending).toBe(true);
    const off = step(group(), { type: "tabUpdated", tab: tab(1, { groupId: 10, url: "https://news.example/story" }) }, ctx(0, { autoOrganize: false }));
    expect(off.state.tabs[1].fitPending).toBeUndefined();
  });

  it("a tab you dragged into a group stays there", () => {
    const s = stateWith([tab(1), tab(2, { groupId: 10 }), tab(3, { groupId: 10 })], [{ id: 10, origin: "organize" }]);
    const dragged = step(s, { type: "tabUpdated", tab: tab(1, { groupId: 10 }) }, ctx());
    expect(dragged.state.tabs[1].handPlaced).toBe(true);
    expect(moveOn(dragged.state).state.tabs[1].fitPending).toBeUndefined();
  });

  it("a tab Diagonal put in the group is still checked", () => {
    const s = stateWith([tab(1), tab(2, { groupId: 10 }), tab(3, { groupId: 10 })], [{ id: 10, origin: "organize" }]);
    s.ownAdds[1] = 1_000_000;
    const added = step(s, { type: "tabUpdated", tab: tab(1, { groupId: 10 }) }, ctx());
    expect(added.state.tabs[1].handPlaced).toBeUndefined();
    expect(added.state.ownAdds[1]).toBeUndefined();
    expect(moveOn(added.state).state.tabs[1].fitPending).toBe(true);
  });

  it("leaving the group clears both marks", () => {
    const pending = moveOn(group(), { status: "loading" }).state;
    pending.tabs[1].handPlaced = true;
    const out = step(pending, { type: "tabUpdated", tab: tab(1, { url: "https://news.example/story" }) }, ctx());
    expect(out.state.tabs[1].fitPending).toBeUndefined();
    expect(out.state.tabs[1].handPlaced).toBeUndefined();
  });
});

describe("groups Chromium removes and brings back", () => {
  const opener = () => {
    const s = stateWith([tab(1, { groupId: 10 }), tab(2, { groupId: 10 })], [{ id: 10, origin: "opener", title: "🦀 Rust async" }]);
    s.groups[10].color = "orange";
    return s;
  };
  const run = (s: ReturnType<typeof opener>, events: Parameters<typeof step>[1][], now = 1_000_000) =>
    events.reduce((acc, e) => step(acc, e, ctx(now)).state, s);

  it("a group moved to another window stays Diagonal's, and its tabs are not taken for your choices", () => {
    const moved = run(opener(), [
      { type: "groupRemoved", groupId: 10 },
      { type: "tabUpdated", tab: tab(1) },
      { type: "tabUpdated", tab: tab(2) },
      { type: "groupCreated", group: { id: 10, windowId: 2, title: "🦀 Rust async", color: "orange" } },
      { type: "tabUpdated", tab: tab(1, { groupId: 10, windowId: 2 }) },
      { type: "tabUpdated", tab: tab(2, { groupId: 10, windowId: 2 }) },
    ]);
    expect(moved.groups[10]).toMatchObject({ origin: "opener", managed: true, userNamed: false, windowId: 2 });
    for (const id of [1, 2]) {
      expect(moved.tabs[id].groupId).toBe(10);
      expect(moved.tabs[id].keepLoose).toBeUndefined();
      expect(moved.tabs[id].handPlaced).toBeUndefined();
    }
    expect(moved.removedGroups[10]).toBeUndefined();
  });

  it("the same when a tab's new group is reported before the group itself", () => {
    const moved = run(opener(), [
      { type: "groupRemoved", groupId: 10 },
      { type: "tabUpdated", tab: tab(1) },
      { type: "tabUpdated", tab: tab(1, { groupId: 10, windowId: 2 }) },
      { type: "groupCreated", group: { id: 10, windowId: 2, title: "🦀 Rust async", color: "orange" } },
    ]);
    expect(moved.groups[10].origin).toBe("opener");
    expect(moved.tabs[1].keepLoose).toBeUndefined();
    expect(moved.tabs[1].handPlaced).toBeUndefined();
  });

  it("a closed group reopened untitled, then titled, is Diagonal's again", () => {
    const closed = run(opener(), [
      { type: "tabRemoved", tabId: 1 },
      { type: "tabRemoved", tabId: 2 },
      { type: "groupRemoved", groupId: 10 },
    ]);
    const later = 1_000_000 + 3_600_000;
    const back = run(closed, [
      { type: "groupCreated", group: { id: 77, windowId: 1, title: "", color: "orange" } },
      { type: "groupUpdated", group: { id: 77, windowId: 1, title: "🦀 Rust async", color: "orange" } },
    ], later);
    expect(back.groups[77]).toMatchObject({ origin: "opener", managed: true, userNamed: false, stripTitle: "🦀 Rust async" });
  });

  it("a group you make and title yourself later is still yours", () => {
    const closed = run(opener(), [{ type: "groupRemoved", groupId: 10 }]);
    const made = run(closed, [{ type: "groupCreated", group: { id: 77, windowId: 1, title: "", color: "orange" } }]);
    const titled = step(made, { type: "groupUpdated", group: { id: 77, windowId: 1, title: "🦀 Rust async", color: "orange" } }, ctx(1_000_000 + 60_000)).state;
    expect(titled.groups[77]).toMatchObject({ origin: "user", userNamed: true });
  });

  it("ungrouping by hand still keeps the tabs loose", () => {
    const out = run(opener(), [
      { type: "tabUpdated", tab: tab(1) },
      { type: "tabUpdated", tab: tab(2) },
      { type: "groupRemoved", groupId: 10 },
    ]);
    expect(out.tabs[1].keepLoose).toBe("https://example.com/1");
  });

  it("keeps a day of removed groups, at most 20", () => {
    let s = opener();
    for (let id = 100; id < 125; id++) {
      s.groups[id] = { ...s.groups[10], id };
      s = step(s, { type: "groupRemoved", groupId: id }, ctx(1_000_000 + id)).state;
    }
    expect(Object.keys(s.removedGroups)).toHaveLength(20);
    s = step(s, { type: "tabActivated", tabId: 1 }, ctx(1_000_000 + 25 * 3_600_000)).state;
    expect(Object.keys(s.removedGroups)).toHaveLength(0);
  });
});

describe("tabs you place", () => {
  it("a new tab made inside a group ('New tab in group') is yours there", () => {
    const s = stateWith([tab(1, { groupId: 10 }), tab(2, { groupId: 10 })], [{ id: 10, origin: "organize" }]);
    const { state } = step(s, { type: "tabCreated", tab: tab(3, { groupId: 10, url: "brave://newtab/" }) }, ctx());
    expect(state.tabs[3].handPlaced).toBe(true);
  });

  it("a link opened from a grouped tab is not", () => {
    const opener = tab(1, { groupId: 10 });
    const s = stateWith([opener, tab(2, { groupId: 10 })], [{ id: 10, origin: "organize" }]);
    const { state } = step(s, { type: "tabCreated", tab: tab(3, { groupId: 10, openerTabId: 1 }), opener }, ctx());
    expect(state.tabs[3].handPlaced).toBeUndefined();
  });

  it("a tab that joins a group has no loose choice left, even if a late event said it left", () => {
    const s = stateWith([tab(1), tab(2)], [{ id: 10, origin: "opener" }]);
    s.tabs[1].keepLoose = "https://example.com/1";
    s.ownAdds[1] = 1_000_000;
    const { state } = step(s, { type: "tabUpdated", tab: tab(1, { groupId: 10 }) }, ctx());
    expect(state.tabs[1].keepLoose).toBeUndefined();
  });

  it("a new tab whose first load redirects is not fit-checked", () => {
    const s = stateWith([tab(1, { groupId: 10 }), tab(2, { groupId: 10 }), tab(3, { groupId: 10 })], [{ id: 10, origin: "opener" }]);
    const opened = step(s, { type: "tabCreated", tab: tab(4, { groupId: 10, openerTabId: 1, url: "", pendingUrl: "http://blog.example.org/post", status: "loading" }), opener: tab(1, { groupId: 10 }) }, ctx()).state;
    const landed = step(opened, { type: "tabUpdated", tab: tab(4, { groupId: 10, openerTabId: 1, url: "https://blog.example.org/post" }) }, ctx());
    expect(landed.state.tabs[4].fitPending).toBeUndefined();
  });

  it("leaving Parked stops the archive clock", () => {
    const s = stateWith([tab(1, { groupId: 20 }), tab(2, { groupId: 20 })], [{ id: 20, origin: "tidy" }]);
    s.tabs[1].parkedAt = 5;
    expect(step(s, { type: "tabUpdated", tab: tab(1) }, ctx()).state.tabs[1].parkedAt).toBeUndefined();
    expect(step(s, { type: "tabActivated", tabId: 1 }, ctx()).state.tabs[1].parkedAt).toBeUndefined();
  });
});
