import { EMOJI_BY_CATEGORY } from "./emoji.gen";

export { EMOJI_BY_CATEGORY };

/** Emoji compare without the U+FE0F variation selector, which models often drop. */
export const normalizeEmoji = (e: string): string => e.replace(/️/g, "").trim();

const CANONICAL = new Map<string, string>();
for (const list of Object.values(EMOJI_BY_CATEGORY)) {
  for (const e of list) CANONICAL.set(normalizeEmoji(e), e);
}

export const ALL_EMOJI: string[] = [...CANONICAL.values()];

/** The canonical spelling of `e` when it is in the curated list, else undefined. */
export function canonicalEmoji(e: string | undefined): string | undefined {
  return e ? CANONICAL.get(normalizeEmoji(e)) : undefined;
}

export const DEFAULT_EMOJI = EMOJI_BY_CATEGORY.misc?.[0] ?? "🧭";
export const PARKED_EMOJI = "💤";
export const RESTORED_EMOJI = "🔄";
