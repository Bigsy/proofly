import { describe, expect, it } from "vitest";
import {
  MAX_GITHUB_WEIRPACK_FILE_BYTES, MAX_WEIRPACK_FILE_BYTES,
} from "../lib/weirpack-store.js";
import { isValidWeirpackByteArray } from "../lib/weirpack-validator.js";

describe("Weirpack byte validation", () => {
  it("accepts a pack larger than Chrome sync when GitHub storage can hold it", () => {
    const bytes = new Array(28_458).fill(0);

    expect(bytes.length).toBeGreaterThan(MAX_WEIRPACK_FILE_BYTES);
    expect(isValidWeirpackByteArray(bytes)).toBe(true);
  });

  it("rejects malformed bytes and packs above the GitHub safety limit", () => {
    expect(isValidWeirpackByteArray([])).toBe(false);
    expect(isValidWeirpackByteArray([80, 75, 256])).toBe(false);
    expect(isValidWeirpackByteArray({ length: 4 })).toBe(false);
    expect(isValidWeirpackByteArray(new Array(MAX_GITHUB_WEIRPACK_FILE_BYTES + 1)))
      .toBe(false);
  });
});
