import { colorForKey, type GroupColor } from "./colors";

const INTERNAL_PREFIXES = ["brave:", "chrome:", "chrome-extension:", "chrome-search:", "chrome-untrusted:", "devtools:", "edge:", "vivaldi:", "opera:", "file:", "about:", "view-source:", "data:", "javascript:", "blob:"];

/** True for pages that never feed grouping data or prompts (section 11). */
export function isInternalUrl(url: string | undefined): boolean {
  if (!url) return true;
  const u = url.trim().toLowerCase();
  if (!u) return true;
  return INTERNAL_PREFIXES.some((p) => u.startsWith(p));
}

export function parse(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

export const stripWww = (host: string): string => host.replace(/^www\./i, "");

export function hostname(url: string): string {
  const u = parse(url);
  return u ? stripWww(u.hostname) : "";
}

/** Two-label public suffixes common enough to matter for colouring; not a full PSL. */
const SECOND_LEVEL = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.jp", "ne.jp", "co.nz", "co.in", "com.br", "com.mx",
  "co.kr", "com.cn", "com.tw", "com.hk", "com.sg", "co.za", "com.tr", "github.io", "gitlab.io", "pages.dev", "vercel.app",
  "netlify.app", "herokuapp.com", "blogspot.com", "substack.com", "medium.com",
]);

export function registrableDomain(url: string): string {
  const h = hostname(url);
  if (!h || /^[\d.]+$/.test(h) || !h.includes(".")) return h;
  const parts = h.split(".");
  const last2 = parts.slice(-2).join(".");
  if (parts.length >= 3 && SECOND_LEVEL.has(last2)) return parts.slice(-3).join(".");
  return last2;
}

export const colorFor = (url: string): GroupColor => colorForKey(registrableDomain(url) || url);

/** The opener-group placeholder: the opener's hostname without `www.`. */
export const provisionalTitle = (url: string): string => hostname(url) || "New group";

/** Query keys worth keeping: they name the content (a video, a search), not the visit. */
const MEANINGFUL_QUERY_KEYS = new Set(["v", "q", "query", "search_query", "search", "s", "k", "id", "p", "list", "page"]);

/**
 * `host + path` as the model sees it (sections 6 and 9): `www.` dropped, fragment dropped,
 * query kept whole when the path is empty or `/`, otherwise only content-naming keys are kept
 * (so `youtube.com/watch?v=…` keeps `v` while `utm_*` and friends go). Cut at 160 characters.
 */
export function promptAddress(url: string, fullUrl = true): string {
  const u = parse(url);
  if (!u) return url.slice(0, 160);
  const host = stripWww(u.hostname);
  if (!fullUrl) return host;
  let path = u.pathname === "/" ? "" : u.pathname;
  let query = "";
  if (u.search) {
    if (!path) {
      query = u.search;
    } else {
      const kept = [...u.searchParams].filter(([k]) => MEANINGFUL_QUERY_KEYS.has(k.toLowerCase()));
      if (kept.length) query = "?" + new URLSearchParams(kept).toString();
    }
  }
  path = safeDecode(path);
  return (host + path + query).slice(0, 160);
}

function safeDecode(s: string): string {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
}

/** The URL sent in a request: scheme kept so the host can re-derive the address. */
export function promptUrl(url: string, fullUrl = true): string {
  const u = parse(url);
  if (!u) return url.slice(0, 300);
  return `${u.protocol}//${promptAddress(url, fullUrl)}`.slice(0, 300);
}

/** Collapse whitespace and cut at `max` characters on a word boundary. */
export function trimText(s: string | undefined, max: number): string {
  if (!s) return "";
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd();
}
