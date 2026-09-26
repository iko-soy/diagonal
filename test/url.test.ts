import { describe, expect, it } from "vitest";
import { isValidLabel, labelOf, repairLabel, safeEmoji, titleKey } from "../src/shared/label";
import { colorFor, hostname, isInternalUrl, promptAddress, promptUrl, provisionalTitle, registrableDomain, trimText } from "../src/shared/url";
import { withDefaults } from "../src/background/settings";
import labelCases from "../host/tests/golden/labels.json";

describe("url helpers", () => {
  it("strips www.", () => {
    expect(hostname("https://www.github.com/x")).toBe("github.com");
    expect(provisionalTitle("https://www.github.com/rust-lang")).toBe("github.com");
  });

  it("keeps the query when the path is empty, drops tracking keys elsewhere, keeps content keys", () => {
    expect(promptAddress("https://www.example.com/?q=rust")).toBe("example.com?q=rust");
    expect(promptAddress("https://www.youtube.com/watch?v=abc123&utm_source=x&t=10#frag")).toBe("youtube.com/watch?v=abc123");
    expect(promptAddress("https://blog.example.com/post/1?utm_medium=email&fbclid=zz")).toBe("blog.example.com/post/1");
  });

  it("cuts the address at 160 characters", () => {
    expect(promptAddress(`https://example.com/${"a".repeat(400)}`)).toHaveLength(160);
  });

  it("hostname only when full URLs are off", () => {
    expect(promptUrl("https://docs.rs/tokio/latest/tokio/", false)).toBe("https://docs.rs");
  });

  it("registrable domain handles common two-label suffixes", () => {
    expect(registrableDomain("https://news.bbc.co.uk/x")).toBe("bbc.co.uk");
    expect(registrableDomain("https://gist.github.com/")).toBe("github.com");
    expect(registrableDomain("https://me.github.io/")).toBe("me.github.io");
  });

  it("the same site always gets the same colour, never grey", () => {
    expect(colorFor("https://github.com/a")).toBe(colorFor("https://gist.github.com/b"));
    for (const u of ["https://a.com", "https://b.org", "https://c.net", "https://d.io", "https://e.dev"]) expect(colorFor(u)).not.toBe("grey");
  });

  it("internal pages are recognised", () => {
    for (const u of ["brave://newtab/", "chrome://settings", "chrome-extension://abc/x.html", "file:///tmp", "about:blank", ""]) expect(isInternalUrl(u)).toBe(true);
    expect(isInternalUrl("https://a.com")).toBe(false);
  });

  it("trims text on a word boundary", () => {
    expect(trimText("one two three four", 10)).toBe("one two");
    expect(trimText("  a \n b  ", 300)).toBe("a b");
  });
});

// The same cases run against the host's validate.repair_label, so the two sides agree on every label.
const LABEL_CASES = labelCases as [string, string | null][];

describe("labels", () => {
  it.each(LABEL_CASES)("repairs %s", (raw, fixed) => {
    expect(repairLabel(raw) ?? null).toBe(fixed);
  });

  it("validates", () => {
    expect(isValidLabel("Lisbon trip")).toBe(true);
    expect(isValidLabel("Lisbon")).toBe(false);
    expect(isValidLabel("日本旅行")).toBe(true);
    expect(isValidLabel("京都の旅行計画")).toBe(true);
    expect(isValidLabel("日")).toBe(false);
    expect(repairLabel("日本旅行。")).toBe("日本旅行");
  });

  it("emoji outside the list fall back; FE0F is optional", () => {
    expect(safeEmoji("✈")).toBe("✈️");
    expect(safeEmoji("🦄")).toBe("🧭");
  });

  it("titleKey ignores the unread counts and bullets sites put in titles", () => {
    expect(titleKey("(3) Inbox - Mail")).toBe(titleKey("(12) Inbox - Mail"));
    expect(titleKey("Inbox (1,204) - me@example.com - Gmail")).toBe("Inbox - me@example.com - Gmail");
    expect(titleKey("• Slack | general")).toBe("Slack | general");
    expect(titleKey("[99+] Chat")).toBe("Chat");
    expect(titleKey("Rust async")).toBe("Rust async");
    expect(titleKey("Rust async")).not.toBe(titleKey("Rust sync"));
  });

  it("labelOf strips our emoji prefix", () => {
    expect(labelOf("🦀 Rust async")).toBe("Rust async");
    expect(labelOf("Plain title")).toBe("Plain title");
  });
});

describe("settings", () => {
  it("fills defaults and clamps", () => {
    const s = withDefaults({ namingDebounceMs: 10, tidyMode: "weird", emoji: false, tidyExclusions: ["a", "", 3] });
    expect(s.namingDebounceMs).toBe(1000);
    expect(s.tidyMode).toBe("auto");
    expect(s.emoji).toBe(false);
    expect(s.tidyExclusions).toEqual(["a"]);
    expect(withDefaults(undefined).parkAfterHours).toBe(24);
  });
});
