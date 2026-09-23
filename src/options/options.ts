import { DEFAULT_SETTINGS, withDefaults, type Settings } from "../background/settings";
import { el, send } from "../shared/messaging";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

type Field =
  | { key: keyof Settings; label: string; help?: string; kind: "bool" }
  | { key: keyof Settings; label: string; help?: string; kind: "number"; min: number; max: number; step?: number; unit?: string; scale?: number }
  | { key: keyof Settings; label: string; help?: string; kind: "select"; options: [string, string][] }
  | { key: keyof Settings; label: string; help?: string; kind: "list" };

const SECTIONS: [string, Field[]][] = [
  ["Grouping", [
    { key: "autoOrganize", label: "Organize loose tabs into groups automatically", help: "Tabs you take out of a group stay out until they go to another page.", kind: "bool" },
    { key: "autoOrganizeDelayMs", label: "Wait after the last tab change", kind: "number", min: 3, max: 120, step: 1, unit: "s", scale: 1000 },
    { key: "openerGrouping", label: "Group a tab with the tab it was opened from", kind: "bool" },
    { key: "dissolveSingletons", label: "Ungroup Diagonal's groups that drop to one tab", kind: "bool" },
  ]],
  ["Naming", [
    { key: "naming", label: "Name groups with the on-device model", kind: "bool" },
    { key: "nameUserGroups", label: "Name my own groups too", help: "Stops for good once you type a title.", kind: "bool" },
    { key: "emoji", label: "Prefix titles with an emoji", kind: "bool" },
    { key: "namingDebounceMs", label: "Quiet period before naming", kind: "number", min: 1, max: 30, step: 1, unit: "s", scale: 1000 },
    { key: "sendDescription", label: "Send page descriptions to the model", help: "Off: title and address only.", kind: "bool" },
    { key: "sendFullUrl", label: "Send full addresses to the model", help: "Off: hostname only.", kind: "bool" },
    { key: "model", label: "Model", kind: "select", options: [["system", "On-device (system)"], ["pcc", "Private Cloud Compute"]] },
    { key: "timeoutMs", label: "Timeout per model call", kind: "number", min: 5, max: 120, step: 1, unit: "s", scale: 1000 },
    { key: "organizeMinGroupSize", label: "Smallest new group", kind: "number", min: 2, max: 5, unit: "tabs" },
  ]],
  ["Tidy", [
    { key: "tidyMode", label: "Tidy sweep", kind: "select", options: [["auto", "Park automatically"], ["ask", "Ask before parking"], ["off", "Off"]] },
    { key: "parkAfterHours", label: "Park tabs untouched for", kind: "number", min: 1, max: 720, unit: "h" },
    { key: "archiveAfterHours", label: "Archive parked tabs after", help: "0 = never archive.", kind: "number", min: 0, max: 2160, unit: "h" },
    { key: "tidyThreshold", label: "Ask mode: offer a sweep at", kind: "number", min: 1, max: 100, unit: "tabs" },
    { key: "discardParked", label: "Discard parked tabs from memory", kind: "bool" },
    { key: "tidyUserGroups", label: "Tidy inside my own groups", kind: "bool" },
    { key: "tidyExclusions", label: "Never tidy addresses containing", help: "One per line. Write /…/ for a regular expression.", kind: "list" },
    { key: "archiveCap", label: "Keep at most", kind: "number", min: 50, max: 5000, unit: "archived tabs" },
  ]],
  ["Diagnostics", [
    { key: "debugLog", label: "Debug logging", help: "Worker logs to the console; the host logs to ~/Library/Logs/Diagonal/host.log when ~/Library/Application Support/Diagonal/debug exists.", kind: "bool" },
  ]],
];

let settings: Settings = DEFAULT_SETTINGS;

async function save(patch: Partial<Settings>): Promise<void> {
  settings = withDefaults({ ...settings, ...patch });
  await chrome.storage.local.set({ settings });
  const s = $("saved");
  s.style.opacity = "1";
  setTimeout(() => (s.style.opacity = "0"), 1200);
  renderWarnings();
}

function renderWarnings(): void {
  const w = document.getElementById("pcc-warning");
  if (w) w.hidden = settings.model !== "pcc";
}

function renderSettings(): void {
  const root = $("settings");
  root.replaceChildren();
  for (const [title, fields] of SECTIONS) {
    root.append(el("h2", { textContent: title }));
    for (const f of fields) {
      const value = settings[f.key] as unknown;
      let control: HTMLElement;
      if (f.kind === "bool") {
        control = el("input", { type: "checkbox", checked: !!value, onchange: (e: Event) => save({ [f.key]: (e.target as HTMLInputElement).checked }) });
      } else if (f.kind === "number") {
        const scale = f.scale ?? 1;
        control = el("span", {},
          el("input", {
            type: "number", min: String(f.min), max: String(f.max), step: String(f.step ?? 1), value: String((value as number) / scale),
            onchange: (e: Event) => save({ [f.key]: Number((e.target as HTMLInputElement).value) * scale }),
          }),
          f.unit ? ` ${f.unit}` : "");
      } else if (f.kind === "select") {
        const sel = el("select", { onchange: (e: Event) => save({ [f.key]: (e.target as HTMLSelectElement).value }) });
        for (const [v, label] of f.options) sel.append(el("option", { value: v, textContent: label, selected: v === value }));
        control = sel;
      } else {
        control = el("span");
      }
      const row = el("div", { className: "field" }, el("label", { textContent: f.label }), control);
      if (f.kind === "list") {
        row.append(el("textarea", {
          className: "help",
          value: (value as string[]).join("\n"),
          onchange: (e: Event) => save({ [f.key]: (e.target as HTMLTextAreaElement).value.split("\n") }),
        }));
      }
      if (f.help) row.append(el("div", { className: "help", textContent: f.help }));
      if (f.key === "model") {
        row.append(el("div", {
          className: "help warn-text", id: "pcc-warning",
          textContent: "Private Cloud Compute sends tab titles, addresses and descriptions to Apple's servers. The on-device model keeps them on this Mac.",
        }));
      }
      root.append(row);
    }
  }
  renderWarnings();
}

function percentile(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

async function renderDiagnostics(): Promise<void> {
  try {
    const d = await send<{ latency: number[]; debugLog: { at: number; msg: string }[]; host: { lastError?: unknown } }>("diagnostics");
    if (d.latency.length) $("latency").textContent = `p50 ${percentile(d.latency, 50)} ms · p95 ${percentile(d.latency, 95)} ms · n=${d.latency.length}`;
    $("last-error").textContent = d.host.lastError ? JSON.stringify(d.host.lastError, null, 2) : "none";
    $("debug-section").hidden = !settings.debugLog;
    $("debug-log").textContent = d.debugLog.map((e) => `${new Date(e.at).toLocaleTimeString()}  ${e.msg}`).join("\n") || "empty";
  } catch {
    /* worker asleep or reloading */
  }
}

async function main(): Promise<void> {
  settings = withDefaults((await chrome.storage.local.get("settings")).settings);
  renderSettings();
  const id = chrome.runtime.id;
  const path = "~/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/io.diagonal.host.json";
  const manifest = JSON.stringify({
    name: "io.diagonal.host",
    description: "Diagonal: names tab groups with Apple's on-device model",
    path: "/Users/<you>/.local/bin/diagonal-host",
    type: "stdio",
    allowed_origins: [`chrome-extension://${id}/`],
  }, null, 2);
  $("ext-id").textContent = id;
  $("manifest-path").textContent = path;
  $("manifest-json").textContent = manifest;
  $("copy-path").onclick = () => navigator.clipboard.writeText(path);
  $("copy-manifest").onclick = () => navigator.clipboard.writeText(manifest);
  $("selftest").onclick = async () => {
    const out = $("selftest-out");
    out.hidden = false;
    out.textContent = "Running…";
    try {
      const r = await send("selftest");
      out.textContent = JSON.stringify(r, null, 2);
    } catch (e) {
      out.textContent = String(e);
    }
    await renderDiagnostics();
  };
  $("export").onclick = async () => {
    const archive = await send("exportArchive");
    const blob = new Blob([JSON.stringify(archive, null, 2)], { type: "application/json" });
    const a = el("a", { href: URL.createObjectURL(blob), download: `diagonal-archive-${new Date().toISOString().slice(0, 10)}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) {
      settings = withDefaults(changes.settings.newValue);
    }
  });
  await renderDiagnostics();
}

void main();
