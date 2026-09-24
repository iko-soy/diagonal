import { describe, expect, it } from "vitest";
import { withDefaults } from "../src/background/settings";

describe("withDefaults", () => {
  it("reads a stored Private Cloud Compute choice as the on-device model, the only one fm has", () => {
    expect(withDefaults({ model: "pcc" }).model).toBe("system");
  });
});
