import type { GroupColor } from "../shared/colors";

/** Section 4's persisted state model, plus the bookkeeping the rules in sections 5–7 need. */
export type GroupOrigin = "opener" | "organize" | "tidy" | "user";

export interface TabRecord {
  id: number;
  windowId: number;
  groupId: number; // -1 when ungrouped
  index: number;
  url: string;
  title: string;
  description?: string; // trimmed to 300 chars
  openerTabId?: number;
  pinned: boolean;
  incognito?: boolean;
  status?: string;
  createdAt: number;
  lastActivatedAt: number; // epoch ms
  parkedFrom?: string; // title of the group the tab was in before the tidy sweep parked it
}

export interface GroupRecord {
  id: number;
  windowId: number;
  origin: GroupOrigin;
  managed: boolean; // extension may rename / dissolve
  userNamed: boolean; // user edited the title; never overwrite
  title?: string; // the model label, without emoji
  emoji?: string;
  stripTitle?: string; // what the tab strip currently shows, as last seen
  color: GroupColor;
  colorLocked?: boolean; // user changed the colour; leave it alone
  keep?: boolean; // excluded from tidy
  membersHash: string; // sha-1 of sorted "url|title" of members at last naming
  memberUrls?: string[]; // sorted member URLs at last naming (for "changed by ≥ 1 member")
  dirty: boolean;
  dirtyAt?: number;
  dirtySeq: number; // bumps on every dirty event; lets an in-flight reply know it is stale
  lastNamedAt?: number;
  nameAttempts: number;
  firstFailureAt?: number;
  nextAttemptAt?: number;
}

export interface ArchivedTab {
  url: string;
  title: string;
  favIconUrl?: string;
  groupTitle?: string;
  archivedAt: number;
  lastActivatedAt: number;
}

export type HostErrorCode =
  | "HOST_NOT_FOUND"
  | "HOST_FORBIDDEN"
  | "HOST_CRASHED"
  | "FORBIDDEN_ORIGIN"
  | "BAD_REQUEST"
  | "SCHEMA_MISSING"
  | "MODEL_UNAVAILABLE"
  | "RATE_LIMITED"
  | "OVER_BUDGET"
  | "GUARDRAIL"
  | "TIMEOUT"
  | "BAD_MODEL_OUTPUT"
  | "FM_ERROR";

export interface HostError {
  code: HostErrorCode;
  message: string;
  retryable?: boolean;
  raw?: string;
  allowedItems?: number;
  at?: number;
}

export interface PingResult {
  hostVersion: string;
  fmPath: string;
  fmAvailable: boolean;
  fmMessage: string;
  schemasOk: boolean;
  organizeMode?: string;
}

export interface HostStatus {
  lastOkAt?: number;
  lastError?: HostError;
  consecutiveFailures: number;
  consecutiveTimeouts?: number;
  pausedUntil?: number;
  rateLimitStep?: number;
  lastPing?: PingResult & { at: number };
}

export interface SweepMove {
  tabId: number;
  groupId: number;
  index: number;
  windowId: number;
}

export interface State {
  version: 1;
  tabs: Record<number, TabRecord>;
  groups: Record<number, GroupRecord>;
  archive: ArchivedTab[]; // newest first, capped
  host: HostStatus;
  inFlight?: { groupId: number; startedAt: number };
  /** Titles and colours the worker itself wrote, so onUpdated can tell them from user edits. */
  ownWrites: Record<number, { title?: string; color?: string; at: number }>;
  /** Groups the worker is about to create: onCreated within 2 s in that window is ours. */
  pendingCreates: { windowId: number; origin: GroupOrigin; at: number }[];
  lastSweep?: { at: number; moves: SweepMove[] };
  lastOrganize?: { at: number; previous: Record<number, number> };
  tidyCandidates?: number;
}

export const emptyState = (): State => ({
  version: 1,
  tabs: {},
  groups: {},
  archive: [],
  host: { consecutiveFailures: 0 },
  ownWrites: {},
  pendingCreates: [],
});

/** Accept whatever was stored and bring it to the current shape. */
export function migrate(raw: unknown): State {
  const s = emptyState();
  if (!raw || typeof raw !== "object") return s;
  const r = raw as Partial<State>;
  if (r.version !== 1) return s;
  return {
    ...s,
    ...r,
    tabs: r.tabs ?? {},
    groups: Object.fromEntries(
      Object.entries(r.groups ?? {}).map(([k, g]) => [k, { ...g, dirtySeq: g.dirtySeq ?? 0, nameAttempts: g.nameAttempts ?? 0, membersHash: g.membersHash ?? "" }]),
    ),
    archive: Array.isArray(r.archive) ? r.archive : [],
    host: { consecutiveFailures: 0, ...(r.host ?? {}) },
    ownWrites: r.ownWrites ?? {},
    pendingCreates: r.pendingCreates ?? [],
  };
}

export const membersOf = (state: State, groupId: number): TabRecord[] =>
  Object.values(state.tabs)
    .filter((t) => t.groupId === groupId)
    .sort((a, b) => a.index - b.index);

export function newGroupRecord(
  id: number,
  windowId: number,
  origin: GroupOrigin,
  color: GroupColor,
  extra: Partial<GroupRecord> = {},
): GroupRecord {
  return {
    id,
    windowId,
    origin,
    managed: origin !== "user",
    userNamed: false,
    color,
    membersHash: "",
    dirty: false,
    dirtySeq: 0,
    nameAttempts: 0,
    ...extra,
  };
}

export function markDirty(g: GroupRecord, now: number): void {
  g.dirty = true;
  g.dirtyAt = now;
  g.dirtySeq = (g.dirtySeq ?? 0) + 1;
}
