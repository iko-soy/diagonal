import { describe, expect, it } from "vitest";
import { isValidLabel, labelOf, repairLabel, safeEmoji } from "../src/shared/label";
import { colorFor, hostname, isInternalUrl, promptAddress, promptUrl, provisionalTitle, registrableDomain, trimText } from "../src/shared/url";
import { withDefaults } from "../src/background/settings";

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

describe("labels", () => {
  it.each([
    ['"Rust async runtimes."', "Rust async runtimes"],
    ["rust async runtimes", "Rust async runtimes"],
    ["Rust tabs and docs", "Rust and docs"],
    ["One two three four five six", "One two three four"],
    ["Machine learning research papers reading list", "Machine learning research"],
  ])("repairs %s", (raw, fixed) => {
    expect(repairLabel(raw)).toBe(fixed);
  });

  it.each(["Tabs", "Misc stuff", "", "x", "Supercalifragilisticexpialidocious extraordinarily"])("rejects %s", (raw) => {
    expect(repairLabel(raw)).toBeUndefined();
  });

  it("validates", () => {
    expect(isValidLabel("Lisbon trip")).toBe(true);
    expect(isValidLabel("Lisbon")).toBe(false);
  });

  it("emoji outside the list fall back; FE0F is optional", () => {
    expect(safeEmoji("✈")).toBe("✈️");
    expect(safeEmoji("🦄")).toBe("🧭");
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
    expect(s.tidyMode).toBe("ask");
    expect(s.emoji).toBe(false);
    expect(s.tidyExclusions).toEqual(["a"]);
    expect(withDefaults(undefined).parkAfterHours).toBe(24);
  });
});
