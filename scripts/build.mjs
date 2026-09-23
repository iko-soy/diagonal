// Bundles src/ into dist/ (the unpacked extension). `--watch` rebuilds on change.
import * as esbuild from "esbuild";
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const watch = process.argv.includes("--watch");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const common = { bundle: true, target: "es2022", logLevel: "info", legalComments: "none", charset: "utf8" };
const builds = [
  { entryPoints: { background: join(root, "src/background/index.ts") }, format: "esm" },
  { entryPoints: { content: join(root, "src/content/meta.ts") }, format: "iife" },
  { entryPoints: { popup: join(root, "src/popup/popup.ts"), options: join(root, "src/options/options.ts") }, format: "esm" },
];

function copyStatic() {
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  if (!manifest.key || manifest.key.startsWith("__")) {
    console.warn("manifest.json has no pinned key yet: run scripts/gen-key.sh (the extension ID will not be stable)");
    delete manifest.key;
  }
  const stamp = process.env.DIAGONAL_VERSION;
  if (stamp) {
    // Release builds pass the commit time as YYYY.MM.DD.HHMM (see .github/workflows/release.yml).
    if (!/^\d{4}\.\d{2}\.\d{2}\.\d{4}$/.test(stamp)) throw new Error(`DIAGONAL_VERSION must be YYYY.MM.DD.HHMM, got ${stamp}`);
    manifest.version = stamp;
  }
  writeFileSync(join(dist, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  cpSync(join(root, "src/popup/popup.html"), join(dist, "popup.html"));
  cpSync(join(root, "src/options/options.html"), join(dist, "options.html"));
  cpSync(join(root, "src/shared/ui.css"), join(dist, "ui.css"));
  cpSync(join(root, "icons"), join(dist, "icons"), { recursive: true, filter: (p) => !p.endsWith("icon.png") });
  // The native host and its installer ride along, so the release zip is all a user needs.
  mkdirSync(join(dist, "host"));
  for (const f of ["diagonal-host.py", "prompts.py", "validate.py", "emoji.txt"]) cpSync(join(root, "host", f), join(dist, "host", f));
  cpSync(join(root, "extension-id"), join(dist, "extension-id"));
  cpSync(join(root, "scripts/install-manifest.sh"), join(dist, "install-host.command"));
  chmodSync(join(dist, "install-host.command"), 0o755);
}

if (watch) {
  copyStatic();
  for (const b of builds) await (await esbuild.context({ ...common, ...b, outdir: dist })).watch();
} else {
  await Promise.all(builds.map((b) => esbuild.build({ ...common, ...b, outdir: dist })));
  copyStatic();
}
