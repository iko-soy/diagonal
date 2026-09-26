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

  it("a Diagonal group you renamed counts as yours", () => {
    const s2 = emptyState();
    s2.groups[14] = newGroupRecord(14, 1, "organize", "red", { userNamed: true, stripTitle: "Tax 2026" });
    expect(isParkCandidate(tt({ groupId: 14 }), s2, cfg, NOW)).toBe(false);
    expect(isParkCandidate(tt({ groupId: 14 }), s2, settings({ tidyUserGroups: true }), NOW)).toBe(true);
  });

  it("after a restart, the stored last use wins over Chromium's restore time", () => {
    const s2 = emptyState();
    s2.tabs[1] = { id: 1, windowId: 1, groupId: -1, index: 0, url: "", title: "", pinned: false, createdAt: 0, lastActivatedAt: NOW - 30 * HOUR };
    expect(isParkCandidate(tt({ lastAccessed: NOW - 60_000 }), s2, cfg, NOW)).toBe(true);
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
  const record = (id: number, over: object = {}) => ({ id, windowId: 1, groupId: 12, index: 0, url: "", title: "", pinned: false, createdAt: 0, lastActivatedAt: NOW - 60 * HOUR, ...over });

  it("parked tabs that sat in Parked past archiveAfter are archived; 0 means never", () => {
    const s = emptyState();
    s.groups[12] = newGroupRecord(12, 1, "tidy", "grey");
    s.tabs[1] = record(1, { parkedAt: NOW - 49 * HOUR });
    const parked = tt({ groupId: 12, lastAccessed: NOW - 60 * HOUR });
    expect(archiveCandidates([parked, tt({ id: 2 })], s, settings(), NOW)).toEqual([parked]);
    expect(archiveCandidates([parked], s, settings({ archiveAfterHours: 0 }), NOW)).toEqual([]);
  });

  it("counts from when the tab was parked, not from when it was last used", () => {
    const s = emptyState();
    s.groups[12] = newGroupRecord(12, 1, "tidy", "grey");
    s.tabs[1] = record(1, { parkedAt: NOW - HOUR }); // unused for 60 h, but parked only an hour ago
    s.tabs[2] = record(2); // in Parked with no parking time: its clock has not started
    expect(archiveCandidates([tt({ groupId: 12, lastAccessed: NOW - 60 * HOUR }), tt({ id: 2, groupId: 12 })], s, settings(), NOW)).toEqual([]);
  });

  it("an address added to Never tidy is not closed from Parked", () => {
    const s = emptyState();
    s.groups[12] = newGroupRecord(12, 1, "tidy", "grey");
    s.tabs[1] = record(1, { parkedAt: NOW - 49 * HOUR });
    expect(archiveCandidates([tt({ groupId: 12, url: "https://jira.corp/x" })], s, settings({ tidyExclusions: ["jira."] }), NOW)).toEqual([]);
  });

  it("is newest first and capped, oldest dropped", () => {
    const entry = (n: number): ArchivedTab => ({ url: `u${n}`, title: `t${n}`, archivedAt: n, lastActivatedAt: 0 });
    const existing = [3, 2, 1].map(entry);
    const out = addToArchive(existing, [entry(5), entry(4)], 4);
    expect(out.map((e) => e.archivedAt)).toEqual([5, 4, 3, 2]);
  });
});
