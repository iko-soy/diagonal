/**
 * Runs once at document_idle on http(s) pages and hands the worker a short summary of what the page is
 * about, up to 500 characters: the description meta tag (or og:description), the main heading when it adds
 * to the tab title, and the opening lines of the page's main text. It stays on this Mac: the worker only
 * passes it to Apple's on-device model, and only while "Include what pages say" is on.
 * No DOM writes, no listeners, nothing from form fields.
 */
(() => {
  const squash = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const meta = (sel: string) => squash(document.querySelector<HTMLMetaElement>(sel)?.content);
  const parts: string[] = [];
  const add = (s: string, max: number) => {
    const t = s.slice(0, max);
    if (t && !parts.some((p) => p.includes(t) || t.includes(p))) parts.push(t);
  };

  add(meta('meta[name="description" i]') || meta('meta[property="og:description" i]'), 300);

  const h1 = squash(document.querySelector("h1")?.textContent);
  if (h1 && !document.title.toLowerCase().includes(h1.toLowerCase())) add(h1, 120);

  // Opening paragraphs of the main content, skipping navigation, short captions and cookie banners.
  const root = document.querySelector("main, article, [role=main]") ?? document.body;
  let text = "";
  for (const p of Array.from(root?.querySelectorAll("p") ?? []).slice(0, 30)) {
    if (p.closest("nav, header, footer, aside, form, [role=dialog], [aria-modal=true]")) continue;
    const line = squash(p.textContent);
    if (line.length < 40 || /cookie|consent|javascript/i.test(line)) continue;
    text += (text ? " " : "") + line;
    if (text.length >= 240) break;
  }
  add(text, 240);

  const description = parts.join(" · ").slice(0, 500);
  if (!description) return;
  try {
    chrome.runtime.sendMessage({ kind: "meta", description }).catch(() => undefined);
  } catch {
    /* extension reloaded underneath the page */
  }
})();
