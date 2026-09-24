import { DEFAULT_SETTINGS, withDefaults, type Settings } from "../background/settings";
import { notices, renderNotice, renderPill, type Health } from "../shared/health";
import { el, send } from "../shared/messaging";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

type Field = { key: keyof Settings; label: string; help?: string; when?: (s: Settings) => boolean } & (
  | { kind: "bool" }
  | { kind: "number"; min: number; max: number; step?: number; unit?: string; scale?: number }
  | { kind: "select"; options: [string, string][] }
  | { kind: "list" }
);

interface Section { title: string; intro: string; fields: Field[]; extra?: () => HTMLElement }

const SECTIONS: Section[] = [
  {
    title: "Grouping",
    intro: "Tabs join a group on their own. Nothing to press.",
    fields: [
      { key: "openerGrouping", label: "Keep a tab with the one it was opened from", kind: "bool" },
      { key: "autoOrganize", label: "Sort loose tabs into groups", help: "A tab you pull out of a group stays out until it goes to another page.", kind: "bool" },
      { key: "autoOrganizeDelayMs", label: "Wait after the last tab change", kind: "number", min: 3, max: 120, unit: "sec", scale: 1000, when: (s) => s.autoOrganize },
      { key: "organizeMinGroupSize", label: "Smallest new group", kind: "number", min: 2, max: 5, unit: "tabs", when: (s) => s.autoOrganize },
      { key: "dissolveSingletons", label: "Ungroup a group that's down to one tab", help: "Only groups Diagonal made.", kind: "bool" },
    ],
  },
  {
    title: "Naming",
    intro: "Groups get a short title from the model on this Mac.",
    fields: [
      { key: "naming", label: "Name groups automatically", kind: "bool" },
      { key: "emoji", label: "Start titles with an emoji", kind: "bool", when: (s) => s.naming },
      { key: "nameUserGroups", label: "Name groups I make too", help: "Stops for good once you type a title yourself.", kind: "bool", when: (s) => s.naming },
      { key: "namingDebounceMs", label: "Wait before naming", kind: "number", min: 1, max: 30, unit: "sec", scale: 1000, when: (s) => s.naming },
      { key: "timeoutMs", label: "Give the model up to", kind: "number", min: 5, max: 120, unit: "sec", scale: 1000, when: (s) => s.naming },
    ],
  },
  {
    title: "Privacy",
    intro: "What Apple's on-device model sees when it names a group. It runs on this Mac; nothing leaves it.",
    fields: [
      { key: "sendDescription", label: "Include what pages say", help: "Each page's description, main heading and opening lines. Off: titles and addresses only.", kind: "bool" },
      { key: "sendFullUrl", label: "Include full addresses", help: "Off: just the site name.", kind: "bool" },
    ],
  },
  {
    title: "Tidy",
    intro: "Tabs you haven't touched in a while move to a parked group, then to the archive.",
    fields: [
      { key: "tidyMode", label: "Tidy old tabs", kind: "select", options: [["auto", "Automatically"], ["ask", "Ask me first"], ["off", "Never"]] },
      { key: "parkAfterHours", label: "Park tabs untouched for", kind: "number", min: 1, max: 720, unit: "hours", when: (s) => s.tidyMode !== "off" },
      { key: "archiveAfterHours", label: "Archive parked tabs after", help: "0 keeps them parked.", kind: "number", min: 0, max: 2160, unit: "hours", when: (s) => s.tidyMode !== "off" },
      { key: "tidyThreshold", label: "Ask once this many are waiting", kind: "number", min: 1, max: 100, unit: "tabs", when: (s) => s.tidyMode === "ask" },
      { key: "discardParked", label: "Free memory used by parked tabs", kind: "bool", when: (s) => s.tidyMode !== "off" },
      { key: "tidyUserGroups", label: "Tidy inside groups I made", kind: "bool", when: (s) => s.tidyMode !== "off" },
      { key: "tidyExclusions", label: "Never tidy addresses containing", help: "One per line. Wrap in /…/ for a regular expression.", kind: "list", when: (s) => s.tidyMode !== "off" },
    ],
  },
  {
    title: "Archive",
    intro: "Archived tabs can be restored from the toolbar popup.",
    fields: [{ key: "archiveCap", label: "Keep up to", kind: "number", min: 50, max: 5000, unit: "tabs" }],
    extra: () =>
      el("div", { className: "field" },
        el("span", { className: "label", textContent: "Export the archive" }),
        el("button", { textContent: "Export JSON", onclick: exportArchive }),
        el("span", { className: "help", textContent: "Every archived tab with its title, address and group." })),
  },
];

const DEBUG_FIELD: Field = {
  key: "debugLog", label: "Debug logging", kind: "bool",
  help: "The extension logs to its console. The helper logs to ~/Library/Logs/Diagonal/host.log once ~/Library/Application Support/Diagonal/debug exists.",
};

let settings: Settings = DEFAULT_SETTINGS;
const rows: { field: Field; row: HTMLElement }[] = [];
let toastTimer: ReturnType<typeof setTimeout> | undefined;

async function save(patch: Partial<Settings>): Promise<void> {
  settings = withDefaults({ ...settings, ...patch });
  await chrome.storage.local.set({ settings });
  const t = $("saved");
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 1200);
  applyDependencies();
  $("debug-section").hidden = !settings.debugLog;
}

/** Dim and disable settings that don't apply with the current choices. */
function applyDependencies(): void {
  for (const { field, row } of rows) {
    const on = field.when ? field.when(settings) : true;
    row.classList.toggle("off", !on);
    row.querySelectorAll<HTMLInputElement>("input, select, textarea").forEach((c) => (c.disabled = !on));
  }
}

function fieldRow(f: Field): HTMLElement {
  const value = settings[f.key] as unknown;
  const id = `f-${f.key}`;
  let control: HTMLElement;
  if (f.kind === "bool") {
    control = el("input", { id, type: "checkbox", className: "switch", checked: !!value, onchange: (e: Event) => save({ [f.key]: (e.target as HTMLInputElement).checked }) });
  } else if (f.kind === "number") {
    const scale = f.scale ?? 1;
    control = el("span", { className: "unit" },
      el("input", {
        id, type: "number", min: String(f.min), max: String(f.max), step: String(f.step ?? 1), value: String((value as number) / scale),
        onchange: (e: Event) => {
          const input = e.target as HTMLInputElement;
          const n = Math.min(f.max, Math.max(f.min, Number(input.value) || f.min));
          input.value = String(n);
          void save({ [f.key]: n * scale });
        },
      }),
      el("span", { textContent: f.unit ?? "" }));
  } else if (f.kind === "select") {
    const sel = el("select", { id, onchange: (e: Event) => save({ [f.key]: (e.target as HTMLSelectElement).value }) });
    for (const [v, label] of f.options) sel.append(el("option", { value: v, textContent: label, selected: v === value }));
    control = sel;
  } else {
    control = el("span");
  }
  const row = el("div", { className: "field" }, el("label", { htmlFor: id, textContent: f.label }), control);
  if (f.help) row.append(el("div", { className: "help", textContent: f.help }));
  if (f.kind === "list") {
    row.append(el("textarea", {
      id, className: "wide", spellcheck: false,
      value: (value as string[]).join("\n"),
      onchange: (e: Event) => save({ [f.key]: (e.target as HTMLTextAreaElement).value.split("\n") }),
    }));
  }
  rows.push({ field: f, row });
  return row;
}

function renderSettings(): void {
  rows.length = 0;
  const root = $("settings");
  root.replaceChildren();
  for (const s of SECTIONS) {
    const card = el("section", { className: "card" },
      el("div", { className: "head" }, el("h2", { textContent: s.title }), el("p", { textContent: s.intro })));
    for (const f of s.fields) card.append(fieldRow(f));
    if (s.extra) card.append(s.extra());
    root.append(card);
  }
  $("debug-fields").replaceChildren(fieldRow(DEBUG_FIELD));
  applyDependencies();
}

function percentile(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

async function renderHealth(): Promise<void> {
  try {
    const s = await send<Health>("status");
    renderPill($("status"), s);
    const list = notices(s);
    $("notices").replaceChildren(...list.map(renderNotice));
    $("notices").hidden = list.length === 0;
  } catch {
    /* worker asleep or reloading */
  }
}

async function renderDiagnostics(): Promise<void> {
  try {
    const d = await send<{ latency: number[]; debugLog: { at: number; msg: string }[]; host: { lastError?: unknown } }>("diagnostics");
    if (d.latency.length) $("latency").textContent = `${percentile(d.latency, 50)} ms · ${percentile(d.latency, 95)} ms · ${d.latency.length} calls`;
    $("last-error").textContent = d.host.lastError ? JSON.stringify(d.host.lastError, null, 2) : "None";
    $("debug-section").hidden = !settings.debugLog;
    $("debug-log").textContent = d.debugLog.map((e) => `${new Date(e.at).toLocaleTimeString()}  ${e.msg}`).join("\n") || "Empty";
  } catch {
    /* worker asleep or reloading */
  }
}

async function exportArchive(): Promise<void> {
  const archive = await send("exportArchive");
  const blob = new Blob([JSON.stringify(archive, null, 2)], { type: "application/json" });
  const a = el("a", { href: URL.createObjectURL(blob), download: `diagonal-archive-${new Date().toISOString().slice(0, 10)}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

type SelfTest = {
  ping?: { ok: boolean; result?: { fmAvailable?: boolean }; error?: { message?: string } };
  pingMs?: number;
  name?: { ok: boolean; result?: { title?: string; emoji?: string }; error?: { message?: string } };
  nameMs?: number;
};

function summarize(r: SelfTest): string {
  if (!r.ping?.ok) return `The helper didn't answer: ${r.ping?.error?.message ?? "no reply"}`;
  if (!r.name) return `The helper answered in ${r.pingMs} ms.`;
  if (!r.name.ok) return `The helper answered, but naming failed: ${r.name.error?.message ?? "no reply"}`;
  const title = [r.name.result?.emoji, r.name.result?.title].filter(Boolean).join(" ");
  return `Working. A sample group was named “${title}” in ${r.nameMs} ms.`;
}

async function main(): Promise<void> {
  settings = withDefaults((await chrome.storage.local.get("settings")).settings);
  renderSettings();
  const id = chrome.runtime.id;
  // Each Chromium browser has its own folder: Google/Chrome, BraveSoftware/Brave-Browser, BraveSoftware/Brave-Origin, …
  const path = "~/Library/Application Support/<browser>/NativeMessagingHosts/io.diagonal.host.json";
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
    const b = $<HTMLButtonElement>("selftest");
    const out = $("selftest-out");
    const summary = $("selftest-summary");
    b.disabled = true;
    b.textContent = "Checking…";
    summary.textContent = "Asking the helper to name a sample group…";
    try {
      const r = await send<SelfTest>("selftest");
      out.textContent = JSON.stringify(r, null, 2);
      summary.textContent = summarize(r);
    } catch (e) {
      out.textContent = String(e);
      summary.textContent = `The check couldn't run: ${e instanceof Error ? e.message : String(e)}`;
    }
    b.disabled = false;
    b.textContent = "Run check";
    await Promise.all([renderHealth(), renderDiagnostics()]);
  };
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) {
      settings = withDefaults(changes.settings.newValue);
    }
  });
  await Promise.all([renderHealth(), renderDiagnostics()]);
}

void main();
