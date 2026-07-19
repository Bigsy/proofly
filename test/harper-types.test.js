import { describe, expect, it } from "vitest";
import {
  harperKindMetadata, KNOWN_HARPER_KINDS,
} from "../lib/harper-types.js";

describe("Harper kind presentation", () => {
  it("intentionally presents all 20 Harper kinds", () => {
    expect(KNOWN_HARPER_KINDS).toHaveLength(20);
    expect(new Set(KNOWN_HARPER_KINDS)).toHaveLength(20);
    for (const kind of KNOWN_HARPER_KINDS) {
      expect(harperKindMetadata(kind)).toMatchObject({
        key: kind,
        known: true,
      });
      expect(harperKindMetadata(kind).label).not.toBe("");
      expect(harperKindMetadata(kind).color).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("keeps legacy aliases and safely humanizes future kinds", () => {
    expect(harperKindMetadata("missing-words")).toMatchObject({
      key: "missing-words", label: "Missing words", known: true,
    });
    expect(harperKindMetadata("FutureClarity_Check")).toEqual({
      key: "futureclaritycheck",
      label: "Future Clarity Check",
      group: "general",
      color: "#94a3b8",
      known: false,
    });
  });
});
