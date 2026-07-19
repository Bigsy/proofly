// lib/dictionary.js — pure matching/splicing logic for the custom dictionary.
// No chrome.*, no DOM (the lib/ rule): persistence lives in
// lib/dictionary-store.js; this module decides WHICH corrections a word list
// suppresses, and how to apply the survivors. Unit-tested in
// test/dictionary.test.js.
//
// The Proofreader API takes no dictionary input — proofread() is a sealed
// model call — so the dictionary is a POST-FILTER: both surfaces keep the raw
// correction list and derive the rendered list through filterCorrections() at
// their render seam. One consequence: the model's correctedInput includes the
// fixes we filtered out, so "Apply all" must splice the filtered list itself
// (applyCorrections below), never trust correctedInput.

// Entry rule shared with the store's asWordList: single tokens only, capped so
// one pathological "word" can't eat the ~8 KB sync quota.
export const MAX_WORD_LENGTH = 64;

// A storable dictionary entry: non-empty single token, no whitespace, ≤ 64
// chars. (Callers trim first — the store's asWordList does.)
export function isValidWord(w) {
  return typeof w === "string" && !!w
    && !/\s/u.test(w) && w.length <= MAX_WORD_LENGTH;
}

// The dictionary candidate for a correction, or null. Uses the RAW flagged
// span — NOT displaySpan: a pure insertion anchors its squiggle to the
// adjacent word, and that word must never become a candidate (adding "France"
// shouldn't suppress "France → France,"). Edge punctuation the span dragged
// in (quotes, a trailing comma) is stripped; what remains must be a single
// valid token. Multi-word grammar spans ("I seen"), empty insertion spans,
// and out-of-range indices all → null.
export function candidateWord(text, c) {
  const s = Number(c?.startIndex);
  const e = Number(c?.endIndex);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
  if (s < 0 || e > text.length || e <= s) return null;
  const word = text.slice(s, e)
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/[^\p{L}\p{N}]+$/u, "");
  return isValidWord(word) ? word : null;
}

// The ONE predicate gating both the "Add to dictionary" button and the
// filter — shared so they can never disagree. Suppressible = there's a
// candidate word AND the correction is (or may be) a spelling complaint.
// `types` absent stays eligible: not every build honours
// includeCorrectionTypes (see AGENTS.md), and both sides degrade to the same
// word-only heuristic. Typed non-spelling corrections (grammar "its → it's",
// punctuation, capitalization) are NOT suppressible — adding "its" should
// silence spelling complaints, not grammar fixes.
export function isEligible(text, c) {
  if (!candidateWord(text, c)) return false;
  const types = Array.isArray(c.types) && c.types.length ? c.types : null;
  return !types || types.includes("spelling");
}

// Matcher over a word list, rebuilt once per dictionary change (a Set lookup
// per correction afterwards — never a model call). Case rule, hunspell-style:
// an all-lowercase entry matches case-insensitively ("acme" matches
// "Acme" at sentence start); an entry with any uppercase matches exactly
// ("Acme" does not match "acme").
export function createMatcher(words) {
  const exact = new Set();
  const lowercase = new Set();
  for (const w of Array.isArray(words) ? words : []) {
    if (typeof w !== "string" || !w) continue;
    exact.add(w);
    if (w === w.toLowerCase()) lowercase.add(w);
  }
  return {
    matches: (word) => exact.has(word) || lowercase.has(word.toLowerCase()),
  };
}

// The render seam: corrections minus the eligible ones whose candidate is in
// the dictionary. Pure — both surfaces call this on the RAW list whenever the
// text, the corrections, or the dictionary change.
export function filterCorrections(text, corrections, matcher) {
  const list = Array.isArray(corrections) ? corrections : [];
  if (!matcher) return list;
  return list.filter((c) =>
    !isEligible(text, c) || !matcher.matches(candidateWord(text, c)));
}

// Shared Apply-all selection: sort by startIndex, drop overlaps keeping the earlier
// (mirrors usableSpans' de-overlap in lib/corrections.js — adjacent spans and
// zero-width insertions survive), and exclude malformed/non-applicable items.
function appliedSpans(text, corrections) {
  const spans = (Array.isArray(corrections) ? corrections : [])
    .map((c) => ({
      start: Number(c?.startIndex),
      end: Number(c?.endIndex),
      replacement: c?.correction,
    }))
    .filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end)
      && typeof c.replacement === "string"
      && c.start >= 0 && c.end >= c.start && c.end <= text.length)
    .sort((a, b) => a.start - b.start);

  let last = -1;
  return spans.filter((c) => (c.start >= last ? ((last = c.end), true) : false));
}

export function countAppliedCorrections(text, corrections) {
  return appliedSpans(text, corrections).length;
}

// The "Apply all" replacement text: splice the selected edits right-to-left so
// earlier indices stay valid. Validated against every RECORDED fixture's
// correctedInput before anything trusts it with filtered subsets.
export function applyCorrections(text, corrections) {
  const kept = appliedSpans(text, corrections);

  let out = text;
  for (let i = kept.length - 1; i >= 0; i--) {
    out = out.slice(0, kept[i].start) + kept[i].replacement + out.slice(kept[i].end);
  }
  return out;
}
