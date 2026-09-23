import { describe, expect, it } from "vitest";
import { addToArchive, archiveCandidates, excluded, HOUR, isParkCandidate, type TidyTab } from "../src/background/tidy";
import { newGroupRecord, type ArchivedTab } from "../src/background/state";
import { emptyState } from "../src/background/state";
import { settings } from "./helpers";

const NOW = 1_000 * HOUR;
const tt = (over: Partial<TidyTab> = {}): TidyTab => ({
  id: 1, windowId: 1, groupId: -1, index: 0, url: "https://example.com/a", pinned: false, active: false, lastAccessed: NOW - 25 * HOUR, ...over,
});

describe("park eligibility", () => {
  const s = emptyState();
  s.groups[10] = newGroupRecord(10, 1, "user", "red");
  s.groups[11] = newGroupRecord(11, 1, "opener", "red", { keep: true });
  s.groups[12] = newGroupRecord(12, 1, "tidy", "grey");
  s.groups[13] = newGroupRecord(13, 1, "organize", "red");
  const cfg = settings();

  it.each([
    ["idle 25 h, loose", tt(), true],
    ["idle 23 h", tt({ lastAccessed: NOW - 23 * HOUR }), false],
    ["pinned", tt({ pinned: true }), false],
    ["active", tt({ active: true }), false],
    ["audible", tt({ audible: true }), false],
    ["in a user group", tt({ groupId: 10 }), false],
    ["in a Keep group", tt({ groupId: 11 }), false],
    ["already parked", tt({ groupId: 12 }), false],
    ["in an organize group", tt({ groupId: 13 }), true],
    ["mail. excluded", tt({ url: "https://mail.google.com/x" }), false],
    ["localhost excluded", tt({ url: "http://localhost:3000/" }), false],
    ["internal page", tt({ url: "brave://settings" }), false],
  ])("%s", (_name, tab, expected) => {
    expect(isParkCandidate(tab, s, cfg, NOW)).toBe(expected);
  });

  it("user groups are eligible when 'Tidy inside my own groups' is on", () => {
    expect(isParkCandidate(tt({ groupId: 10 }), s, settings({ tidyUserGroups: true }), NOW)).toBe(true);
  });

  it("a recent activation recorded by the worker counts even if lastAccessed is old", () => {
    const s2 = emptyState();
    s2.tabs[1] = { id: 1, windowId: 1, groupId: -1, index: 0, url: "", title: "", pinned: false, createdAt: 0, lastActivatedAt: NOW - HOUR };
    expect(isParkCandidate(tt(), s2, cfg, NOW)).toBe(false);
  });

  it("exclusion patterns support /regex/", () => {
    expect(excluded("https://jira.corp.net/x", ["/corp\\.net/"])).toBe(true);
    expect(excluded("https://example.com", ["/corp\\.net/"])).toBe(false);
  });
});

describe("archive", () => {
  it("parked tabs idle past archiveAfter are archived; 0 means never", () => {
    const s = emptyState();
    s.groups[12] = newGroupRecord(12, 1, "tidy", "grey");
    const parked = tt({ groupId: 12, lastAccessed: NOW - 49 * HOUR });
    expect(archiveCandidates([parked, tt()], s, settings(), NOW)).toEqual([parked]);
    expect(archiveCandidates([parked], s, settings({ archiveAfterHours: 0 }), NOW)).toEqual([]);
  });

  it("is newest first and capped, oldest dropped", () => {
    const entry = (n: number): ArchivedTab => ({ url: `u${n}`, title: `t${n}`, archivedAt: n, lastActivatedAt: 0 });
    const existing = [3, 2, 1].map(entry);
    const out = addToArchive(existing, [entry(5), entry(4)], 4);
    expect(out.map((e) => e.archivedAt)).toEqual([5, 4, 3, 2]);
  });
});
