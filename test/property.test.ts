import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyEvent, type EngineEvent } from "../src/background/engine";
import { membersHash } from "../src/background/naming";
import { membersOf } from "../src/background/state";
import { ctx, stateWith, tab } from "./helpers";

/**
 * For any event sequence: no tab is in two groups, and every managed group with ≥ 2 members is
 * either dirty or has a membersHash equal to its current membership.
 */
const TAB_IDS = [1, 2, 3, 4, 5, 6];
const GROUP_IDS = [-1, 10, 11];

const event = fc.oneof(
  fc.record({ type: fc.constant("tabUpdated" as const), id: fc.constantFrom(...TAB_IDS), groupId: fc.constantFrom(...GROUP_IDS), title: fc.constantFrom("a", "b", "c"), path: fc.constantFrom("x", "y") }),
  fc.record({ type: fc.constant("tabRemoved" as const), id: fc.constantFrom(...TAB_IDS) }),
  fc.record({ type: fc.constant("meta" as const), id: fc.constantFrom(...TAB_IDS), description: fc.constantFrom("one", "two") }),
  fc.record({ type: fc.constant("name" as const), groupId: fc.constantFrom(10, 11) }),
);

describe("engine invariants", () => {
  it("holds for random event sequences", () => {
    fc.assert(
      fc.property(fc.array(event, { maxLength: 40 }), (events) => {
        const s = stateWith(TAB_IDS.map((id) => tab(id, { groupId: id % 2 ? 10 : 11 })), [
          { id: 10, origin: "opener" },
          { id: 11, origin: "organize" },
        ]);
        for (const g of Object.values(s.groups)) g.dirty = true; // members joined, not yet named
        for (const e of events) {
          let ev: EngineEvent;
          if (e.type === "name") {
            // Simulate a naming reply landing: hash recorded, dirty cleared.
            const g = s.groups[e.groupId];
            if (g) {
              g.membersHash = membersHash(membersOf(s, g.id));
              g.dirty = false;
            }
            continue;
          }
          if (e.type === "tabUpdated") {
            if (e.groupId !== -1 && !s.groups[e.groupId]) continue;
            ev = { type: "tabUpdated", tab: tab(e.id, { groupId: e.groupId, title: e.title, url: `https://example.com/${e.path}/${e.id}` }) };
          } else if (e.type === "tabRemoved") ev = { type: "tabRemoved", tabId: e.id };
          else ev = { type: "meta", tabId: e.id, description: e.description };
          applyEvent(s, ev, ctx());

          const seen = new Set<number>();
          for (const t of Object.values(s.tabs)) {
            expect(seen.has(t.id)).toBe(false);
            seen.add(t.id);
          }
          for (const g of Object.values(s.groups)) {
            const members = membersOf(s, g.id);
            if (g.managed && members.length >= 2 && !g.dirty) expect(g.membersHash).toBe(membersHash(members));
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});
