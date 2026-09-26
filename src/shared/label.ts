import { canonicalEmoji, DEFAULT_EMOJI } from "./emoji";

/** Section 6 label rules, re-checked by the worker after the host has validated. */
export const BANNED_WORDS = new Set(["tab", "tabs", "group", "groups", "misc", "various", "stuff"]);
export const LABEL_MIN_CHARS = 3;
export const LABEL_MAX_CHARS = 28;
export const LABEL_MIN_WORDS = 2;
export const LABEL_MAX_WORDS = 4;

// Quotes go; an apostrophe between two letters ("Children's", "Rock'n'roll") is part of the word and stays.
const QUOTES = /(?<!\p{L})['’]|['’](?!\p{L})|["“”‘«»`]/gu;
const HAS_QUOTE = /(?<!\p{L})['’]|['’](?!\p{L})|["“”‘«»`]/u;
const TRAILING_PUNCT = /[\s.,;:!?…\-–—。、，！？：；]+$/u;
// A label cut short should not end mid-phrase: "Planning a trip to" reads as "Planning a trip".
const DANGLING = new Set(["a", "an", "the", "to", "of", "for", "in", "on", "at", "by", "and", "or", "with", "from"]);

/** Repair what is repairable; return undefined when the label cannot be made valid. */
export function repairLabel(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  let words = raw.replace(QUOTES, "").replace(/\s+/g, " ").trim().replace(TRAILING_PUNCT, "").split(" ").filter(Boolean);
  words = words.filter((w) => !BANNED_WORDS.has(w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")));
  if (words.length > LABEL_MAX_WORDS) words = words.slice(0, LABEL_MAX_WORDS);
  if (noSpace(words.join(" "))) {
    while (words.length > 1 && widthOf(words.join(" ")) > CJK_MAX_CHARS) words.pop();
    if (widthOf(words.join(" ")) > CJK_MAX_CHARS) words = [cutToWidth(words.join(" "), CJK_MAX_CHARS)];
  } else {
    while (words.length > LABEL_MIN_WORDS && words.join(" ").length > LABEL_MAX_CHARS) words.pop();
  }
  while (words.length > 1 && DANGLING.has(words[words.length - 1].toLowerCase())) words.pop();
  let label = words.join(" ").replace(TRAILING_PUNCT, "");
  if (!label) return undefined;
  // "rust async" becomes "Rust async"; "iPhone tips" and "macOS updates" keep the brand's own casing.
  if (!/\p{Lu}/u.test(words[0].slice(1))) label = label[0].toLocaleUpperCase() + label.slice(1);
  return isValidLabel(label) ? label : undefined;
}

/**
 * Chinese, Japanese, Korean, Thai, Lao, Khmer and Myanmar titles don't put spaces between words, so a label
 * with any of their characters ("Python教程") is checked by width instead of word count. Each such character
 * is about as wide as two Latin letters on the tab strip.
 */
const NO_SPACE = /[\u0e00-\u0eff\u1000-\u109f\u1780-\u17ff\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/g;
export const CJK_MIN_CHARS = 2;
export const CJK_MAX_CHARS = 16;

const noSpace = (label: string): boolean => (label.match(NO_SPACE)?.length ?? 0) > 0;
const widthOf = (label: string): number => {
  const wide = label.match(NO_SPACE)?.length ?? 0;
  return wide + (label.length - wide) / 2;
};
const cutToWidth = (label: string, max: number): string => {
  let out = "";
  for (const ch of label) {
    if (widthOf(out + ch) > max) break;
    out += ch;
  }
  return out.trim();
};

export function isValidLabel(label: string): boolean {
  const words = label.split(" ").filter(Boolean);
  const cjk = noSpace(label);
  return (
    label.length >= (cjk ? CJK_MIN_CHARS : LABEL_MIN_CHARS) &&
    (cjk ? widthOf(label) <= CJK_MAX_CHARS && label.length <= LABEL_MAX_CHARS : label.length <= LABEL_MAX_CHARS) &&
    words.length >= (cjk ? 1 : LABEL_MIN_WORDS) &&
    words.length <= LABEL_MAX_WORDS &&
    !HAS_QUOTE.test(label) &&
    !TRAILING_PUNCT.test(label) &&
    !words.some((w) => BANNED_WORDS.has(w.toLowerCase()))
  );
}

export const safeEmoji = (e: unknown): string => canonicalEmoji(typeof e === "string" ? e : undefined) ?? DEFAULT_EMOJI;

/** What goes on the tab strip. */
export const stripTitle = (label: string, emoji: string | undefined, withEmoji: boolean): string =>
  withEmoji && emoji ? `${emoji} ${label}` : label;

/** The label part of a strip title we wrote, for comparisons between groups. */
export function labelOf(title: string | undefined): string {
  if (!title) return "";
  const i = title.indexOf(" ");
  if (i > 0 && canonicalEmoji(title.slice(0, i))) return title.slice(i + 1);
  return title;
}

export const sameLabel = (a: string | undefined, b: string | undefined): boolean =>
  !!a && !!b && labelOf(a).trim().toLocaleLowerCase() === labelOf(b).trim().toLocaleLowerCase();

/**
 * A page title without the unread counts and bullets sites add to it, "(3) Inbox" or "• Slack", so a count
 * ticking over does not read as a new page. Only for noticing change: the model still sees the full title.
 */
export const titleKey = (title: string | undefined): string =>
  (title ?? "").replace(/[(\[]\d[\d,.]*\+?[)\]]/g, "").replace(/^[\s•●▶*]+/u, "").replace(/\s+/g, " ").trim();
