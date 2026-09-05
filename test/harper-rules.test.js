import { describe, expect, it } from "vitest";
import {
  configurationRevision, effectiveRuleOverrides, HARPER_RULE_OVERRIDES, parseRuleOverrides, ruleCatalog,
} from "../lib/harper-rules.js";

describe("Proofly Harper rule configuration", () => {
  it("disables broad sentence advice and unsolicited censorship by default", () => {
    expect(HARPER_RULE_OVERRIDES).toEqual({ LongSentences: false, AvoidCurses: false });
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

it("validates overrides, preserves future names, and keeps long sentences locked off", () => {
  expect(parseRuleOverrides({ FutureRule: false, AvoidCurses: true, SpellCheck: null, bad: "false" }))
    .toEqual({ FutureRule: false, AvoidCurses: true });
  expect(effectiveRuleOverrides({ LongSentences: true, AvoidCurses: true }))
    .toEqual({ LongSentences: false, AvoidCurses: true });
});

it("uses resolved defaults instead of structured config's unset state", () => {
  const rules = ruleCatalog({ settings: [{ Group: { label: "Style", child: {
    settings: [{ Bool: { name: "AvoidCurses", state: false } }],
  } } }] }, { AvoidCurses: true, SpellCheck: true }, { AvoidCurses: "Censors words" },
  { AvoidCurses: false });
  expect(rules[0]).toMatchObject({ name: "AvoidCurses", group: "Style", defaultEnabled: false });
  expect(rules[1]).toMatchObject({ name: "SpellCheck", defaultEnabled: true });
});
