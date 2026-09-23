/** Section 10: every setting, its default and its range. */
export type TidyMode = "ask" | "auto" | "off";
export type ModelChoice = "system" | "pcc";

export interface Settings {
  openerGrouping: boolean;
  dissolveSingletons: boolean;
  autoOrganize: boolean;
  autoOrganizeDelayMs: number;
  naming: boolean;
  nameUserGroups: boolean;
  emoji: boolean;
  namingDebounceMs: number;
  sendDescription: boolean;
  sendFullUrl: boolean;
  model: ModelChoice;
  timeoutMs: number;
  organizeMinGroupSize: number;
  tidyMode: TidyMode;
  parkAfterHours: number;
  archiveAfterHours: number; // 0 = never
  tidyThreshold: number;
  discardParked: boolean;
  tidyUserGroups: boolean;
  tidyExclusions: string[];
  archiveCap: number;
  debugLog: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  openerGrouping: true,
  dissolveSingletons: true,
  autoOrganize: true,
  autoOrganizeDelayMs: 8000,
  naming: true,
  nameUserGroups: false,
  emoji: true,
  namingDebounceMs: 4000,
  sendDescription: true,
  sendFullUrl: true,
  model: "system",
  timeoutMs: 45000,
  organizeMinGroupSize: 2,
  tidyMode: "auto",
  parkAfterHours: 24,
  archiveAfterHours: 48,
  tidyThreshold: 10,
  discardParked: true,
  tidyUserGroups: false,
  tidyExclusions: ["mail.", "calendar.", "meet.", "localhost", "127.0.0.1"],
  archiveCap: 500,
  debugLog: false,
};

const RANGES: Partial<Record<keyof Settings, [number, number]>> = {
  namingDebounceMs: [1000, 30000],
  autoOrganizeDelayMs: [3000, 120000],
  timeoutMs: [5000, 120000],
  organizeMinGroupSize: [2, 5],
  parkAfterHours: [1, 720],
  archiveAfterHours: [0, 2160],
  tidyThreshold: [1, 100],
  archiveCap: [50, 5000],
};

/** Fill missing keys and clamp out-of-range values so a bad stored value never crashes the worker. */
export function withDefaults(raw: unknown): Settings {
  const s: Settings = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== "object") return s;
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    const def = DEFAULT_SETTINGS[key];
    const v = r[key];
    if (v === undefined) continue;
    if (typeof def === "boolean" && typeof v === "boolean") (s as any)[key] = v;
    else if (typeof def === "number" && typeof v === "number" && Number.isFinite(v)) {
      const range = RANGES[key];
      (s as any)[key] = range ? Math.min(range[1], Math.max(range[0], Math.round(v))) : v;
    } else if (Array.isArray(def) && Array.isArray(v)) {
      (s as any)[key] = v.filter((x) => typeof x === "string" && x.trim()).map((x: string) => x.trim());
    } else if (key === "model" && (v === "system" || v === "pcc")) s.model = v;
    else if (key === "tidyMode" && (v === "ask" || v === "auto" || v === "off")) s.tidyMode = v;
  }
  if (s.archiveAfterHours !== 0 && s.archiveAfterHours < 1) s.archiveAfterHours = 1;
  return s;
}
