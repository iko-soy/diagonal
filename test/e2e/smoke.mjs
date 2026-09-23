// End-to-end smoke test: loads dist/ into Chromium with the real native host (host/grove-host.py)
// wired to a keyword-driven fake fm, then drives opener grouping, naming, a user rename, dissolve,
// Organize and the popup. Linux only (native host manifests live under the profile directory).
//   node test/e2e/smoke.mjs      (after npm run build)
import { chromium } from "playwright-core";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const dist = join(root, "dist");
const extId = readFileSync(join(root, "extension-id"), "utf8").trim();
const tmp = mkdtempSync(join(tmpdir(), "grove-smoke-"));
const python = execFileSync("python3", ["-c", "import sys; print(sys.executable)"]).toString().trim();
const shotDir = process.env.SMOKE_SHOTS || join(tmp, "shots");
mkdirSync(shotDir, { recursive: true });

// Host install, as scripts/install-manifest.sh would do it, into the temp profile.
const hostDir = join(tmp, "host");
mkdirSync(hostDir);
for (const f of ["prompts.py", "validate.py", "emoji.txt"]) cpSync(join(root, "host", f), join(hostDir, f));
writeFileSync(join(hostDir, "grove-host.py"), readFileSync(join(root, "host/grove-host.py"), "utf8").replace(/^#!.*$/m, `#!${python}`));
chmodSync(join(hostDir, "grove-host.py"), 0o755);
const fm = join(tmp, "fm");
writeFileSync(fm, `#!${python}\n` + readFileSync(join(root, "test/e2e/smoke-fm.py"), "utf8"));
chmodSync(fm, 0o755);
const support = join(tmp, "support");
const profile = join(tmp, "profile");
const manifest = JSON.stringify({ name: "io.grove.host", description: "Grove smoke", path: join(hostDir, "grove-host.py"), type: "stdio", allowed_origins: [`chrome-extension://${extId}/`] });
for (const dir of [join(profile, "NativeMessagingHosts"), join(tmp, "home/.config/chromium/NativeMessagingHosts")]) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "io.grove.host.json"), manifest);
}
const env = { ...process.env, GROVE_FM: fm, GROVE_SUPPORT_DIR: support, HOME: join(tmp, "home") };
execFileSync(join(hostDir, "grove-host.py"), ["--install-schemas"], { env, stdio: "inherit" });

// A tiny site with meta descriptions.
const pages = {
  "/rust": ["Rust async overview", "Async Rust overview.", `<a id="l1" href="/tokio">Tokio</a> <a id="l2" href="/asyncstd">async-std</a> <a id="l3" href="/travel">Lisbon</a>`],
  "/tokio": ["Tokio - An asynchronous Rust runtime", "Tokio is an asynchronous runtime for Rust.", ""],
  "/asyncstd": ["async-std", "Async version of the Rust standard library.", ""],
  "/travel": ["Lisbon travel guide", "Where to stay in Lisbon.", ""],
  "/hotel": ["Hotels in Lisbon", "Book a hotel in Lisbon.", ""],
  "/pasta": ["Pasta recipe", "A weeknight pasta recipe.", ""],
  "/cook": ["How to cook rice", "Cook rice perfectly.", ""],
  "/misc": ["Something else", "Unrelated page.", ""],
};
const server = createServer((req, res) => {
  const p = pages[req.url.split("?")[0]];
  if (!p) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><title>${p[0]}</title><meta name="description" content="${p[1]}"><h1>${p[0]}</h1>${p[2]}`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  headless: false,
  env,
  args: ["--headless=new", `--disable-extensions-except=${dist}`, `--load-extension=${dist}`, "--no-first-run"],
  viewport: { width: 1200, height: 800 },
  ignoreDefaultArgs: ["--disable-extensions"],
});

try {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker");
  const id = new URL(sw.url()).host;
  for (let i = 0; i < 40 && !(await sw.evaluate(() => !!globalThis.chrome?.storage?.local).catch(() => false)); i++) await sleep(250);
  check("extension loads with the pinned ID", id === extId, id);

  const groups = () => sw.evaluate(async () => (await chrome.tabGroups.query({})).map((g) => ({ id: g.id, title: g.title, color: g.color })));
  const until = async (fn, ms = 15000) => {
    const t0 = Date.now();
    for (;;) {
      const v = await fn();
      if (v || Date.now() - t0 > ms) return v;
      await sleep(250);
    }
  };

  // Settings: short debounce so the test is quick.
  await sw.evaluate(async () => chrome.storage.local.set({ settings: { namingDebounceMs: 1000 } }));

  // Wait for boot's ping.
  const pinged = await until(() => sw.evaluate(async () => (await chrome.storage.local.get("state")).state?.host?.lastPing?.fmAvailable === true));
  check("host ping succeeds through native messaging", !!pinged);

  // 1. Opener grouping + naming.
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`${base}/rust`);
  await page.click("#l1", { modifiers: ["Control"] });
  const provisional = await until(async () => (await groups()).find((g) => g.title === "127.0.0.1"), 5000);
  check("Ctrl-click from an ungrouped tab creates a group titled with the host", !!provisional, JSON.stringify(await groups()));
  const named = await until(async () => (await groups()).find((g) => g.title === "🦀 Rust async runtimes"), 15000);
  check("the model's title with emoji replaces the provisional one", !!named, JSON.stringify(await groups()));

  // 2. More links from the group: title stays (sticky), one group.
  await page.click("#l2", { modifiers: ["Control"] });
  await sleep(3500);
  const g2 = await groups();
  check("a link opened from the group joins it", g2.length === 1 && (await sw.evaluate(async (gid) => (await chrome.tabs.query({ groupId: gid })).length, g2[0].id)) === 3, JSON.stringify(g2));

  // 3. User rename sticks.
  await sw.evaluate(async (gid) => chrome.tabGroups.update(gid, { title: "My research" }), g2[0].id);
  await sleep(300);
  await page.click("#l3", { modifiers: ["Control"] });
  await sleep(4000);
  const g3 = await groups();
  check("a hand-typed title is never overwritten", g3[0]?.title === "My research", JSON.stringify(g3));

  // 4. Dissolve: close tabs of a fresh opener group down to one.
  const p2 = await context.newPage();
  await p2.goto(`${base}/rust`);
  await p2.click("#l2", { modifiers: ["Control"] });
  const og = await until(async () => {
    const tabGroupId = await sw.evaluate(async () => (await chrome.tabs.query({ url: "*://*/asyncstd" })).map((t) => t.groupId));
    return tabGroupId.find((x, i, a) => x !== -1 && x !== g3[0].id);
  }, 5000);
  const childId = await sw.evaluate(async (gid) => (await chrome.tabs.query({ groupId: gid })).find((t) => t.url.endsWith("/asyncstd"))?.id, og);
  await sw.evaluate(async (tid) => chrome.tabs.remove(tid), childId);
  const dissolved = await until(async () => !(await groups()).some((g) => g.id === og), 5000);
  check("an opener group closed down to one tab dissolves", !!dissolved);

  // 5. Organize: four ungrouped tabs in a new window.
  const win = await sw.evaluate(async (b) => {
    // One tab at a time: a multi-URL windows.create chains openers, which the opener rule would group.
    const w = await chrome.windows.create({ url: `${b}/hotel` });
    for (const p of ["travel", "pasta", "cook", "misc"]) await chrome.tabs.create({ windowId: w.id, url: `${b}/${p}` });
    return w.id;
  }, base);
  await sleep(2500);
  console.log("before organize", JSON.stringify(await sw.evaluate(async (w) => ({
    tabs: (await chrome.tabs.query({ windowId: w })).map((t) => [t.id, t.url.split("/").pop(), t.groupId, t.openerTabId]),
    groups: Object.values((await chrome.storage.local.get("state")).state.groups).filter((g) => g.windowId === w).map((g) => [g.id, g.origin, g.stripTitle]),
  }), win)));
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  const report = await popup.evaluate(async (w) => chrome.runtime.sendMessage({ cmd: "organize", windowId: w }), win);
  const orgGroups = await sw.evaluate(async (w) => (await chrome.tabGroups.query({ windowId: w })).map((g) => g.title).sort(), win);
  const layout = await sw.evaluate(async (w) => (await chrome.tabs.query({ windowId: w })).map((t) => `${t.url.split("/").pop()}:${t.groupId}:${t.openerTabId ?? ""}`), win);
  console.log("organize layout", layout.join(" "));
  check("Organize groups the ungrouped tabs by topic and leaves the rest", report?.ok && report.result.grouped === 4 && report.result.left === 1 && orgGroups.join("|") === "✈️ Lisbon trip planning|🍳 Weeknight pasta recipes", JSON.stringify({ report, orgGroups }));
  const undone = await popup.evaluate(async () => chrome.runtime.sendMessage({ cmd: "undoOrganize" }));
  await sleep(500);
  const afterUndo = await sw.evaluate(async (w) => (await chrome.tabGroups.query({ windowId: w })).length, win);
  check("Undo organize restores the previous layout", undone?.result === 4 && afterUndo === 0, JSON.stringify({ undone, afterUndo }));

  // 6. Popup renders the healthy state.
  await popup.setViewportSize({ width: 360, height: 560 });
  await popup.reload();
  await sleep(800);
  const statusText = await popup.textContent("#status-text");
  check("popup shows the host as healthy", statusText === "Host ok" || statusText === "Naming…", statusText);
  await popup.screenshot({ path: join(shotDir, "popup.png") });

  const options = await context.newPage();
  await options.goto(`chrome-extension://${extId}/options.html`);
  await options.click("#selftest");
  await options.waitForFunction(() => document.querySelector("#selftest-out")?.textContent?.includes("nameMs"), null, { timeout: 15000 }).catch(() => undefined);
  const st = await options.textContent("#selftest-out");
  check("options self-test pings and names the fixture", st.includes('"fmAvailable": true') && st.includes("Rust async runtimes"), st.slice(0, 200));
  await options.setViewportSize({ width: 900, height: 1400 });
  await options.screenshot({ path: join(shotDir, "options.png"), fullPage: true });

  // 7. Host missing → HOST_NOT_FOUND surfaced.
  writeFileSync(join(profile, "NativeMessagingHosts/io.grove.host.json"), "{}");
  writeFileSync(join(tmp, "home/.config/chromium/NativeMessagingHosts/io.grove.host.json"), "{}");
  const bad = await popup.evaluate(async () => chrome.runtime.sendMessage({ cmd: "ping" }));
  check("a broken host manifest is reported, not swallowed", bad?.result?.ok === false && /HOST_/.test(bad.result.error.code), JSON.stringify(bad?.result?.error));
} finally {
  await context.close();
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} smoke checks passed; screenshots in ${shotDir}`);
process.exit(failed.length ? 1 : 0);
