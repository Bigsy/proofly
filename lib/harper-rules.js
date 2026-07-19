// Proofly-owned Harper rule policy. Keep this separate from user proofing
// settings: these overrides are product defaults, not a partially exposed
// rules UI.

export const HARPER_RULE_OVERRIDES = Object.freeze({
  LongSentences: false,
});

function fnv1a(value) {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

// Stable revision for every input that defines the effective Harper state.
// It survives service-worker/offscreen eviction, unlike an in-memory counter.
// Rule entries are canonicalized so object insertion order cannot create a
// false configuration mismatch.
export function configurationRevision({ dialect, words, ruleOverrides } = {}) {
  const ruleEntries = Object.entries(ruleOverrides ?? {})
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return fnv1a(JSON.stringify([
    typeof dialect === "string" ? dialect : "",
    Array.isArray(words) ? words : [],
    ruleEntries,
  ]));
}
