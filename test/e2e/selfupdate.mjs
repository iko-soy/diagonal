// End-to-end check of self-update: loads dist/ the way "Load unpacked" does (CDP Extensions.loadUnpacked,
// so the browser treats it as a development install), swaps the folder for a newer version the way the
// Homebrew cask does, opens the popup, and expects the worker to reload itself into the new version.
//   node test/e2e/selfupdate.mjs      (after npm run build)
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const tmp = mkdtempSync(join(tmpdir(), "diagonal-selfupdate-"));
const ext = join(tmp, "extension");
cpSync(join(root, "dist"), ext, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", [
  "--headless=new", "--no-sandbox", "--remote-debugging-pipe", "--enable-unsafe-extension-debugging",
  `--user-data-dir=${join(tmp, "profile")}`, "--no-first-run", "about:blank",
], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
const [, , , toChrome, fromChrome] = chrome.stdio;
let buf = "";
let nextId = 1;
const pending = new Map();
fromChrome.on("data", (d) => {
  buf += d.toString();
  for (let i; (i = buf.indexOf("\0")) >= 0; buf = buf.slice(i + 1)) {
    const msg = JSON.parse(buf.slice(0, i));
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  }
});
const send = (method, params = {}, sessionId) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    toChrome.write(JSON.stringify({ id, method, params, sessionId }) + "\0");
  });

async function inPage(path, expression, keepOpen = false) {
  const { result: t } = await send("Target.createTarget", { url: `chrome-extension://${id}/${path}` });
  await sleep(1000);
  const { result: a } = await send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
  if (!a) return undefined; // the page already went away (the extension reloaded under it)
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, a.sessionId);
  if (!keepOpen) await send("Target.closeTarget", { targetId: t.targetId });
  return r.result?.result?.value;
}
const version = () => inPage("options.html", "chrome.runtime.getManifest().version");

let failed = false;
const check = (name, ok, detail = "") => {
  failed ||= !ok;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

await sleep(1500);
const loaded = await send("Extensions.loadUnpacked", { path: ext });
const id = loaded.result?.id;
check("loads unpacked", !!id, JSON.stringify(loaded.error ?? ""));
const before = await version();
check("runs the version it was loaded with", before === JSON.parse(readFileSync(join(root, "dist/manifest.json"), "utf8")).version, before);

// The cask stages the new release next to the old one and renames it into place.
const newer = "2999.1.1.1";
const staged = `${ext}.new`;
cpSync(ext, staged, { recursive: true });
const manifest = JSON.parse(readFileSync(join(staged, "manifest.json"), "utf8"));
manifest.version = newer;
writeFileSync(join(staged, "manifest.json"), JSON.stringify(manifest, null, 2));
renameSync(ext, `${ext}.old`);
renameSync(staged, ext);

// Opening the popup (or settings) asks the worker for status, which checks disk.
await inPage("popup.html", "1", true);
let after;
for (let i = 0; i < 20 && after !== newer; i++) {
  await sleep(500);
  after = await version().catch(() => undefined);
}
check("reloads itself into the newer version on disk", after === newer, `${before} -> ${after}`);

// Same version on disk again: nothing to do, and no reload loop.
await inPage("popup.html", "1");
await sleep(2000);
check("stays on it afterwards", (await version()) === newer);

chrome.kill();
process.exit(failed ? 1 : 0);
