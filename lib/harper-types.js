const COLORS = Object.freeze({
  word: "#f87171",
  grammar: "#f472b6",
  mechanics: "#fbbf24",
  clarity: "#60a5fa",
  usage: "#34d399",
  repetition: "#c084fc",
  general: "#94a3b8",
});

const DEFINITIONS = [
  ["agreement", "Agreement", "grammar"],
  ["boundaryerror", "Sentence boundary", "grammar"],
  ["capitalization", "Capitalization", "mechanics"],
  ["eggcorn", "Confused phrase", "word"],
  ["enhancement", "Enhancement", "clarity"],
  ["formatting", "Formatting", "mechanics"],
  ["grammar", "Grammar", "grammar"],
  ["malapropism", "Wrong word", "word"],
  ["miscellaneous", "General", "general"],
  ["nonstandard", "Nonstandard usage", "usage"],
  ["punctuation", "Punctuation", "mechanics"],
  ["readability", "Readability", "clarity"],
  ["redundancy", "Redundancy", "repetition"],
  ["regionalism", "Regional usage", "usage"],
  ["repetition", "Repetition", "repetition"],
  ["spelling", "Spelling", "word"],
  ["style", "Style", "clarity"],
  ["typo", "Typo", "word"],
  ["usage", "Usage", "usage"],
  ["wordchoice", "Word choice", "usage"],
  // Legacy/non-Harper aliases retained for old fixtures and stored results.
  ["preposition", "Preposition", "usage"],
  ["missing-words", "Missing words", "repetition"],
];

export const KNOWN_HARPER_KINDS = Object.freeze(DEFINITIONS.slice(0, 20).map(([key]) => key));

export const HARPER_KIND_METADATA = Object.freeze(Object.fromEntries(
  DEFINITIONS.map(([key, label, group]) => [
    key.replace(/[\s_-]/g, "").toLowerCase(),
    Object.freeze({ key, label, group, color: COLORS[group], known: true }),
  ]),
));

function readableLabel(value) {
  const spaced = value
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/[\s_-]+/g, " ")
    .trim();
  if (!spaced) return "Writing suggestion";
  return spaced[0].toUpperCase() + spaced.slice(1);
}

export function harperKindMetadata(kind) {
  const raw = typeof kind === "string" ? kind.trim() : "";
  const normalized = raw.replace(/[\s_-]/g, "").toLowerCase();
  const known = HARPER_KIND_METADATA[normalized];
  if (known) return known;
  return {
    key: normalized.replace(/[^a-z0-9]/g, "") || "general",
    label: readableLabel(raw),
    group: "general",
    color: COLORS.general,
    known: false,
  };
}
