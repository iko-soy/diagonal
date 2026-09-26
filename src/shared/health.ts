/** Turns the worker's host health into the words the popup and settings page show. */
import { el } from "./messaging";

export interface Health {
  health: "ok" | "unknown" | "degraded";
  groupsSupported: boolean;
  message: string;
  lastError?: { code: string; message: string };
  timeoutHint: boolean;
  inFlight: boolean;
}

export type Tone = "ok" | "warn" | "bad";

export interface Notice {
  tone: "warn" | "bad" | "info";
  title: string;
  body: string;
  command?: string;
  action?: { label: string; run: () => void };
}

export function pill(s: Health): { tone: Tone; label: string; busy: boolean } {
  if (s.health === "degraded") {
    const code = s.lastError?.code;
    const label =
      code === "HOST_NOT_FOUND" ? "Setup needed" :
      code === "LICENSE_REQUIRED" ? "Terms needed" :
      code === "MODEL_UNAVAILABLE" ? "Model off" :
      code === "HOST_FORBIDDEN" || code === "FORBIDDEN_ORIGIN" ? "Setup needed" :
      code === "SCHEMA_MISSING" ? "Setup needed" : "Paused";
    return { tone: "bad", label, busy: false };
  }
  if (s.health === "ok") return { tone: "ok", label: s.inFlight ? "Naming…" : "Ready", busy: s.inFlight };
  return { tone: "warn", label: "Connecting…", busy: true };
}

export function notices(s: Health): Notice[] {
  const out: Notice[] = [];
  if (!s.groupsSupported) {
    out.push({ tone: "bad", title: "This browser can't group tabs", body: "It doesn't let extensions manage tab groups, so Diagonal has nothing to do here." });
  }
  if (s.health === "degraded") {
    const e = s.lastError;
    switch (e?.code) {
      case "HOST_NOT_FOUND":
        out.push({
          tone: "bad", title: "Finish setting up Diagonal",
          body: "Diagonal's helper isn't registered with this browser yet. Run this in Terminal, then reopen Diagonal.",
          // A Web Store install has an update_url and may never have had the cask; an unpacked one came from it.
          command: chrome.runtime.getManifest().update_url ? "brew install iko-soy/tap/diagonal" : "brew reinstall diagonal",
        });
        break;
      case "LICENSE_REQUIRED":
        out.push({
          tone: "bad", title: "Accept Apple's model terms",
          body: "Apple's fm tool needs its terms accepted once on this Mac. Run this in Terminal and Diagonal picks up on its own.",
          command: "sudo fm license",
        });
        break;
      case "MODEL_UNAVAILABLE":
        out.push({
          tone: "bad", title: "Apple Intelligence is off",
          body: `Groups can't be named until the on-device model is available. ${e.message}`.trim(),
          action: { label: "Open Apple Intelligence settings", run: () => void chrome.tabs.create({ url: "x-apple.systempreferences:com.apple.Siri-Settings.extension" }) },
        });
        break;
      case "HOST_FORBIDDEN":
      case "FORBIDDEN_ORIGIN":
        out.push({ tone: "bad", title: "The helper doesn't recognize this extension", body: "Reinstalling registers it again.", command: "brew reinstall diagonal" });
        break;
      case "SCHEMA_MISSING":
        out.push({
          tone: "bad", title: "The model isn't set up yet",
          body: `${e.message}. Diagonal keeps retrying on its own. This shows the full reason:`,
          command: "~/.local/bin/diagonal-host --selftest",
        });
        break;
      default:
        out.push({ tone: "bad", title: "Naming is paused", body: s.message || "The helper didn't answer. Diagonal retries on its own." });
    }
  }
  if (s.timeoutHint) {
    out.push({ tone: "info", title: "The model is slow right now", body: "It timed out three times in a row. You can give it longer under Naming in Settings." });
  }
  return out;
}

export function renderNotice(n: Notice): HTMLElement {
  const node = el("div", { className: `notice ${n.tone}` }, el("div", { className: "title", textContent: n.title }), el("p", { textContent: n.body }));
  if (n.command) {
    const cmd = n.command;
    const copy = el("button", { className: "small", textContent: "Copy" });
    copy.onclick = async () => {
      await navigator.clipboard.writeText(cmd).catch(() => undefined);
      copy.textContent = "Copied";
      setTimeout(() => (copy.textContent = "Copy"), 1400);
    };
    node.append(el("div", { className: "cmd" }, el("code", { textContent: cmd }), copy));
  }
  if (n.action) node.append(el("div", {}, el("button", { className: "link", textContent: n.action.label, onclick: n.action.run })));
  return node;
}

export function renderPill(root: HTMLElement, s: Health): void {
  const p = pill(s);
  root.className = `pill ${p.tone}${p.busy ? " busy" : ""}`;
  root.replaceChildren(el("span", { className: "dot" }), el("span", { id: "status-text", textContent: p.label }));
}
