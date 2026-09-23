/**
 * Runs once at document_idle on http(s) pages: reads the page's description meta tag
 * (falling back to og:description), trims it to 300 characters and hands it to the worker.
 * No DOM writes, no listeners, no page body text.
 */
(() => {
  const read = (sel: string) => document.querySelector<HTMLMetaElement>(sel)?.content?.replace(/\s+/g, " ").trim() ?? "";
  const description = (read('meta[name="description" i]') || read('meta[property="og:description" i]')).slice(0, 300);
  if (!description) return;
  try {
    chrome.runtime.sendMessage({ kind: "meta", description }).catch(() => undefined);
  } catch {
    /* extension reloaded underneath the page */
  }
})();
