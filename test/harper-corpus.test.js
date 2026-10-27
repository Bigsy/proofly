// @vitest-environment node
import {
  afterAll, beforeAll, beforeEach, describe, expect, it,
} from "vitest";
import { Dialect, LocalLinter, packWeirpackFiles } from "../vendor/harper/index.js";
import { binary } from "../vendor/harper/binary.js";
import { normalizeHarperLints, normalizeOrganizedHarperLints } from "../lib/harper-corrections.js";
import { effectiveRuleOverrides } from "../lib/harper-rules.js";
import { createHarperService } from "../lib/harper-service.js";
import corpus from "./fixtures/harper-reviewed-corpus.json";

const DIALECTS = {
  american: Dialect.American,
  british: Dialect.British,
  australian: Dialect.Australian,
  canadian: Dialect.Canadian,
  indian: Dialect.Indian,
};

let linter;

const REPORTED_LONG_SENTENCE =
  "this is a really long senstence that i think will get a were underline from harper "
  + "i'm not actually sure what its doing but its really annying so maybe we can turn it "
  + "off some how i think if i keep going it will actually happen soon it just ";

const FORTY_WORD_SENTENCE =
  "The quick brown fox jumps over the lazy dog while a gentle breeze moves through tall "
  + "trees and bright birds sing above green fields where happy children play beside calm "
  + "water under warm sunlight during a peaceful summer afternoon today.";
const FORTY_ONE_WORD_SENTENCE = FORTY_WORD_SENTENCE.replace("afternoon today", "afternoon outside today");

async function lint(text) {
  const raw = await linter.lint(text, { language: "plaintext" });
  try {
    return normalizeHarperLints(text, raw);
  } finally {
    raw.forEach((item) => item.free());
  }
}

beforeAll(async () => {
  linter = new LocalLinter({ binary, dialect: Dialect.American });
  await linter.setup();
});

beforeEach(async () => {
  await linter.setDialect(Dialect.American);
  await linter.setLintConfig({ LongSentences: null });
  await linter.clearWords();
});

afterAll(() => linter?.dispose());

describe(`reviewed Harper ${corpus._provenance.version} corpus`, () => {
  for (const sample of corpus.dialects) {
    it(`${sample.dialect} spelling policy`, async () => {
      await linter.setDialect(DIALECTS[sample.dialect]);
      expect(await lint(sample.accepted)).toEqual([]);
      const issues = await lint(sample.input ?? sample.rejected);
      expect(issues.map((issue) => issue.correction)).toEqual(sample.primary);
    });
  }

  for (const sample of corpus.rules) {
    it(`${sample.expectedMiss ? "records expected miss" : "locks rule"}: ${sample.input}`, async () => {
      await linter.setDialect(Dialect.American);
      const issues = await lint(sample.input);
      expect(issues.map((issue) => issue.correction)).toEqual(sample.primary);
      if (sample.alternatives) {
        expect(issues[0].suggestions.map((suggestion) => suggestion.replacement))
          .toEqual(sample.alternatives);
      }
      if (sample.types) expect(issues.map((issue) => issue.types[0])).toEqual(sample.types);
      if (sample.starts) expect(issues.map((issue) => issue.startIndex)).toEqual(sample.starts);
    });
  }

  it.each(["american", "british"])("%s custom words accept casing variants and can be removed", async (dialect) => {
    await linter.setDialect(DIALECTS[dialect]);
    const text = "We use Proofly, proofly and PROOFLY.";
    expect(await lint(text)).not.toEqual([]);
    // Lower-case dictionary entries intentionally accept casing variants;
    // exercise that policy against Harper 3's changed core dictionary.
    await linter.importWords(["proofly"]);
    expect(await lint(text)).toEqual([]);
    await linter.clearWords();
    expect(await lint(text)).not.toEqual([]);
  });
});

it("reapplies real Weirpacks, dictionary words and rules across dialect changes, then removes the pack", async () => {
  // Synthetic pack: exercise the packaged compiler/runtime without depending
  // on a user's imported rules or changing recorded fixture provenance.
  const bytes = [...packWeirpackFiles(new Map([
    ["manifest.json", JSON.stringify({
      author: "Proofly", version: "1.0.0", description: "Compatibility test", license: "MIT",
    })],
    ["ProoflyTestRule.weir", [
      "expr main (purple platypus)",
      'let message "Use blue platypus."',
      'let description "Proofly compatibility test."',
      'let becomes "blue platypus"',
      'test "A purple platypus." "A blue platypus."',
    ].join("\n")],
  ]))];
  const service = createHarperService({
    createLinter: (dialect) => new LocalLinter({ binary, dialect: DIALECTS[dialect] }),
    switchDialect: (worker, dialect) => worker.setDialect(DIALECTS[dialect]),
  });
  try {
    for (const [revision, dialect] of ["american", "british", "british"].entries()) {
      const config = {
        dialect, configurationRevision: revision, words: ["proofly"],
        ruleOverrides: effectiveRuleOverrides(),
        weirpacks: revision < 2 ? [{ id: "synthetic", bytes }] : [],
      };
      expect(await service.handle({ type: "harper:configure", ...config }))
        .toMatchObject({ type: "harper:configured", configurationRevision: revision });
      const result = await service.handle({
        type: "harper:lint", dialect, configurationRevision: revision, requestId: revision,
        text: "We use Proofly. He is shitting. A purple platypus.",
      });
      expect(result.type).toBe("harper:result");
      expect(result.corrections).toEqual(revision < 2
        ? [expect.objectContaining({ correction: "blue platypus", rule: "ProoflyTestRule" })]
        : []);
    }
  } finally {
    await service.dispose();
  }
});

describe("pinned Harper informational diagnostics", () => {
  it("starts LongSentences above 40 words with one whole-sentence advice lint", async () => {
    expect(await lint(FORTY_WORD_SENTENCE)).toEqual([]);

    const organized = await linter.organizedLints(FORTY_ONE_WORD_SENTENCE, {
      language: "plaintext",
    });
    try {
      const activeRules = Object.entries(organized)
        .filter(([, lints]) => lints.length)
        .map(([name]) => name);
      expect(activeRules).toEqual(["LongSentences"]);

      const [longSentence] = organized.LongSentences;
      const span = longSentence.span();
      try {
        expect(longSentence.lint_kind()).toBe("Readability");
        expect([span.start, span.end]).toEqual([0, FORTY_ONE_WORD_SENTENCE.length]);
        expect(longSentence.suggestions()).toEqual([]);
      } finally {
        span.free();
      }
    } finally {
      for (const lints of Object.values(organized)) lints.forEach((item) => item.free());
    }
  });

  it("lets the reported full-span diagnostic win Harper's normal overlap removal", async () => {
    expect(REPORTED_LONG_SENTENCE).toHaveLength(241);
    const issues = await lint(REPORTED_LONG_SENTENCE);
    expect(issues).toEqual([{
      startIndex: 0,
      endIndex: 241,
      correction: null,
      suggestions: [],
      types: ["readability"],
      explanation: "This sentence is 49 words long.",
    }]);
  });

  it("exposes useful fixes with LongSentences disabled and normal deduplication", async () => {
    await linter.setLintConfig({ LongSentences: false });
    const issues = await lint(REPORTED_LONG_SENTENCE);

    expect(issues.map((issue) => issue.correction)).toEqual([
      "This", "sentence", "I", "Harper", "I'm", "annoying", "somehow", "I", "I",
    ]);
    expect(issues.every((issue) => issue.suggestions.length > 0)).toBe(true);
    expect(issues.some((issue) => issue.types.includes("readability"))).toBe(false);
  });

  it("offers quote-spacing replacements instead of advice", async () => {
    const issues = await lint('She whispered "hurry"and left.');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      startIndex: 20,
      endIndex: 21,
      correction: '" ',
      suggestions: [{ replacement: '" ' }, { replacement: ' "' }],
      types: ["formatting"],
    });
  });

  it.each([
    ["grammar", "Allow to change approval policy during the running task."],
    ["miscellaneous", "The city is famous its beaches."],
    ["typo", "We need a fully understanding of the risk before launch."],
    ["usage", "Far be it that I get in the middle of this thread."],
    ["readability", REPORTED_LONG_SENTENCE],
  ])("preserves %s advice without inventing a replacement", async (kind, input) => {
    const issues = await lint(input);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      correction: null,
      suggestions: [],
      types: [kind],
    });
    expect(issues[0].explanation).not.toBe("");
  });
});

it("disables censorship without losing spelling checks, including after a dialect change", async () => {
  for (const dialect of [Dialect.American, Dialect.British]) {
    await linter.setDialect(dialect);
    await linter.setLintConfig(effectiveRuleOverrides({ AvoidCurses: true }));
    const enabled = await lint("He is shitting.");
    expect(enabled.some((item) => item.correction?.includes("*"))).toBe(true);
    await linter.setLintConfig(effectiveRuleOverrides());
    expect(await lint("He is shitting.")).toEqual([]);
    expect((await lint("This is a sentnce.")).some((item) => item.correction === "sentence")).toBe(true);
  }
});

it("organized results keep rule identity and the same overlap filtering as normal lint", async () => {
  const texts = [REPORTED_LONG_SENTENCE, "He is shitting. This is a sentnce.",
    "I would argue that this is correct.", ...corpus.rules.map((sample) => sample.input)];
  for (const text of texts) {
    const raw = await linter.organizedLints(text, { language: "plaintext" });
    try {
      const corrections = normalizeOrganizedHarperLints(text, raw);
      expect(corrections.map(({ rule, ...correction }) => correction)).toEqual(await lint(text));
      expect(corrections.every((correction) => typeof correction.rule === "string")).toBe(true);
      if (text.includes("shitting")) expect(corrections.find((c) => c.correction === "****ting").rule).toBe("AvoidCurses");
    } finally {
      Object.values(raw).flat().forEach((item) => item.free());
    }
  }
});
