import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostReply } from "../src/background/host";
import {
  buildNamePayload, membersHash, Naming, sampleMembers, shouldApply, suffixLabel, type Member, type NamePayload, type NameResult,
} from "../src/background/naming";
import { markDirty, newGroupRecord, type State } from "../src/background/state";
import { emptyState } from "../src/background/state";
import { settings } from "./helpers";

const member = (id: number, over: Partial<Member> = {}): Member => ({
  id, index: id, url: `https://docs.rs/crate${id}`, title: `Crate ${id}`, status: "complete", lastActive: 0, ...over,
});

describe("membership hash", () => {
  it("is stable under reorder and changes with a title", () => {
    const a = [member(1), member(2), member(3)];
    expect(membersHash(a)).toBe(membersHash([a[2], a[0], a[1]]));
    expect(membersHash(a)).not.toBe(membersHash([a[0], a[1], { ...a[2], title: "Other" }]));
  });
});

describe("large group sampling", () => {
  it("sends the 16 most recent, the first 16 and the last 16, in strip order, capped at 48", () => {
    const ms = Array.from({ length: 80 }, (_, i) => member(i, { lastActive: i === 40 || i === 41 ? 1000 + i : i }));
    const picked = sampleMembers(ms);
    expect(picked.length).toBeLessThanOrEqual(48);
    const ids = picked.map((m) => m.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    for (const id of [0, 15, 64, 79, 40, 41]) expect(ids).toContain(id);
    expect(ids).not.toContain(30);
  });

  it("leaves small groups whole", () => {
    expect(sampleMembers([member(2), member(1)]).map((m) => m.id)).toEqual([1, 2]);
  });
});

describe("evolving-name policy", () => {
  const g = () => newGroupRecord(1, 1, "opener", "blue", { title: "Rust async runtimes", lastNamedAt: 1, memberUrls: ["a", "b"] });

  it("first name always applies", () => {
    expect(shouldApply(newGroupRecord(1, 1, "opener", "blue"), "Rust async", ["a"])).toBe(true);
  });
  it("sticky title: unchanged membership keeps the old title even if the model paraphrased", () => {
    expect(shouldApply(g(), "Tokio and async-std", ["a", "b"])).toBe(false);
  });
  it("changed membership with a different label renames", () => {
    expect(shouldApply(g(), "Rust web servers", ["a", "b", "c"])).toBe(true);
  });
  it("same label is never rewritten", () => {
    expect(shouldApply(g(), "rust async runtimes", ["a", "b", "c"])).toBe(false);
  });
  it("a member that only moved within its page is not a membership change", () => {
    const g2 = newGroupRecord(1, 1, "opener", "blue", { title: "Rust async runtimes", lastNamedAt: 1, memberUrls: ["https://a.com/x", "https://b.com/y"] });
    expect(shouldApply(g2, "Tokio and async-std", ["https://a.com/x?page=2", "https://b.com/y#top"])).toBe(false);
  });
  it("user-named groups are skipped", () => {
    expect(shouldApply({ ...g(), userNamed: true }, "Anything else", ["x"])).toBe(false);
  });
});

describe("suffixes", () => {
  it("adds a number that keeps the label unique and within 28 characters", () => {
    expect(suffixLabel("Rust docs", ["Rust docs"])).toBe("Rust docs 2");
    expect(suffixLabel("Rust docs", ["Rust docs", "Rust docs 2"])).toBe("Rust docs 3");
    expect(suffixLabel("Machine learning papers today", ["Machine learning papers today"]).length).toBeLessThanOrEqual(28);
  });
});

describe("payload", () => {
  it("carries the current title and sibling titles, never ids", () => {
    const s = emptyState();
    s.groups[1] = newGroupRecord(1, 1, "opener", "blue", { title: "Rust async", stripTitle: "🦀 Rust async" });
    s.groups[2] = newGroupRecord(2, 1, "organize", "red", { stripTitle: "✈️ Lisbon trip" });
    s.groups[3] = newGroupRecord(3, 2, "organize", "red", { stripTitle: "🎬 Other window" });
    const p = buildNamePayload(s, s.groups[1], [member(1, { description: "d" }), member(2)], settings());
    expect(p.currentTitle).toBe("Rust async");
    expect(p.siblingTitles).toEqual(["Lisbon trip"]);
    expect(p.items[0]).toEqual({ i: 0, title: "Crate 1", url: "https://docs.rs/crate1", description: "d" });
    expect(JSON.stringify(p)).not.toContain('"id"');
  });

  it("drops descriptions and paths when the privacy settings say so", () => {
    const s = emptyState();
    s.groups[1] = newGroupRecord(1, 1, "opener", "blue");
    const p = buildNamePayload(s, s.groups[1], [member(1, { description: "d" })], settings({ sendDescription: false, sendFullUrl: false }));
    expect(p.items[0]).toEqual({ i: 0, title: "Crate 1", url: "https://docs.rs" });
  });
});

describe("naming queue", () => {
  let state: State;
  let members: Member[];
  let calls: NamePayload[];
  let replies: HostReply<NameResult>[];
  let writes: [number, string][];
  let naming: Naming;
  let now: number;

  beforeEach(() => {
    vi.useFakeTimers();
    now = 1_000_000;
    state = emptyState();
    state.groups[7] = newGroupRecord(7, 1, "opener", "blue", { stripTitle: "docs.rs" });
    markDirty(state.groups[7], now);
    members = [member(1), member(2)];
    calls = [];
    writes = [];
    replies = [];
    naming = new Naming({
      now: () => now,
      state: () => state,
      settings: () => settings(),
      commit: () => undefined,
      liveMembers: async () => members,
      callName: async (p) => {
        calls.push(p);
        return replies.shift() ?? { ok: true, result: { title: "Rust crate docs", emoji: "🦀" } };
      },
      writeTitle: async (id, title) => {
        writes.push([id, title]);
        return true;
      },
      scheduleFallback: () => undefined,
      busy: () => undefined,
      hostFailed: () => undefined,
      hostOk: () => undefined,
      log: () => undefined,
    });
  });
  afterEach(() => vi.useRealTimers());

  const settle = async () => {
    await vi.advanceTimersByTimeAsync(5000);
    await vi.runAllTimersAsync();
  };

  it("coalesces three dirty events into one request and writes emoji + label", async () => {
    naming.touch(7);
    await vi.advanceTimersByTimeAsync(1000);
    naming.touch(7);
    await vi.advanceTimersByTimeAsync(1000);
    naming.touch(7);
    await settle();
    expect(calls).toHaveLength(1);
    expect(writes).toEqual([[7, "🦀 Rust crate docs"]]);
    expect(state.groups[7]).toMatchObject({ title: "Rust crate docs", emoji: "🦀", dirty: false });
  });

  it("skips the model when the membership hash is unchanged", async () => {
    state.groups[7].membersHash = membersHash(members);
    naming.touch(7);
    await settle();
    expect(calls).toHaveLength(0);
    expect(state.groups[7].dirty).toBe(false);
  });

  it("waits while a member is still loading", async () => {
    members = [member(1), member(2, { status: "loading" })];
    naming.touch(7);
    await settle();
    expect(calls).toHaveLength(0);
    expect(state.groups[7].dirty).toBe(true);
  });

  it("a group with one tab to name from is not kept waiting; the next tab to join names it", async () => {
    members = [member(1)];
    naming.touch(7);
    await settle();
    expect(calls).toHaveLength(0);
    expect(state.groups[7].dirty).toBe(false);
    members = [member(1), member(2)];
    markDirty(state.groups[7], 0);
    naming.touch(7);
    await settle();
    expect(calls).toHaveLength(1);
  });

  it("names a group whose member the browser discarded to save memory", async () => {
    members = [member(1), member(2, { status: "unloaded" })];
    naming.touch(7);
    await settle();
    expect(calls).toHaveLength(1);
    expect(state.groups[7].dirty).toBe(false);
  });

  it("new-tab pages do not count as members", async () => {
    members = [member(1), member(2, { url: "brave://newtab/" })];
    naming.touch(7);
    await settle();
    expect(calls).toHaveLength(0);
  });

  it("retries once with mustDifferFrom on a sibling collision, then suffixes", async () => {
    state.groups[8] = newGroupRecord(8, 1, "organize", "red", { stripTitle: "🦀 Rust crate docs", title: "Rust crate docs" });
    naming.touch(7);
    await settle();
    expect(calls).toHaveLength(2);
    expect(calls[1].mustDifferFrom).toEqual(["Rust crate docs"]);
    expect(writes).toEqual([[7, "🦀 Rust crate docs 2"]]);
  });

  it("OVER_BUDGET halves the items and retries once", async () => {
    members = Array.from({ length: 20 }, (_, i) => member(i));
    replies.push({ ok: false, error: { code: "OVER_BUDGET", message: "too long" } });
    naming.touch(7);
    await settle();
    expect(calls[0].items).toHaveLength(20);
    expect(calls[1].items.length).toBeLessThanOrEqual(10);
    expect(writes).toHaveLength(1);
  });

  it("GUARDRAIL retries once without descriptions, then parks the group for 24 h", async () => {
    members = [member(1, { description: "x" }), member(2)];
    replies.push({ ok: false, error: { code: "GUARDRAIL", message: "no" } }, { ok: false, error: { code: "GUARDRAIL", message: "no" } });
    naming.touch(7);
    await settle();
    expect(calls[0].items[0].description).toBe("x");
    expect(calls[1].items[0].description).toBeUndefined();
    expect(state.groups[7].nextAttemptAt).toBe(now + 24 * 3_600_000);
  });

  it("a group Apple's filter refused is asked again as soon as its tabs change, not only after a day", async () => {
    replies.push({ ok: false, error: { code: "GUARDRAIL", message: "no" } }, { ok: false, error: { code: "GUARDRAIL", message: "no" } });
    naming.touch(7);
    await settle();
    expect(calls).toHaveLength(2);
    naming.touch(7);
    await settle();
    expect(calls).toHaveLength(2); // the same tabs: still refused
    members = [member(1), member(3)];
    naming.touch(7);
    await settle();
    expect(calls).toHaveLength(3);
    expect(state.groups[7]).toMatchObject({ title: "Rust crate docs", dirty: false, nameAttempts: 0 });
    expect(state.groups[7].refusedHash).toBeUndefined();
  });

  it("setup errors don't use up a group's retries; the host's recovery picks it up", async () => {
    replies.push({ ok: false, error: { code: "LICENSE_REQUIRED", message: "terms" } });
    naming.touch(7);
    await settle();
    expect(state.groups[7]).toMatchObject({ dirty: true, nameAttempts: 0 });
    expect(state.groups[7].firstFailureAt).toBeUndefined();
    expect(state.groups[7].nextAttemptAt).toBeUndefined();
  });

  it("a title the strip would not take is tried again shortly", async () => {
    let refuse = true;
    naming = new Naming({ ...(naming as any).d, writeTitle: async () => !refuse });
    naming.touch(7);
    await settle();
    expect(state.groups[7]).toMatchObject({ dirty: true, nextAttemptAt: now + 30_000 });
    expect(state.groups[7].title).toBeUndefined();
    expect(state.ownWrites[7]).toBeUndefined();
    refuse = false;
    now += 30_000;
    await naming.consider(7);
    await settle();
    expect(state.groups[7]).toMatchObject({ dirty: false, title: "Rust crate docs" });
  });

  it("members back as they were last named clear old failures", async () => {
    Object.assign(state.groups[7], { membersHash: membersHash(members), nameAttempts: 3, firstFailureAt: 1, nextAttemptAt: 1 });
    naming.touch(7);
    await settle();
    expect(state.groups[7]).toMatchObject({ dirty: false, nameAttempts: 0 });
    expect(state.groups[7].firstFailureAt).toBeUndefined();
  });

  it("failures back off 30 s, 2 min, 10 min, then hourly; the title is left alone", async () => {
    const fail: HostReply<NameResult> = { ok: false, error: { code: "FM_ERROR", message: "boom" } };
    replies.push(fail);
    naming.touch(7);
    await settle();
    expect(writes).toEqual([]);
    expect(state.groups[7]).toMatchObject({ nameAttempts: 1, nextAttemptAt: now + 30_000, dirty: true });
    for (const expected of [120_000, 600_000, 3_600_000, 3_600_000]) {
      replies.push(fail);
      now = state.groups[7].nextAttemptAt!;
      await naming.consider(7);
      await settle();
      expect(state.groups[7].nextAttemptAt).toBe(now + expected);
    }
  });

  it("a malformed title is retried once in strict mode", async () => {
    const strict: boolean[] = [];
    const n = new Naming({
      ...(naming as any).d,
      callName: async (_p: NamePayload, o: { strict?: boolean }) => {
        strict.push(!!o.strict);
        return strict.length === 1 ? { ok: true, result: { title: "Tabs", emoji: "x" } } : { ok: true, result: { title: "Rust crates", emoji: "🦀" } };
      },
    });
    n.touch(7);
    await settle();
    expect(strict).toEqual([false, true]);
    expect(writes).toEqual([[7, "🦀 Rust crates"]]);
  });

  it("the retry after a title the host rejected lists that title as not allowed", async () => {
    replies.push({ ok: false, error: { code: "BAD_MODEL_OUTPUT", message: "rules", raw: JSON.stringify({ title: "Python", emoji: "🐍" }) } });
    naming.touch(7);
    await settle();
    expect(calls).toHaveLength(2);
    expect(calls[1].mustDifferFrom).toEqual(["Python"]);
  });

  it("a group renamed by hand while the model runs keeps the user's title", async () => {
    const n = new Naming({
      ...(naming as any).d,
      callName: async () => {
        state.groups[7].userNamed = true;
        return { ok: true, result: { title: "Rust crate docs", emoji: "🦀" } };
      },
    });
    n.touch(7);
    await settle();
    expect(writes).toEqual([]);
  });

  it("a group dirtied during the call is re-queued with its new membership", async () => {
    let first = true;
    const n = new Naming({
      ...(naming as any).d,
      callName: async (p: NamePayload) => {
        calls.push(p);
        if (first) {
          first = false;
          members = [...members, member(3)];
          markDirty(state.groups[7], now);
        }
        return { ok: true, result: { title: calls.length === 1 ? "Rust crate docs" : "Rust crates and more", emoji: "🦀" } };
      },
    });
    n.touch(7);
    await settle();
    expect(calls).toHaveLength(2);
    expect(calls[1].items).toHaveLength(3);
    expect(state.groups[7].dirty).toBe(false);
  });

  it("user-named and tidy groups are never sent", async () => {
    state.groups[7].userNamed = true;
    naming.touch(7);
    state.groups[9] = newGroupRecord(9, 1, "tidy", "grey");
    markDirty(state.groups[9], now);
    naming.touch(9);
    await settle();
    expect(calls).toHaveLength(0);
  });

  it("Name now bypasses the debounce and the hash check", async () => {
    state.groups[7].membersHash = membersHash(members);
    await naming.nameNow(7);
    await vi.runAllTimersAsync();
    expect(calls).toHaveLength(1);
  });
});
