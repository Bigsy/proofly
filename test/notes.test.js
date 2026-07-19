// Unit tests for lib/notes.js — the pure derivations behind the library:
// title/snippet from a body, relative-time meta, recency grouping, search
// matching, and download-filename sanitisation. No DOM, no chrome, no timers.

import { describe, expect, it } from "vitest";
import {
  compareByRecency,
  deriveSnippet,
  deriveTitle,
  formatRelative,
  groupByRecency,
  matchesQuery,
  sanitizeFilename,
} from "../lib/notes.js";

describe("deriveTitle", () => {
  it("uses the first non-empty line, skipping leading blanks", () => {
    expect(deriveTitle("\n\n  \nHello world\nmore text")).toBe("Hello world");
  });

  it("trims the title line", () => {
    expect(deriveTitle("   Spaced out   \nbody")).toBe("Spaced out");
  });

  it("falls back to 'Untitled note' for empty / whitespace-only bodies", () => {
    expect(deriveTitle("")).toBe("Untitled note");
    expect(deriveTitle("   \n\t  \n ")).toBe("Untitled note");
    expect(deriveTitle(null)).toBe("Untitled note");
    expect(deriveTitle(undefined)).toBe("Untitled note");
  });

  it("truncates a long title with an ellipsis", () => {
    const title = deriveTitle("x".repeat(200));
    expect(title).toHaveLength(61); // 60 chars + the ellipsis
    expect(title.endsWith("…")).toBe(true);
  });
});

describe("deriveSnippet", () => {
  it("is the text after the title line, whitespace-collapsed", () => {
    expect(deriveSnippet("Title\nbody   text\n\nhere")).toBe("body text here");
  });

  it("is empty for a single-line body (nothing follows the title)", () => {
    expect(deriveSnippet("just one line")).toBe("");
  });

  it("ignores blank lines before the title when locating the body", () => {
    expect(deriveSnippet("\n\nTitle\nbody")).toBe("body");
  });

  it("is empty for an empty body", () => {
    expect(deriveSnippet("")).toBe("");
    expect(deriveSnippet("   ")).toBe("");
  });

  it("truncates a long snippet with an ellipsis", () => {
    const snippet = deriveSnippet(`Title\n${"y".repeat(400)}`);
    expect(snippet).toHaveLength(141); // 140 + ellipsis
    expect(snippet.endsWith("…")).toBe(true);
  });
});

describe("formatRelative", () => {
  const now = new Date("2026-06-08T12:00:00").getTime();
  const ago = (ms) => formatRelative(now - ms, now);

  it("reads 'just now' under ~45 s (incl. clock-skewed future)", () => {
    expect(ago(0)).toBe("Edited just now");
    expect(ago(20_000)).toBe("Edited just now");
    expect(formatRelative(now + 5_000, now)).toBe("Edited just now");
  });

  it("formats minutes, hours, days and weeks", () => {
    expect(ago(5 * 60_000)).toBe("Edited 5 minutes ago");
    expect(ago(2 * 60 * 60_000)).toBe("Edited 2 hours ago");
    expect(ago(3 * 24 * 60 * 60_000)).toBe("Edited 3 days ago");
    expect(ago(7 * 24 * 60 * 60_000)).toBe("Edited 1 week ago");
  });
});

describe("compareByRecency", () => {
  it("sorts by updatedAt desc, then id desc as a stable tie-break", () => {
    const a = { id: "aaa", updatedAt: 100 };
    const b = { id: "bbb", updatedAt: 100 };
    const c = { id: "ccc", updatedAt: 200 };
    expect([a, b, c].slice().sort(compareByRecency).map((e) => e.id))
      .toEqual(["ccc", "bbb", "aaa"]);
  });
});

describe("groupByRecency", () => {
  const now = new Date("2026-06-08T12:00:00").getTime();
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  it("buckets into Today / Yesterday / Earlier by local calendar day", () => {
    const index = [
      { id: "today", updatedAt: now - 2 * HOUR },
      { id: "yest", updatedAt: now - 20 * HOUR }, // 16:00 the previous day
      { id: "old", updatedAt: now - 5 * DAY },
    ];
    const groups = groupByRecency(index, now);
    expect(groups.map((g) => g.label)).toEqual(["Today", "Yesterday", "Earlier"]);
    expect(groups.map((g) => g.notes.map((n) => n.id))).toEqual([
      ["today"], ["yest"], ["old"],
    ]);
  });

  it("omits empty buckets and sorts within each", () => {
    const index = [
      { id: "t1", updatedAt: now - HOUR },
      { id: "t2", updatedAt: now - 30 * 60 * 1000 }, // more recent
      { id: "old", updatedAt: now - 10 * DAY },
    ];
    const groups = groupByRecency(index, now);
    expect(groups.map((g) => g.label)).toEqual(["Today", "Earlier"]);
    expect(groups[0].notes.map((n) => n.id)).toEqual(["t2", "t1"]); // desc
  });
});

describe("matchesQuery", () => {
  const entry = { title: "Shopping list", snippet: "Milk, eggs, BREAD" };

  it("matches case-insensitively across title and snippet", () => {
    expect(matchesQuery(entry, "shop")).toBe(true);
    expect(matchesQuery(entry, "bread")).toBe(true);
    expect(matchesQuery(entry, "wine")).toBe(false);
  });

  it("an empty / whitespace query matches everything", () => {
    expect(matchesQuery(entry, "")).toBe(true);
    expect(matchesQuery(entry, "   ")).toBe(true);
    expect(matchesQuery({}, "")).toBe(true);
  });
});

describe("sanitizeFilename", () => {
  it("strips filesystem-illegal characters and appends .txt", () => {
    expect(sanitizeFilename("a/b:c*?\"<>|d")).toBe("a b c d.txt");
  });

  it("keeps hyphens and ordinary spaces (collapsed)", () => {
    expect(sanitizeFilename("my-note   name")).toBe("my-note name.txt");
  });

  it("falls back to 'Untitled note.txt' when nothing usable remains", () => {
    expect(sanitizeFilename("///")).toBe("Untitled note.txt");
    expect(sanitizeFilename("")).toBe("Untitled note.txt");
    expect(sanitizeFilename("   ")).toBe("Untitled note.txt");
  });

  it("strips leading dots so the name can't become a dotfile", () => {
    expect(sanitizeFilename("...secret")).toBe("secret.txt");
  });
});
