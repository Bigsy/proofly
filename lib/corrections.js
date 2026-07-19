// lib/corrections.js — pure span math for proofreader corrections.
// No DOM, no module state: every function takes (text, corrections, …) and
// returns plain data, so the edge cases are unit-testable without the page
// harness (see test/corrections.test.js).

// Display span for a correction. Real edits use their own span; pure insertions
// (zero-width) anchor to the adjacent word so there's something to underline and
// click — matching the "France → France," card. Returns null if unanchorable.
// The same adjacent-word anchoring is mirrored in buildCorrectionCard
// (ui/render.js); keep them in lockstep — see the note there.
export function displaySpan(text, c) {
  const s = Number(c.startIndex), e = Number(c.endIndex);
  if (!Number.isFinite(s) || !Number.isFinite(e) || s < 0 || e > text.length) return null;
  if (e > s) return { start: s, end: e };
  const before = /\S+$/.exec(text.slice(0, s));
  if (before) return { start: s - before[0].length, end: s };
  const after = /^\S+/.exec(text.slice(s));
  if (after) return { start: s, end: s + after[0].length };
  return null;
}

// Keep only corrections with a renderable span, sorted & de-overlapped.
export function usableSpans(text, corrections) {
  let last = -1;
  return corrections
    .map((c, i) => { const d = displaySpan(text, c); return d && { ...d, i }; })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start)
    .filter((c) => (c.start >= last ? ((last = c.end), true) : false));
}

// Which correction covers a caret offset (smallest span wins on overlap)?
// Uses displaySpan so insertions resolve to their anchored adjacent word.
export function findCorrectionAt(text, corrections, pos) {
  let best = -1;
  let bestLen = Infinity;
  corrections.forEach((c, i) => {
    const d = displaySpan(text, c);
    if (!d) return;
    const len = d.end - d.start;
    if (pos >= d.start && pos <= d.end && len < bestLen) {
      best = i;
      bestLen = len;
    }
  });
  return best;
}

export function rebaseCorrectionsAfterSingleEdit(oldText, corrections, newText) {
  if (typeof oldText !== "string" || typeof newText !== "string" || !Array.isArray(corrections)) {
    return [];
  }
  const edit = describeSingleEdit(oldText, newText);
  if (!edit) return [];
  return corrections
    .map((correction) => rebaseCorrection(correction, oldText, newText, edit))
    .filter(Boolean);
}

function describeSingleEdit(oldText, newText) {
  if (oldText === newText) {
    return { oldStart: oldText.length, oldEnd: oldText.length, delta: 0 };
  }
  let prefix = 0;
  const maxPrefix = Math.min(oldText.length, newText.length);
  while (prefix < maxPrefix && oldText[prefix] === newText[prefix]) prefix += 1;

  let suffix = 0;
  const maxSuffix = Math.min(oldText.length - prefix, newText.length - prefix);
  while (
    suffix < maxSuffix
    && oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const oldStart = prefix;
  const oldEnd = oldText.length - suffix;
  const newEnd = newText.length - suffix;
  return { oldStart, oldEnd, delta: (newEnd - oldStart) - (oldEnd - oldStart) };
}

function rebaseCorrection(correction, oldText, newText, edit) {
  const start = Number(correction?.startIndex);
  const end = Number(correction?.endIndex);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || end > oldText.length) {
    return null;
  }

  const oldDisplay = displaySpan(oldText, correction);
  if (!oldDisplay) return null;

  let newStart;
  let newEnd;
  if (oldDisplay.end <= edit.oldStart) {
    newStart = start;
    newEnd = end;
  } else if (oldDisplay.start >= edit.oldEnd) {
    newStart = start + edit.delta;
    newEnd = end + edit.delta;
  } else {
    return null;
  }

  if (newStart < 0 || newEnd < newStart || newEnd > newText.length) return null;
  if (oldText.slice(start, end) !== newText.slice(newStart, newEnd)) return null;

  const rebased = { ...correction, startIndex: newStart, endIndex: newEnd };
  const newDisplay = displaySpan(newText, rebased);
  if (!newDisplay) return null;
  if (oldText.slice(oldDisplay.start, oldDisplay.end)
    !== newText.slice(newDisplay.start, newDisplay.end)) {
    return null;
  }
  return rebased;
}
