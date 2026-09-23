export const COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"] as const;
export type GroupColor = (typeof COLORS)[number];

/** Grey is kept for the parking group, so site colours come from the other eight. */
const SITE_COLORS: GroupColor[] = COLORS.filter((c) => c !== "grey");

export const isColor = (c: unknown): c is GroupColor => typeof c === "string" && (COLORS as readonly string[]).includes(c);

/** FNV-1a, 32 bit: stable across sessions and machines. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export const colorForKey = (key: string): GroupColor => SITE_COLORS[fnv1a(key) % SITE_COLORS.length];
