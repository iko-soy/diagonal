import { isInternalUrl } from "../shared/url";
import { fitCheckable } from "./engine";
import { settled, toItems, type Member } from "./naming";
import type { OrganizePayload, OrganizeResult } from "./organize";
import { ungroup, type Runtime } from "./runtime";

/**
 * A tab in a group Diagonal made that moves on to an unrelated page leaves the group; auto-organize then
 * files it with its new topic. The check asks the host's topic question for the tab and a few groupmates:
 * the tab fits when it shares a topic with at least one of them.
 */
export const FIT_DELAY_MS = 2000;
export const FIT_SAMPLE = 5; // groupmates to compare with, most recently used first
const MIN_OTHERS = 2; // with fewer, one topic answer decides too much

export type FitVerdict = "fits" | "leave" | "unsure";

/** Index 0 is the tab being checked, the rest its groupmates. */
export function fitVerdict(result: OrganizeResult): FitVerdict {
  const withTab = result.groups.find((g) => g.members.includes(0));
  if (withTab && withTab.members.some((i) => i !== 0)) return "fits";
  // Only move it when its groupmates still agree with each other; otherwise the group itself is mixed.
  return result.groups.some((g) => !g.members.includes(0) && g.members.length >= 2) ? "leave" : "unsure";
}

export class FitChecker {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private again = false;

  constructor(private rt: Runtime) {}

  touch(delayMs = FIT_DELAY_MS): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.run();
    }, delayMs);
  }

  async run(): Promise<void> {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      const pending = Object.values(this.rt.state().tabs).filter((t) => t.fitPending).map((t) => t.id);
      for (const id of pending) await this.check(id);
    } catch (e) {
      this.rt.log("fit check failed", e);
    } finally {
      this.running = false;
      if (this.again) {
        this.again = false;
        this.touch();
      }
    }
  }

  private async check(tabId: number): Promise<void> {
    const rt = this.rt;
    const rec = rt.state().tabs[tabId];
    if (!rec?.fitPending) return;
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    const done = () => {
      const live = rt.state().tabs[tabId];
      if (live) live.fitPending = undefined;
      rt.commit();
    };
    if (!tab || (tab.groupId ?? -1) !== rec.groupId || !fitCheckable(rt.state(), rec, rt.settings())) return done();
    // Still loading, or the user is reading it: the load or the next tab switch checks again.
    if (tab.status !== "complete" || tab.active) return;
    const pausedUntil = rt.state().host.pausedUntil;
    if (pausedUntil && pausedUntil > rt.now()) return;

    const others = (await chrome.tabs.query({ groupId: rec.groupId }).catch(() => []))
      .filter((t) => t.id !== tabId && settled(t) && !isInternalUrl(t.url))
      .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))
      .slice(0, FIT_SAMPLE);
    if (others.length < MIN_OTHERS) return done();

    const s = rt.state();
    const toMember = (t: chrome.tabs.Tab): Member => ({
      id: t.id!,
      index: t.index,
      url: t.url ?? "",
      title: t.title ?? "",
      status: t.status,
      description: s.tabs[t.id!]?.description,
      lastActive: t.lastAccessed ?? 0,
    });
    const url = tab.url ?? "";
    const payload: OrganizePayload & { nameGroups: false } = {
      items: toItems([tab, ...others].map(toMember), rt.settings()),
      existingGroups: [],
      allowNew: true,
      maxGroups: 8,
      minGroupSize: 2,
      nameGroups: false, // only the topics matter here
    };
    const reply = await rt.host<OrganizeResult>("organize", payload);

    const live = rt.state().tabs[tabId];
    // It moved on again (or out) while fm was thinking: that newer page gets its own check.
    if (!live || live.url !== url || live.groupId !== rec.groupId) return;
    if (!reply.ok) {
      rt.log("fit check", reply.error.code);
      return done();
    }
    const verdict = fitVerdict(reply.result);
    done();
    if (verdict !== "leave") return;
    const current = await chrome.tabs.get(tabId).catch(() => undefined);
    if (!current || current.active || current.groupId !== rec.groupId) return;
    rt.log("fit check: tab left its group", tabId, rec.groupId);
    live.organizedKey = undefined; // auto-organize looks at it again
    rt.state().ownUngroups[tabId] = rt.now();
    rt.commit();
    await ungroup(rt, [tabId]);
  }
}
