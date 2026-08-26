import { describe, expect, it } from "vitest";
import {
  configurationRevision, HARPER_RULE_OVERRIDES,
} from "../lib/harper-rules.js";

describe("Proofly Harper rule configuration", () => {
  it("disables only the broad LongSentences diagnostic", () => {
    expect(HARPER_RULE_OVERRIDES).toEqual({ LongSentences: false });
  });

  it("revisions the complete canonical configuration", () => {
    const base = {
      dialect: "american",
      words: ["Acme", "Proofly"],
      ruleOverrides: { LongSentences: false, FutureRule: true },
    };
    const revision = configurationRevision(base);

    expect(configurationRevision({
      ...base,
      ruleOverrides: { FutureRule: true, LongSentences: false },
    })).toBe(revision);
    expect(configurationRevision({ ...base, dialect: "british" })).not.toBe(revision);
    expect(configurationRevision({ ...base, words: ["Acme"] })).not.toBe(revision);
    expect(configurationRevision({
      ...base,
      ruleOverrides: { LongSentences: true, FutureRule: true },
    })).not.toBe(revision);
    expect(configurationRevision({
      ...base,
      weirpacks: [{ id: "acme", bytes: [1, 2, 3] }],
    })).not.toBe(revision);
  });
});
