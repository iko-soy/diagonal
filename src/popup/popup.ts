import { ago, el, send } from "../shared/messaging";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let windowId: number | undefined;

interface Status {
  health: "ok" | "unknown" | "degraded";
  message: string;
  lastError?: { code: string; message: string };
  lastPing?: { fmAvailable: boolean; schemasOk: boolean };
  timeoutHint: boolean;
  inFlight: boolean;
  tidyMode: string;
  tidyThreshold: number;
  tidyCandidates: number;
  parkedCount: number;
  canUndoSweep: boolean;
  canUndoOrganize: boolean;
  archive: { url: string; title: string; favIconUrl?: string; groupTitle?: string; archivedAt: number }[];
  groups: { id: number; title: string; origin: string; managed: boolean; userNamed: boolean; keep: boolean; dirty: boolean; size: number }[];
  extensionId: string;
  manifestPath: string;
}

function renderStatus(s: Status): void {
  const dot = $("status-dot");
  const text = $("status-text");
  dot.className = "dot";
  if (s.health === "degraded") {
    dot.classList.add("bad");
    const code = s.lastError?.code;
    text.textContent =
      code === "HOST_NOT_FOUND" ? "Host not installed" :
      code === "MODEL_UNAVAILABLE" ? "Model unavailable" :
      code === "HOST_FORBIDDEN" || code === "FORBIDDEN_ORIGIN" ? "Host refuses this ID" :
      code === "SCHEMA_MISSING" ? "Schemas missing" : "Host unavailable";
  } else if (s.health === "ok") {
    dot.classList.add("ok");
    text.textContent = s.inFlight ? "Naming…" : "Host ok";
  } else {
    dot.classList.add("warn");
    text.textContent = "Not checked yet";
  }
  const notice = $("notice");
  notice.replaceChildren();
  const lines: (string | Node)[] = [];
  if (s.message) lines.push(s.message);
  if (s.timeoutHint) lines.push("Three timeouts in a row: consider raising the timeout in Settings.");
  if (s.lastError?.code === "HOST_NOT_FOUND") {
    lines.push(el("div", {}, el("button", { className: "link", textContent: "Copy manifest path", onclick: () => navigator.clipboard.writeText(s.manifestPath) })));
  }
  if (s.lastError?.code === "MODEL_UNAVAILABLE") {
    lines.push(el("div", {}, el("button", {
      className: "link",
      textContent: "Open Apple Intelligence settings",
      onclick: () => chrome.tabs.create({ url: "x-apple.systempreferences:com.apple.Siri-Settings.extension" }),
    })));
  }
  notice.hidden = lines.length === 0;
  notice.className = s.health === "degraded" ? "notice bad" : "notice";
  for (const l of lines) notice.append(typeof l === "string" ? el("div", { textContent: l }) : l);

  const park = $<HTMLButtonElement>("park");
  park.hidden = !(s.tidyMode === "ask" && s.tidyCandidates >= s.tidyThreshold);
  park.textContent = `Park ${s.tidyCandidates} tabs`;
  $("undo-sweep").hidden = !s.canUndoSweep;
  $("undo-organize").hidden = !s.canUndoOrganize;
  $("parked").textContent = s.parkedCount ? `${s.parkedCount} tab${s.parkedCount === 1 ? "" : "s"} parked in this window` : "";

  const groups = $("groups");
  groups.replaceChildren();
  if (!s.groups.length) groups.append(el("li", { className: "muted", textContent: "No groups yet. Cmd-click a link to start one." }));
  for (const g of s.groups) {
    const act = (label: string, title: string, cmd: string, extra: Record<string, unknown> = {}) =>
      el("button", { textContent: label, title, onclick: () => run(cmd, { groupId: g.id, ...extra }) });
    const tags = [g.origin === "user" ? "yours" : g.origin, g.userNamed ? "fixed name" : g.dirty ? "renaming" : "", g.keep ? "kept" : ""].filter(Boolean).join(" · ");
    groups.append(
      el("li", {},
        el("div", { className: "row" },
          el("span", { className: "grow ellipsis", textContent: g.title || "(untitled)" }),
          el("span", { className: "muted count", textContent: String(g.size) })),
        el("div", { className: "row group-actions" },
          el("span", { className: "grow muted", textContent: tags }),
          act("Name now", "Name this group now", "groupNameNow"),
          act(g.keep ? "Unkeep" : "Keep", "Exclude from tidy", "groupKeep", { keep: !g.keep }),
          ...(g.userNamed ? [] : [act("Don't name", "Stop naming this group", "groupDontName")]),
          act("Ungroup", "Ungroup these tabs", "groupUngroup"))));
  }

  const archive = $("archive");
  archive.replaceChildren();
  $("restore-all").hidden = s.archive.length === 0;
  if (!s.archive.length) archive.append(el("li", { className: "muted", textContent: "Nothing archived." }));
  for (const a of s.archive) {
    const icon = a.favIconUrl && /^(https?|data):/.test(a.favIconUrl) ? el("img", { className: "fav", src: a.favIconUrl, alt: "" }) : el("span", { className: "fav" });
    archive.append(
      el("li", { className: "row" },
        icon,
        el("div", { className: "grow" },
          el("div", { className: "ellipsis", textContent: a.title, title: a.url }),
          el("div", { className: "muted ellipsis", textContent: [a.groupTitle, ago(a.archivedAt)].filter(Boolean).join(" · ") })),
        el("button", { className: "link", textContent: "Restore", onclick: () => run("restore", { archivedAt: a.archivedAt, url: a.url }) }),
        el("button", { className: "link", textContent: "Forget", onclick: () => run("forget", { archivedAt: a.archivedAt, url: a.url }) })));
  }
}

async function refresh(): Promise<void> {
  try {
    renderStatus(await send<Status>("status", { windowId }));
  } catch (e) {
    $("status-text").textContent = "Worker not responding";
  }
}

async function run(cmd: string, extra: Record<string, unknown> = {}): Promise<unknown> {
  try {
    return await send(cmd, { windowId, ...extra });
  } catch (e) {
    showResult(e instanceof Error ? e.message : String(e));
  } finally {
    await refresh();
  }
}

function showResult(text: string): void {
  const r = $("result");
  r.textContent = text;
  r.hidden = !text;
}

async function main(): Promise<void> {
  windowId = (await chrome.windows.getCurrent()).id;
  $("organize").onclick = async () => {
    const b = $<HTMLButtonElement>("organize");
    b.disabled = true;
    b.textContent = "Organizing…";
    const r = (await run("organize")) as { grouped: number; groups: number; left: number; error?: string } | undefined;
    b.disabled = false;
    b.textContent = "Organize now";
    if (r) showResult(`${r.grouped} tabs grouped into ${r.groups} new group${r.groups === 1 ? "" : "s"}, ${r.left} left${r.error ? ` (stopped: ${r.error})` : ""}.`);
  };
  const tidy = async () => {
    const r = (await run("tidyNow")) as { parked: number; archived: number } | undefined;
    if (r) showResult(`Parked ${r.parked}, archived ${r.archived}.`);
  };
  $("tidy").onclick = tidy;
  $("park").onclick = tidy;
  $("undo-sweep").onclick = async () => showResult(`Restored ${await run("undoSweep")} tabs.`);
  $("undo-organize").onclick = async () => showResult(`Restored ${await run("undoOrganize")} tabs.`);
  $("restore-all").onclick = () => run("restoreAll");
  $("options").onclick = () => chrome.runtime.openOptionsPage();
  await refresh();
  // A ping on popup open resumes a paused queue once the fix is in (section 12).
  void send("ping").then(refresh, refresh);
}

void main();
