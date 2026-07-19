// @vitest-environment node
import {
  afterAll, beforeAll, beforeEach, describe, expect, it,
} from "vitest";
import { Dialect, LocalLinter } from "../vendor/harper/index.js";
import { binary } from "../vendor/harper/binary.js";
import { normalizeHarperLints } from "../lib/harper-corrections.js";
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

  it("suppresses a custom product name without rebuilding the linter", async () => {
    await linter.setDialect(Dialect.American);
    expect((await lint("Proofly improves text."))).not.toEqual([]);
    await linter.importWords(["Proofly"]);
    expect(await lint("Proofly improves text.")).toEqual([]);
    await linter.clearWords();
  });
});

describe("pinned Harper 2.4.0 informational diagnostics", () => {
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

  it.each([
    ["formatting", 'She whispered "hurry"and left.'],
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
