import { labelOf, repairLabel, safeEmoji, sameLabel, stripTitle, titleKey, LABEL_MAX_CHARS } from "../shared/label";
import { sha1 } from "../shared/sha1";
import { isInternalUrl, promptUrl, trimText } from "../shared/url";
import { pathKey } from "./engine";
import type { HostOpts, HostReply } from "./host";
import { SETUP_ERRORS } from "./host";
import type { Settings } from "./settings";
import type { GroupRecord, HostError, State } from "./state";

/** Section 6: debounced, sticky, sibling-aware naming of managed groups. */

export const NAME_ITEM_CAP = 48;
export const SAMPLE_EACH = 8;
export const QUEUE_GAP_MS = 250;
export const FALLBACK_ALARM_MS = 30_000;
export const BACKOFF_MS = [30_000, 120_000, 600_000, 3_600_000];
export const GIVE_UP_AFTER_MS = 24 * 3_600_000;
export const GLOBAL_PAUSE_AFTER = 5;
export const GLOBAL_PAUSE_MS = 600_000;
export const RATE_LIMIT_PAUSES_MS = [60_000, 300_000, 1_800_000];
export const MAX_ATTEMPTS = 99;

/** A live member tab as the naming loop sees it: fresh from `chrome.tabs`, description from state. */
export interface Member {
  id: number;
  index: number;
  url: string;
  title: string;
  status?: string;
  description?: string;
  lastActive: number;
}

export interface NameItem {
  i: number;
  title: string;
  url: string;
  description?: string;
}

export interface NamePayload {
  items: NameItem[];
  currentTitle?: string;
  siblingTitles: string[];
  mustDifferFrom?: string[];
}

export interface NameResult {
  title: string;
  emoji: string;
}

/** Tabs that can describe a group: web pages, not the new-tab page or internal pages. */
export const nameable = (m: Member): boolean => !isInternalUrl(m.url);

/**
 * Done loading, or not loaded at all: a tab the browser discarded to save memory (status "unloaded") keeps
 * its title and address, so it can describe its group without being loaded again.
 */
export const settled = (t: { status?: string }): boolean => t.status !== "loading";

/** sha-1 of the sorted `url|title` lines: reorder-proof, changes when a member or its title does. */
export const membersHash = (members: Pick<Member, "url" | "title">[]): string =>
  sha1(members.map((m) => `${m.url}|${titleKey(m.title)}`).sort().join("\n"));

export const memberUrls = (members: Pick<Member, "url">[]): string[] => members.map((m) => m.url).sort();

/** Groups larger than the cap send the 8 most recently active, the first 8 and the last 8, in strip order. */
export function sampleMembers(members: Member[], cap = NAME_ITEM_CAP): Member[] {
  const inOrder = [...members].sort((a, b) => a.index - b.index);
  if (inOrder.length <= cap) return inOrder;
  const each = Math.max(1, Math.floor(cap / 3));
  const recent = [...inOrder].sort((a, b) => b.lastActive - a.lastActive).slice(0, each);
  const picked = new Map<number, Member>();
  for (const m of [...recent, ...inOrder.slice(0, each), ...inOrder.slice(-each)]) picked.set(m.id, m);
  return [...picked.values()].sort((a, b) => a.index - b.index).slice(0, cap);
}

export function toItems(members: Member[], settings: Pick<Settings, "sendDescription" | "sendFullUrl">, withDescriptions = true): NameItem[] {
  return members.map((m, i) => {
    const item: NameItem = { i, title: trimText(m.title, 120), url: promptUrl(m.url, settings.sendFullUrl) };
    const d = withDescriptions && settings.sendDescription ? trimText(m.description, 500) : "";
    if (d) item.description = d;
    return item;
  });
}

/** Labels of the other titled groups in the same window. */
export function siblingLabels(state: State, g: GroupRecord): string[] {
  return Object.values(state.groups)
    .filter((o) => o.id !== g.id && o.windowId === g.windowId && o.origin !== "tidy")
    .map((o) => labelOf(o.stripTitle || o.title))
    .filter(Boolean);
}

export function buildNamePayload(
  state: State,
  g: GroupRecord,
  members: Member[],
  settings: Settings,
  o: { cap?: number; withDescriptions?: boolean; mustDifferFrom?: string[] } = {},
): NamePayload {
  const payload: NamePayload = {
    items: toItems(sampleMembers(members, o.cap ?? NAME_ITEM_CAP), settings, o.withDescriptions ?? true),
    siblingTitles: siblingLabels(state, g),
  };
  if (g.title && !g.userNamed) payload.currentTitle = g.title;
  if (o.mustDifferFrom?.length) payload.mustDifferFrom = o.mustDifferFrom;
  return payload;
}

/** Evolving-name policy: should a fresh model label replace the current one? */
export function shouldApply(g: GroupRecord, label: string, urls: string[]): boolean {
  if (g.userNamed) return false;
  if (!g.lastNamedAt || !g.title) return true; // first name replaces the provisional hostname
  if (sameLabel(label, g.title)) return false;
  // By page, not by exact address: a tab that moved to ?page=2 or #comments is the same member.
  const before = new Set((g.memberUrls ?? []).map(pathKey));
  const after = new Set(urls.map(pathKey));
  const changed = [...after].some((u) => !before.has(u)) || [...before].some((u) => !after.has(u));
  return changed; // a paraphrase with the same members keeps the old title
}

/** Last resort for a label that still collides after the retry: a numeric suffix. */
export function suffixLabel(label: string, taken: string[]): string {
  for (let n = 2; n < 100; n++) {
    const suffix = ` ${n}`;
    let words = label.split(" ");
    while (words.length > 1 && (words.join(" ") + suffix).length > LABEL_MAX_CHARS) words = words.slice(0, -1);
    const candidate = words.join(" ") + suffix;
    if (!taken.some((t) => sameLabel(t, candidate))) return candidate;
  }
  return label;
}

export const backoffFor = (attempts: number): number => BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)];

// ---------------------------------------------------------------------------------------------
// The queue: timers, coalescing and the one-at-a-time model calls. Browser access is injected so
// the same code runs under vitest with fake timers.

export interface NamingDeps {
  now(): number;
  state(): State;
  settings(): Settings;
  commit(): void;
  liveMembers(groupId: number): Promise<Member[] | undefined>;
  callName(payload: NamePayload, opts: HostOpts): Promise<HostReply<NameResult>>;
  writeTitle(groupId: number, title: string): Promise<boolean>;
  scheduleFallback(when: number): void;
  busy(on: boolean): void;
  hostFailed(error: HostError): void;
  hostOk(): void;
  log(...args: unknown[]): void;
}

export class Naming {
  private timers = new Map<number, ReturnType<typeof setTimeout>>();
  private queue: { groupId: number; force: boolean }[] = [];
  private running = false;
  private current: number | undefined;

  constructor(private d: NamingDeps) {}

  /** A dirty event: restart that group's debounce and keep the fallback alarm armed. */
  touch(groupId: number): void {
    const prev = this.timers.get(groupId);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      this.timers.delete(groupId);
      void this.consider(groupId);
    }, this.d.settings().namingDebounceMs);
    this.timers.set(groupId, t);
    this.d.scheduleFallback(this.d.now() + FALLBACK_ALARM_MS);
  }

  /** "Name now": skip the debounce, the hash short-circuit and any backoff. */
  nameNow(groupId: number): Promise<void> {
    const t = this.timers.get(groupId);
    if (t) clearTimeout(t);
    this.timers.delete(groupId);
    return this.consider(groupId, true);
  }

  /** Fallback alarm: pick up dirty groups whose debounce elapsed while the worker was asleep. */
  async sweepDirty(): Promise<void> {
    const now = this.d.now();
    const debounce = this.d.settings().namingDebounceMs;
    const due = Object.values(this.d.state().groups).filter(
      (g) => g.dirty && !this.timers.has(g.id) && (g.dirtyAt ?? 0) + debounce <= now,
    );
    for (const g of due) await this.consider(g.id);
    const pending = Object.values(this.d.state().groups).filter((g) => g.dirty);
    if (pending.length) {
      const next = Math.min(...pending.map((g) => Math.max(g.nextAttemptAt ?? 0, now + FALLBACK_ALARM_MS)));
      this.d.scheduleFallback(next);
    }
  }

  get pendingCount(): number {
    return this.queue.length + (this.current !== undefined ? 1 : 0);
  }

  /** Debounce fired: decide whether the group needs a model call at all. */
  async consider(groupId: number, force = false): Promise<void> {
    const s = this.d.state();
    const settings = this.d.settings();
    const g = s.groups[groupId];
    if (!g) return;
    if (!eligible(g, settings)) {
      if (g.dirty) {
        g.dirty = false;
        this.d.commit();
      }
      return;
    }
    const now = this.d.now();
    if (!force) {
      // A refusal waits for the members to change, which only a look at them can tell.
      if (g.nextAttemptAt && g.nextAttemptAt > now && !g.refusedHash) return;
      if (s.host.pausedUntil && s.host.pausedUntil > now) return;
      if (s.inFlight?.groupId === groupId && this.current !== groupId && now - s.inFlight.startedAt < settings.timeoutMs + 5000) return;
    }
    const members = (await this.d.liveMembers(groupId))?.filter(nameable);
    if (!members) return;
    if (!members.every(settled)) return; // stay dirty; the load finishing touches it again
    if (members.length < 2) {
      // Nothing to name from yet. A tab joining or loading a page marks the group dirty again.
      if (g.dirty && !force) {
        g.dirty = false;
        this.d.commit();
      }
      return;
    }
    const hash = membersHash(members);
    if (!force && hash === g.membersHash) {
      settle(g);
      this.d.commit();
      return;
    }
    if (g.refusedHash && !force) {
      if (hash === g.refusedHash && g.nextAttemptAt && g.nextAttemptAt > now) return;
      clearFailures(g); // different tabs now: Apple's filter may well take them
    }
    if (this.current === groupId && !force) return; // re-queued when the in-flight reply lands
    if (!this.queue.some((q) => q.groupId === groupId)) this.queue.push({ groupId, force });
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const { groupId, force } = this.queue.shift()!;
        this.current = groupId;
        try {
          await this.nameGroup(groupId, force);
        } catch (e) {
          this.d.log("naming failed", groupId, e);
        } finally {
          this.current = undefined;
        }
        if (this.queue.length) await new Promise((r) => setTimeout(r, QUEUE_GAP_MS));
      }
    } finally {
      this.running = false;
    }
  }

  private async nameGroup(groupId: number, force: boolean): Promise<void> {
    const settings = this.d.settings();
    let g = this.d.state().groups[groupId];
    if (!g || !eligible(g, settings)) return;
    // Built lazily: a group that changed three times while queued is described once.
    const members = (await this.d.liveMembers(groupId))?.filter(nameable);
    if (!members || members.length < 2 || !members.every(settled)) return;
    const hash = membersHash(members);
    if (!force && hash === g.membersHash) {
      settle(g);
      this.d.commit();
      return;
    }
    const seq = g.dirtySeq;
    const opts: HostOpts = { model: settings.model, timeoutMs: settings.timeoutMs, emoji: settings.emoji, debug: settings.debugLog };
    let cap = NAME_ITEM_CAP;
    let withDescriptions = true;
    let mustDifferFrom: string[] | undefined;
    const retried = { budget: false, guardrail: false, output: false, sibling: false };

    this.d.state().inFlight = { groupId, startedAt: this.d.now() };
    this.d.commit();
    this.d.busy(true);
    try {
      for (;;) {
        const payload = buildNamePayload(this.d.state(), g, members, settings, { cap, withDescriptions, mustDifferFrom });
        const reply = await this.d.callName(payload, { ...opts, strict: retried.output });
        g = this.d.state().groups[groupId];
        if (!g) return; // group closed while the model ran

        if (!reply.ok) {
          const e = reply.error;
          if (e.code === "OVER_BUDGET" && !retried.budget) {
            retried.budget = true;
            cap = Math.max(2, Math.min(e.allowedItems ?? Infinity, Math.floor(payload.items.length / 2)));
            continue;
          }
          if (e.code === "GUARDRAIL" && !retried.guardrail && withDescriptions) {
            retried.guardrail = true;
            withDescriptions = false;
            continue;
          }
          if (e.code === "BAD_MODEL_OUTPUT" && !retried.output) {
            retried.output = true;
            mustDifferFrom = withRejected(mustDifferFrom, e.raw);
            continue;
          }
          this.fail(g, e, hash);
          return;
        }

        const label = repairLabel(reply.result.title);
        if (!label) {
          const e: HostError = { code: "BAD_MODEL_OUTPUT", message: "label failed worker validation", raw: JSON.stringify(reply.result).slice(0, 500), at: this.d.now() };
          if (!retried.output) {
            retried.output = true;
            mustDifferFrom = withRejected(mustDifferFrom, e.raw);
            continue;
          }
          this.fail(g, e, hash);
          return;
        }
        const emoji = safeEmoji(reply.result.emoji);
        const siblings = siblingLabels(this.d.state(), g);
        let finalLabel = label;
        if (siblings.some((t) => sameLabel(t, label))) {
          if (!retried.sibling) {
            retried.sibling = true;
            mustDifferFrom = siblings.filter((t) => sameLabel(t, label));
            continue;
          }
          finalLabel = suffixLabel(label, siblings);
        }
        this.d.hostOk();
        const written = await this.apply(g, finalLabel, emoji, members, hash);
        g = this.d.state().groups[groupId];
        if (!g) return;
        if (!written) {
          // The strip refused the title (a drag in progress, the window closing): try again shortly.
          g.nextAttemptAt = this.d.now() + BACKOFF_MS[0];
          this.d.scheduleFallback(g.nextAttemptAt);
        } else if (g.dirtySeq === seq) g.dirty = false;
        else this.touch(groupId); // dirtied while in flight: go again with the new membership
        return;
      }
    } finally {
      const s = this.d.state();
      if (s.inFlight?.groupId === groupId) s.inFlight = undefined;
      this.d.commit();
      this.d.busy(false);
    }
  }

  /** Put the label on the strip if the policy allows; false when the strip would not take the title. */
  private async apply(g: GroupRecord, label: string, emoji: string, members: Member[], hash: string): Promise<boolean> {
    const settings = this.d.settings();
    const urls = memberUrls(members);
    if (g.userNamed) return true; // renamed by hand while the model was thinking
    if (shouldApply(g, label, urls)) {
      const title = stripTitle(label, emoji, settings.emoji);
      this.d.state().ownWrites[g.id] = { title, at: this.d.now() };
      this.d.commit();
      const ok = await this.d.writeTitle(g.id, title);
      if (!ok) {
        delete this.d.state().ownWrites[g.id];
        return false;
      }
      g.title = label;
      g.emoji = emoji;
      g.stripTitle = title;
    }
    g.lastNamedAt = this.d.now();
    g.membersHash = hash;
    g.memberUrls = urls;
    clearFailures(g);
    return true;
  }

  private fail(g: GroupRecord, e: HostError, hash: string): void {
    const now = this.d.now();
    this.d.hostFailed(e);
    if (e.code === "BAD_REQUEST") {
      g.dirty = false; // a bug on our side: log and drop
      return;
    }
    // Setup errors pause every model call until the host is fixed, and its recovery picks this group up
    // again: they say nothing about this group, so they don't use up its retries.
    if (SETUP_ERRORS.has(e.code)) return;
    if (e.code === "GUARDRAIL") {
      g.nameAttempts = MAX_ATTEMPTS;
      g.nextAttemptAt = now + GIVE_UP_AFTER_MS;
      g.refusedHash = hash;
      this.d.scheduleFallback(g.nextAttemptAt);
      return;
    }
    g.nameAttempts += 1;
    g.firstFailureAt ??= now;
    if (now - g.firstFailureAt > GIVE_UP_AFTER_MS) {
      g.dirty = false; // retried for a day: keep the provisional title
      return;
    }
    g.nextAttemptAt = now + backoffFor(g.nameAttempts);
    this.d.scheduleFallback(g.nextAttemptAt);
  }
}

/** The retry after an unusable title lists that title as not allowed, so the model doesn't give it again. */
function withRejected(list: string[] | undefined, raw: string | undefined): string[] | undefined {
  let title: unknown;
  try {
    title = raw ? JSON.parse(raw)?.title : undefined;
  } catch {
    return list;
  }
  return typeof title === "string" && title.trim() ? [...(list ?? []), title.trim().slice(0, 60)] : list;
}

/** The retry bookkeeping of earlier failures, which no longer applies. */
function clearFailures(g: GroupRecord): void {
  g.nameAttempts = 0;
  g.firstFailureAt = undefined;
  g.nextAttemptAt = undefined;
  g.refusedHash = undefined;
}

/** The members are the ones last named: nothing to do, and nothing left to retry. */
function settle(g: GroupRecord): void {
  g.dirty = false;
  clearFailures(g);
}

export const eligible = (g: GroupRecord, settings: Settings): boolean =>
  settings.naming && g.managed && !g.userNamed && g.origin !== "tidy";
