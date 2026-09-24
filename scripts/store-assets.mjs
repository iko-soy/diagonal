// Renders the Chrome Web Store images into docs/store/ from the popup and settings screenshots the smoke
// test takes:  SMOKE_SHOTS=/tmp/shots npm run smoke && node scripts/store-assets.mjs /tmp/shots
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const shots = process.argv[2] || "/tmp/shots";
const img = (p) => `data:image/png;base64,${readFileSync(p).toString("base64")}`;
const icon = img(join(root, "icons/icon.png"));
const css = `body{margin:0;font:16px -apple-system,system-ui,sans-serif;background:linear-gradient(135deg,#0d3b2e,#1f6f55);color:#fff;display:flex;align-items:center;justify-content:center;gap:56px;height:100vh;overflow:hidden}
h1{font-size:40px;margin:0 0 16px;line-height:1.15} p{font-size:20px;line-height:1.45;margin:0;opacity:.9;max-width:460px}
.shot{border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.35);background:#fff}`;

const pages = [
  { file: "screenshot-popup.png", w: 1280, h: 800, html: `<div><h1>Tabs group themselves</h1><p>Open and close tabs as usual. Diagonal groups related tabs and names each group with Apple's on-device model.</p></div><img class="shot" src="${img(join(shots, "popup.png"))}" style="height:560px">` },
  { file: "screenshot-settings.png", w: 1280, h: 800, html: `<div><h1>Private by design</h1><p>The model runs on your Mac. It sees a tab's title, address and description, and nothing leaves the Mac unless you pick Apple's Private Cloud Compute.</p></div><div class="shot" style="width:560px;height:680px;overflow:hidden"><img src="${img(join(shots, "options.png"))}" style="width:560px;display:block"></div>` },
  { file: "promo-small.png", w: 440, h: 280, html: `<img src="${icon}" style="width:120px"><div style="font-size:34px;font-weight:700">Diagonal</div>`, gap: 24 },
];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
for (const p of pages) {
  const page = await browser.newPage({ viewport: { width: p.w, height: p.h } });
  await page.setContent(`<style>${css}${p.gap ? `body{gap:${p.gap}px}` : ""}</style>${p.html}`);
  await page.screenshot({ path: join(root, "docs/store", p.file) });
  console.log("wrote docs/store/" + p.file);
}
await browser.close();
