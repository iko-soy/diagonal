import { describe, expect, it } from "vitest";
import { compareVersions, readDisk, shouldReload } from "../src/background/selfupdate";

describe("compareVersions", () => {
  it("compares numerically, ignoring leading zeros", () => {
    expect(compareVersions("2026.09.24.0512", "2026.9.24.512")).toBe(0);
    expect(compareVersions("2026.09.24.0512", "2026.09.23.2039")).toBeGreaterThan(0);
    expect(compareVersions("0.1.0", "2026.09.23.2039")).toBeLessThan(0);
    expect(compareVersions("1.2", "1.2.0.1")).toBeLessThan(0);
  });
});

describe("shouldReload", () => {
  const base = { running: "2026.09.23.2039", filesReady: true };
  it("reloads when a newer version is on disk", () => {
    expect(shouldReload({ ...base, onDisk: "2026.09.24.0512" })).toBe(true);
  });
  it("stays put for the same or an older version", () => {
    expect(shouldReload({ ...base, onDisk: "2026.09.23.2039" })).toBe(false);
    expect(shouldReload({ ...base, onDisk: "2026.09.22.1000" })).toBe(false);
  });
  it("waits while the folder is mid-copy or unreadable", () => {
    expect(shouldReload({ ...base, onDisk: "2026.09.24.0512", filesReady: false })).toBe(false);
    expect(shouldReload({ ...base, onDisk: undefined })).toBe(false);
    expect(shouldReload({ ...base, onDisk: "garbage" })).toBe(false);
  });
  it("tries each on-disk version once, so a failed reload cannot loop", () => {
    expect(shouldReload({ ...base, onDisk: "2026.09.24.0512", lastTried: "2026.09.24.0512" })).toBe(false);
    expect(shouldReload({ ...base, onDisk: "2026.09.25.0100", lastTried: "2026.09.24.0512" })).toBe(true);
  });
});

describe("readDisk", () => {
  const url = (p: string) => `chrome-extension://x/${p}`;
  const res = (body: string, ok = true) => ({ ok, json: async () => JSON.parse(body), text: async () => body }) as Response;
  it("reads the manifest version when both files are there", async () => {
    const f = (async (u: string) => (u.endsWith("manifest.json") ? res('{"version":"2026.09.24.0512"}') : res("code"))) as typeof fetch;
    expect(await readDisk(f, url)).toEqual({ onDisk: "2026.09.24.0512", filesReady: true });
  });
  it("is not ready when a file is missing or the manifest is half-written", async () => {
    const missing = (async (u: string) => (u.endsWith("manifest.json") ? res("{}") : res("", false))) as typeof fetch;
    expect((await readDisk(missing, url)).filesReady).toBe(false);
    const half = (async (u: string) => (u.endsWith("manifest.json") ? res('{"vers') : res("code"))) as typeof fetch;
    expect((await readDisk(half, url)).filesReady).toBe(false);
  });
});
