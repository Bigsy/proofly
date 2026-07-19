// lib/notes.js — pure derivations for the notes library.
// No DOM, no chrome, no module state: every function takes its inputs and
// returns plain data, so the edge cases are unit-testable without the page
// harness (see test/notes.test.js). The storage layer (lib/notes-store.js)
// and the library UI (ui/library.js) both build on these.

const UNTITLED = "Untitled note";
const TITLE_MAX = 60;
const SNIPPET_MAX = 140;

// Truncate to `max` characters, appending an ellipsis when something was cut.
// title/snippet are denormalised into the index, so truncating here keeps the
// index small — the library renders from it without ever loading bodies.
function truncate(str, max) {
  return str.length > max ? `${str.slice(0, max).trimEnd()}…` : str;
}

// First non-empty (trimmed) line of the body, truncated. The mockup has no
// separate title field — the title IS the first line. Empty/whitespace-only
// bodies (e.g. an existing note cleared to blank) fall back to "Untitled note".
export function deriveTitle(body) {
  for (const line of String(body ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return truncate(trimmed, TITLE_MAX);
  }
  return UNTITLED;
}

// Everything after the title line, whitespace-collapsed and truncated — the
// card's preview text. A single-line body has no snippet.
export function deriveSnippet(body) {
  const lines = String(body ?? "").split(/\r?\n/);
  const titleIdx = lines.findIndex((l) => l.trim());
  if (titleIdx === -1) return "";
  const rest = lines.slice(titleIdx + 1).join(" ").replace(/\s+/g, " ").trim();
  return truncate(rest, SNIPPET_MAX);
}

// Stable order for the index: most-recently-edited first, then id descending
// as a deterministic tie-breaker (UUIDs sort arbitrarily but *stably*, so
// equal-timestamp notes never flap). Shared by listIndex (lib/notes-store.js)
// and groupByRecency below so both agree on order.
export function compareByRecency(a, b) {
  return b.updatedAt - a.updatedAt
    || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const RELATIVE_UNITS = [
  ["year", 365 * DAY],
  ["month", 30 * DAY],
  ["week", 7 * DAY],
  ["day", DAY],
  ["hour", HOUR],
  ["minute", MINUTE],
  ["second", 1],
];

// "Edited 5 minutes ago" / "Edited 1 week ago" — the card meta line. `now` is
// injected (a timestamp) so callers stay deterministic and this stays pure.
// Anything under ~45 s (incl. clock-skewed future timestamps) reads "just now".
export function formatRelative(ts, now) {
  const secs = Math.round((now - ts) / 1000);
  if (secs < 45) return "Edited just now";
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "always" });
  for (const [unit, span] of RELATIVE_UNITS) {
    if (secs >= span) return `Edited ${rtf.format(-Math.floor(secs / span), unit)}`;
  }
  return "Edited just now";
}

// Start-of-local-day for a timestamp — the Today/Yesterday bucket boundary.
// (DAY above is in seconds, for formatRelative's ladder; bucketing works in ms.)
const DAY_MS = 24 * 60 * 60 * 1000;
function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Partition the (recency-sorted) index into ordered Today / Yesterday / Earlier
// buckets by local calendar day. Empty buckets are omitted, so the library only
// renders headings that have cards under them.
export function groupByRecency(index, now) {
  const sorted = [...index].sort(compareByRecency);
  const todayStart = startOfDay(now);
  const yesterdayStart = todayStart - DAY_MS;

  const buckets = { Today: [], Yesterday: [], Earlier: [] };
  for (const entry of sorted) {
    if (entry.updatedAt >= todayStart) buckets.Today.push(entry);
    else if (entry.updatedAt >= yesterdayStart) buckets.Yesterday.push(entry);
    else buckets.Earlier.push(entry);
  }
  return ["Today", "Yesterday", "Earlier"]
    .filter((label) => buckets[label].length)
    .map((label) => ({ label, notes: buckets[label] }));
}

// Case-insensitive search over an index entry's title + snippet. v1 searches
// the index only (no body loads) — an empty/whitespace query matches everything.
export function matchesQuery(entry, q) {
  const needle = String(q ?? "").trim().toLowerCase();
  if (!needle) return true;
  return `${entry.title ?? ""} ${entry.snippet ?? ""}`.toLowerCase().includes(needle);
}

// Title → a safe "<name>.txt" download filename. Strips characters illegal in
// filenames on the common OSes (plus control chars and leading dots), collapses
// whitespace, and falls back to "Untitled note.txt" when nothing usable remains.
export function sanitizeFilename(title) {
  const cleaned = String(title ?? "")
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, " ") // eslint-disable-line no-control-regex
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .trim();
  return `${cleaned || UNTITLED}.txt`;
}
