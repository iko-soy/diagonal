import { describe, expect, it } from "vitest";
import { fitVerdict } from "../src/background/fit";

const g = (...members: number[]) => ({ title: "", emoji: "", color: "", members });

describe("fit verdict (tab 0 against its groupmates)", () => {
  it("fits when it shares a topic with any groupmate", () => {
    expect(fitVerdict({ groups: [g(0, 2), g(1, 3)], leftovers: [] })).toBe("fits");
  });

  it("leaves when its groupmates agree and it matches none of them", () => {
    expect(fitVerdict({ groups: [g(1, 2, 3)], leftovers: [0] })).toBe("leave");
  });

  it("is unsure when the groupmates don't agree with each other either", () => {
    expect(fitVerdict({ groups: [], leftovers: [0, 1, 2] })).toBe("unsure");
  });
});
