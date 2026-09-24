import { notices, renderNotice, renderPill, type Health } from "../shared/health";
import { ago, el, send } from "../shared/messaging";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let windowId: number | undefined;
let resultText = "";
const open = new Set<number>(); // groups whose actions are expanded, kept across refreshes

interface Status extends Health {
  lastPing?: { fmAvailable: boolean; schemasOk: boolean };
  tidyMode: string;
  tidyThreshold: number;
  tidyCandidates: number;
  parkedCount: number;
  canUndoSweep: boolean;
  canUndoOrganize: boolean;
  archive: { url: string; title: string; favIconUrl?: string; groupTitle?: string; archivedAt: number }[];
  groups: { id: number; title: string; color?: string; origin: string; managed: boolean; userNamed: boolean; keep: boolean; dirty: boolean; size: number }[];
  extensionId: string;
  manifestPath: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function renderStatus(s: Status): void {
  renderPill($("status"), s);

  const list = notices(s);
  const box = $("notices");
  box.replaceChildren(...list.map(renderNotice));
  box.hidden = list.length === 0;

  const tabs = s.groups.reduce((n, g) => n + g.size, 0);
  const naming = s.groups.filter((g) => g.dirty && !g.userNamed).length;
  $("summary-title").textContent = s.groups.length ? `${plural(s.groups.length, "group")} · ${plural(tabs, "tab")}` : "Nothing to group yet";
  $("summary-sub").textContent = [
    s.groups.length ? "" : "Related tabs gather into named groups as you browse.",
    naming ? `Naming ${plural(naming, "group")}…` : "",
    s.parkedCount ? `${plural(s.parkedCount, "tab")} parked` : "",
  ].filter(Boolean).join(" · ") || "Everything is in place.";

  const ask = s.tidyMode === "ask" && s.tidyCandidates >= s.tidyThreshold;
  $("park-card").hidden = !ask;
  $("park-text").textContent = `${plural(s.tidyCandidates, "tab")} you haven't used in a while.`;
  $("park").textContent = "Park them";

  $("undo-sweep").hidden = !s.canUndoSweep;
  $("undo-organize").hidden = !s.canUndoOrganize;
  const both = s.canUndoSweep && s.canUndoOrganize;
  $("undo-organize").textContent = both ? "Undo organize" : "Undo";
  $("undo-sweep").textContent = both ? "Undo tidy" : "Undo";
  const fallback = s.canUndoOrganize ? "Organized a moment ago." : s.canUndoSweep ? "Tidied a moment ago." : "";
  $("result").textContent = resultText || fallback;
  $("result-card").hidden = !(resultText || fallback);

  const groups = $("groups");
  groups.replaceChildren();
  if (!s.groups.length) groups.append(el("li", { className: "empty", textContent: "Open a few tabs on one topic and they'll gather here." }));
  for (const g of s.groups) {
    const act = (label: string, title: string, cmd: string, extra: Record<string, unknown> = {}) =>
      el("button", { className: "small", textContent: label, title, onclick: () => run(cmd, { groupId: g.id, ...extra }) });
    const tags = [
      g.origin === "user" ? "Your group" : "Made by Diagonal",
      g.userNamed ? "your title" : g.dirty ? "naming…" : "",
      g.keep ? "never tidied" : "",
    ].filter(Boolean).join(" · ");
    const d = el("details", { className: "group", open: open.has(g.id) },
      el("summary", {},
        el("span", { className: `swatch ${g.color ?? "grey"}` }),
        el("span", { className: "grow ellipsis", textContent: g.title || "Untitled group" }),
        el("span", { className: "count num", textContent: String(g.size) }),
        el("span", { className: "chev" })),
      el("div", { className: "more" },
        el("div", { className: "tag", textContent: tags }),
        el("div", { className: "acts" },
          ...(g.userNamed ? [] : [act("Rename now", "Ask the model for a new name now", "groupNameNow")]),
          act(g.keep ? "Allow tidying" : "Never tidy", "Keep these tabs out of tidy sweeps", "groupKeep", { keep: !g.keep }),
          ...(g.userNamed ? [] : [act("Stop naming", "Leave this group's title alone", "groupDontName")]),
          act("Ungroup", "Ungroup these tabs", "groupUngroup"))));
    d.addEventListener("toggle", () => (d.open ? open.add(g.id) : open.delete(g.id)));
    groups.append(el("li", {}, d));
  }

  const archive = $("archive");
  archive.replaceChildren();
  $("archive-card").hidden = s.archive.length === 0;
  for (const a of s.archive) {
    const icon = a.favIconUrl && /^(https?|data):/.test(a.favIconUrl) ? el("img", { className: "fav", src: a.favIconUrl, alt: "" }) : el("span", { className: "fav" });
    archive.append(
      el("li", { className: "arch" },
        icon,
        el("div", { className: "grow" },
          el("div", { className: "ellipsis", textContent: a.title || a.url, title: a.url }),
          el("div", { className: "sub ellipsis", textContent: [a.groupTitle, ago(a.archivedAt)].filter(Boolean).join(" · ") })),
        el("div", { className: "acts" },
          el("button", { className: "link small", textContent: "Restore", onclick: () => run("restore", { archivedAt: a.archivedAt, url: a.url }) }),
          el("button", { className: "quiet forget", textContent: "×", title: "Forget this tab", ariaLabel: "Forget", onclick: () => run("forget", { archivedAt: a.archivedAt, url: a.url }) }))));
  }
}

async function refresh(): Promise<void> {
  try {
    renderStatus(await send<Status>("status", { windowId }));
  } catch {
    renderPill($("status"), { health: "degraded", groupsSupported: true, message: "", timeoutHint: false, inFlight: false });
    $("status-text").textContent = "Not responding";
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
  resultText = text;
  $("result").textContent = text;
  $("result-card").hidden = !text;
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
    if (r) {
      showResult(r.grouped
        ? `Grouped ${plural(r.grouped, "tab")} into ${plural(r.groups, "new group")}.${r.error ? ` Stopped early: ${r.error}` : ""}`
        : r.error ? `Couldn't organize: ${r.error}` : "Nothing new to group.");
      await refresh();
    }
  };
  const tidy = async () => {
    const r = (await run("tidyNow")) as { parked: number; archived: number } | undefined;
    if (r) {
      showResult(r.parked || r.archived
        ? [r.parked ? `Parked ${plural(r.parked, "tab")}` : "", r.archived ? `archived ${plural(r.archived, "tab")}` : ""].filter(Boolean).join(", ") + "."
        : "Nothing needed tidying.");
      await refresh();
    }
  };
  $("tidy").onclick = tidy;
  $("park").onclick = tidy;
  $("undo-sweep").onclick = async () => {
    const n = (await run("undoSweep")) as number | undefined;
    showResult(`Put back ${plural(n ?? 0, "tab")}.`);
  };
  $("undo-organize").onclick = async () => {
    const n = (await run("undoOrganize")) as number | undefined;
    showResult(`Put back ${plural(n ?? 0, "tab")}.`);
  };
  $("restore-all").onclick = () => run("restoreAll");
  $("options").onclick = () => chrome.runtime.openOptionsPage();
  await refresh();
  // A ping on popup open resumes a paused queue once the fix is in (section 12).
  void send("ping").then(refresh, refresh);
}

void main();
