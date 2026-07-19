import { applyCorrections } from "../../lib/dictionary.js";
import { MAX_EDITOR_CODE_UNITS } from "./constants.js";

export const WINDOW_SENTENCE_OVERSHOOT_CODE_UNITS = 500;
// Sentence-scale: just enough for a boundary-straddling correction to fall
// wholly inside one window's trusted range. Sized against the 4k window
// budget (see constants.js) — don't let it grow into a real fraction of it.
export const DOCUMENT_WINDOW_OVERLAP_CODE_UNITS = 200;
export const MAX_DOCUMENT_PROOFREAD_WINDOWS = 3;

export function createFocusedProofreadWindow(text, caretOffset, {
  maxCodeUnits = MAX_EDITOR_CODE_UNITS,
  sentenceOvershootCodeUnits = WINDOW_SENTENCE_OVERSHOOT_CODE_UNITS,
} = {}) {
  if (typeof text !== "string" || text.length <= maxCodeUnits) {
    return { text, baseOffset: 0, isWindow: false };
  }
  if (!Number.isInteger(caretOffset) || caretOffset < 0 || caretOffset > text.length) {
    return null;
  }

  const targetCodeUnits = Math.max(1, maxCodeUnits - sentenceOvershootCodeUnits);
  const rawBase = Math.min(
    Math.max(0, caretOffset - Math.floor(targetCodeUnits / 2)),
    Math.max(0, text.length - targetCodeUnits),
  );
  const targetBase = safeStartOffset(text, rawBase);
  const baseOffset = chooseBackwardBoundary(text, targetBase, Math.max(0, caretOffset - maxCodeUnits), caretOffset);
  const targetEnd = safeEndOffset(text, Math.min(text.length, baseOffset + targetCodeUnits));
  const hardEnd = safeEndOffset(text, Math.min(text.length, baseOffset + maxCodeUnits));
  const end = chooseForwardBoundary(text, targetEnd, hardEnd);

  if (!(baseOffset <= caretOffset && caretOffset <= end)) return null;
  return {
    text: text.slice(baseOffset, end),
    baseOffset,
    isWindow: true,
    windowStart: baseOffset,
    windowEnd: end,
  };
}

export function createProofreadWindowsForText(text, caretOffset, {
  maxCodeUnits = MAX_EDITOR_CODE_UNITS,
  maxDocumentWindows = MAX_DOCUMENT_PROOFREAD_WINDOWS,
  overlapCodeUnits = DOCUMENT_WINDOW_OVERLAP_CODE_UNITS,
  sentenceOvershootCodeUnits = WINDOW_SENTENCE_OVERSHOOT_CODE_UNITS,
} = {}) {
  if (typeof text !== "string") return null;
  if (text.length <= maxCodeUnits) return [makeWindow(text, 0, text.length, false)];
  if (!Number.isInteger(caretOffset) || caretOffset < 0 || caretOffset > text.length) return null;

  const documentWindows = createDocumentProofreadWindows(text, {
    maxCodeUnits,
    overlapCodeUnits,
    sentenceOvershootCodeUnits,
  });
  if (documentWindows.length > 0 && documentWindows.length <= maxDocumentWindows) {
    return documentWindows;
  }

  const focused = createFocusedProofreadWindow(text, caretOffset, {
    maxCodeUnits,
    sentenceOvershootCodeUnits,
  });
  return focused ? [focused] : null;
}

export function mapWindowCorrectionsToDocument(corrections, proofreadWindow) {
  if (!proofreadWindow?.isWindow) return Array.isArray(corrections) ? corrections : [];
  if (!Array.isArray(corrections)) return [];
  const seen = new Set();
  const out = [];
  for (const correction of corrections) {
    const start = Number(correction?.startIndex);
    const end = Number(correction?.endIndex);
    if (!Number.isInteger(start) || !Number.isInteger(end)
      || start < 0 || end < start || end > proofreadWindow.text.length) {
      continue;
    }
    const mapped = {
      ...correction,
      startIndex: start + proofreadWindow.baseOffset,
      endIndex: end + proofreadWindow.baseOffset,
    };
    if (!correctionWithinTrustedRange(mapped, proofreadWindow)) continue;
    const key = `${mapped.startIndex}:${mapped.endIndex}:${mapped.correction ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(mapped);
  }
  return out;
}

export function createDocumentProofreadWindows(text, {
  maxCodeUnits = MAX_EDITOR_CODE_UNITS,
  overlapCodeUnits = DOCUMENT_WINDOW_OVERLAP_CODE_UNITS,
  sentenceOvershootCodeUnits = WINDOW_SENTENCE_OVERSHOOT_CODE_UNITS,
} = {}) {
  if (typeof text !== "string") return [];
  if (text.length <= maxCodeUnits) {
    return [makeWindow(text, 0, text.length, false)];
  }

  const overlap = Math.max(0, Math.min(overlapCodeUnits, maxCodeUnits - 1));
  const targetCodeUnits = Math.max(1, maxCodeUnits - sentenceOvershootCodeUnits);
  const windows = [];
  let start = 0;

  for (let guard = 0; start < text.length && guard < text.length + 1; guard += 1) {
    const targetEnd = safeEndOffset(text, Math.min(text.length, start + targetCodeUnits));
    const hardEnd = safeEndOffset(text, Math.min(text.length, start + maxCodeUnits));
    let end = chooseForwardBoundary(text, targetEnd, hardEnd);
    if (end <= start) end = safeEndOffset(text, Math.min(text.length, start + maxCodeUnits));
    if (end <= start) break;

    windows.push(makeWindow(text, start, end, true));
    if (end >= text.length) break;

    const next = safeStartOffset(text, Math.max(start + 1, end - overlap));
    start = next > start ? next : start + 1;
  }

  return assignTrustedRanges(windows, text);
}

export function mergeWindowCorrections(results) {
  if (!Array.isArray(results)) return [];
  const seen = new Set();
  const merged = [];
  for (const result of results) {
    const mapped = mapWindowCorrectionsToDocument(result?.corrections, result?.window);
    for (const correction of mapped) {
      const key = `${correction.startIndex}:${correction.endIndex}:${correction.correction ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(correction);
    }
  }
  return merged.sort((a, b) => a.startIndex - b.startIndex || a.endIndex - b.endIndex);
}

export function applyWindowCorrections(text, results) {
  return applyCorrections(text, mergeWindowCorrections(results));
}

function chooseForwardBoundary(text, targetEnd, hardEnd) {
  if (targetEnd >= text.length) return text.length;
  const paragraph = text.indexOf("\n\n", targetEnd);
  if (paragraph >= 0 && paragraph + 2 <= hardEnd) return paragraph + 2;

  for (let i = targetEnd; i < hardEnd; i += 1) {
    if (/[.!?]/.test(text[i])) return safeEndOffset(text, i + 1);
  }
  return safeEndOffset(text, hardEnd);
}

function makeWindow(source, start, end, isWindow) {
  return {
    text: source.slice(start, end),
    baseOffset: start,
    isWindow,
    windowStart: start,
    windowEnd: end,
  };
}

function assignTrustedRanges(windows, source) {
  if (windows.length <= 1) return windows;
  for (const win of windows) {
    win.trustedStart = win.windowStart;
    win.trustedEnd = win.windowEnd;
  }
  for (let i = 1; i < windows.length; i += 1) {
    const prev = windows[i - 1];
    const current = windows[i];
    const overlapStart = Math.max(prev.windowStart, current.windowStart);
    const overlapEnd = Math.min(prev.windowEnd, current.windowEnd);
    if (overlapEnd <= overlapStart) {
      prev.trustedEnd = Math.min(prev.trustedEnd, current.windowStart);
      current.trustedStart = Math.max(current.trustedStart, current.windowStart);
      continue;
    }
    const boundary = safeStartOffset(source, Math.floor((overlapStart + overlapEnd) / 2));
    prev.trustedEnd = Math.min(prev.trustedEnd, boundary);
    current.trustedStart = Math.max(current.trustedStart, boundary);
  }
  return windows;
}

function correctionWithinTrustedRange(correction, win) {
  if (!Number.isInteger(win?.trustedStart) || !Number.isInteger(win?.trustedEnd)) return true;
  if (correction.startIndex === correction.endIndex) {
    return correction.startIndex >= win.trustedStart
      && (correction.startIndex < win.trustedEnd
        || (correction.startIndex === win.trustedEnd && correction.startIndex === win.windowEnd));
  }
  return correction.startIndex >= win.trustedStart && correction.endIndex <= win.trustedEnd;
}

function chooseBackwardBoundary(text, targetBase, minBase, caretOffset) {
  if (targetBase <= 0) return 0;
  const paragraph = text.lastIndexOf("\n\n", targetBase);
  if (paragraph >= minBase) return safeStartOffset(text, paragraph + 2);
  const nextParagraph = text.indexOf("\n\n", targetBase);
  if (nextParagraph >= 0 && nextParagraph + 2 <= caretOffset) {
    return safeStartOffset(text, nextParagraph + 2);
  }
  return safeStartOffset(text, Math.max(targetBase, minBase));
}

function safeStartOffset(text, offset) {
  if (offset <= 0) return 0;
  if (offset >= text.length) return text.length;
  return isLowSurrogate(text.charCodeAt(offset)) ? offset - 1 : offset;
}

function safeEndOffset(text, offset) {
  if (offset <= 0) return 0;
  if (offset >= text.length) return text.length;
  return isHighSurrogate(text.charCodeAt(offset - 1)) ? offset - 1 : offset;
}

function isHighSurrogate(code) {
  return code >= 0xD800 && code <= 0xDBFF;
}

function isLowSurrogate(code) {
  return code >= 0xDC00 && code <= 0xDFFF;
}
