// Proofly defaults; LongSentences stays locked off to protect overlapping fixes.
export const HARPER_RULE_OVERRIDES = Object.freeze({
  LongSentences: false,
  AvoidCurses: false,
});

export function parseRuleOverrides(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([name, state]) =>
    /^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(name)
    && !["__proto__", "constructor", "prototype"].includes(name)
    && typeof state === "boolean"));
}

export function effectiveRuleOverrides(value) {
  return { ...HARPER_RULE_OVERRIDES, ...parseRuleOverrides(value), LongSentences: false };
}

// Structured config supplies groups, but its state is not the resolved default.
export function ruleCatalog(structured, defaults, descriptions, available) {
  const groups = new Map();
  function visit(node, group = "Other") {
    for (const setting of node?.settings ?? []) {
      if (setting.Group) visit(setting.Group.child, setting.Group.label);
      if (setting.Bool) groups.set(setting.Bool.name, group);
    }
  }
  visit(structured);
  return Object.keys({ ...defaults, ...available }).sort().map((name) => ({
    name,
    label: name.replace(/([a-z0-9])([A-Z])/g, "$1 $2"),
    group: groups.get(name) ?? "Other",
    description: descriptions[name] ?? "",
    defaultEnabled: HARPER_RULE_OVERRIDES[name] ?? defaults[name] === true,
    locked: name === "LongSentences",
  }));
}

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
export function configurationRevision({
  dialect, words, ruleOverrides, weirpacks,
} = {}) {
  const ruleEntries = Object.entries(ruleOverrides ?? {})
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const packEntries = Array.isArray(weirpacks)
    ? weirpacks.map((pack) => [
      typeof pack?.id === "string" ? pack.id : "",
      Array.isArray(pack?.bytes) || pack?.bytes instanceof Uint8Array
        ? [...pack.bytes]
        : [],
    ])
    : [];
  return fnv1a(JSON.stringify([
    typeof dialect === "string" ? dialect : "",
    Array.isArray(words) ? words : [],
    ruleEntries,
    packEntries,
  ]));
}
