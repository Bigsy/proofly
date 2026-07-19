import {
  captureScroll, createBeforeInputEvent, guardedApply, restoreScroll,
  setSelectionAtModelOffset, textEquals,
} from "./apply-kit.js";
import { spanWithinSnapshot } from "../snapshot.js";

const BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DIV", "DL", "DT",
  "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3",
  "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE",
  "SECTION", "TABLE", "TD", "TH", "TR", "UL",
]);

// eslint-disable-next-line no-misleading-character-class -- each zero-width char is checked individually on purpose
const ZERO_WIDTH_RE = /[\u200B\u200C\u200D\uFEFF]/;

export function isContentEditableField(el) {
  if (!el) return false;
  if (!hasEditableContent(el)) return false;
  if (
    el.classList?.contains("ck-editor__editable")
    || el.classList?.contains("cke_editable")
    || (el.classList?.contains("ql-editor") && el.closest?.(".ql-container"))
    || el.classList?.contains("mce-content-body")
    || el.getAttribute?.("data-lexical-editor") === "true"
    || el.getAttribute?.("data-slate-editor") === "true"
    || el.classList?.contains("public-DraftEditor-content")
    || el.localName === "trix-editor"
    || (el.classList?.contains("cm-content") && el.closest?.(".cm-editor"))
  ) return false;
  const role = el.getAttribute?.("role");
  return role === "textbox" || el.getAttribute?.("aria-multiline") === "true";
}

export function hasEditableContent(el) {
  if (!el) return false;
  const attr = el.getAttribute?.("contenteditable");
  if (attr === "false") return false;
  if (el.isContentEditable !== true && attr !== "true" && attr !== "" && attr !== "plaintext-only") return false;
  return true;
}

export function isEligibleContentEditableField(el) {
  if (!isContentEditableField(el)) return false;
  if (el.getAttribute?.("spellcheck") === "false") return false;
  if (el.getAttribute?.("aria-readonly") === "true") return false;
  if (el.getAttribute?.("aria-hidden") === "true" || el.closest?.("[aria-hidden='true']")) return false;
  if (el.closest?.("[contenteditable='false']")) return false;
  return true;
}

function childBoundary(node, side) {
  const parent = node.parentNode;
  if (!parent) return null;
  const offset = Array.prototype.indexOf.call(parent.childNodes, node) + (side === "after" ? 1 : 0);
  return { node: parent, offset };
}

function transformText(raw) {
  let modelText = "";
  const rawToModel = [0];
  const modelToRaw = [0];
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i] === "\u00A0" ? " " : raw[i];
    if (!ZERO_WIDTH_RE.test(ch)) {
      modelText += ch;
      modelToRaw[modelText.length] = i + 1;
    }
    rawToModel[i + 1] = modelText.length;
  }
  return {
    modelText,
    rawToModel,
    modelToRaw,
  };
}

function chunkText(node, modelStart) {
  const rawText = node.nodeValue ?? "";
  const transformed = transformText(rawText);
  if (!rawText.length && !transformed.modelText.length) return null;
  return {
    kind: transformed.modelText === rawText ? "text" : "transformed-text",
    node,
    rawText,
    modelText: transformed.modelText,
    modelStart,
    modelEnd: modelStart + transformed.modelText.length,
    domStart: { node, offset: 0 },
    domEnd: { node, offset: rawText.length },
    rawOffsetForModelOffset(offset) {
      return transformed.modelToRaw[Math.max(0, Math.min(offset, transformed.modelToRaw.length - 1))] ?? rawText.length;
    },
    modelOffsetForRawOffset(offset) {
      return transformed.rawToModel[Math.max(0, Math.min(offset, transformed.rawToModel.length - 1))] ?? transformed.modelText.length;
    },
    startAffinity: "after",
    endAffinity: "before",
  };
}

function syntheticChunk(modelStart, modelText, boundary) {
  return {
    kind: "synthetic",
    node: null,
    rawText: "",
    modelText,
    modelStart,
    modelEnd: modelStart + modelText.length,
    domStart: boundary,
    domEnd: boundary,
    rawOffsetForModelOffset: () => 0,
    modelOffsetForRawOffset: () => 0,
    startAffinity: "before",
    endAffinity: "after",
  };
}

function excludedChunk(node, modelStart) {
  return {
    kind: "excluded",
    node,
    rawText: node.textContent ?? "",
    modelText: "",
    modelStart,
    modelEnd: modelStart,
    domStart: childBoundary(node, "before"),
    domEnd: childBoundary(node, "after"),
    rawOffsetForModelOffset: () => 0,
    modelOffsetForRawOffset: () => 0,
    startAffinity: "before",
    endAffinity: "after",
  };
}

function createWalkState(root) {
  const chunks = [];
  const skipCache = new WeakMap();
  let text = "";

  const push = (chunk) => {
    if (!chunk) return;
    chunks.push(chunk);
    text += chunk.modelText;
  };

  const appendSynthetic = (modelText, boundary) => {
    push(syntheticChunk(text.length, modelText, boundary));
  };

  const shouldSkip = (el) => {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (skipCache.has(el)) return skipCache.get(el);
    const skip = el.getAttribute("contenteditable") === "false"
      || el.getAttribute("aria-hidden") === "true"
      || el.hidden === true
      || el.getAttribute("hidden") != null
      || el.getAttribute("role") === "presentation"
      || el.matches?.("br.ProseMirror-trailingBreak");
    skipCache.set(el, skip);
    return skip;
  };

  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      push(chunkText(node, text.length));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node !== root && shouldSkip(node)) {
      push(excludedChunk(node, text.length));
      return;
    }
    const tag = node.tagName;
    if (tag === "BR") {
      appendSynthetic("\n", childBoundary(node, "before") ?? { node, offset: 0 });
      return;
    }
    if (node !== root && BLOCK_TAGS.has(tag) && text && !text.endsWith("\n")) {
      appendSynthetic("\n", childBoundary(node, "before") ?? { node: root, offset: 0 });
    }
    for (const child of node.childNodes) walk(child);
  }

  walk(root);
  return { text, chunks };
}

function boundaryForModelOffset(chunks, offset, affinity = "after") {
  if (!chunks.length) return null;
  let candidate = null;
  for (const chunk of chunks) {
    if (chunk.kind === "excluded") continue;
    if (chunk.kind === "synthetic") {
      if (offset === chunk.modelStart || offset === chunk.modelEnd) {
        candidate = chunk.domStart;
        if (affinity === "before") return candidate;
      }
      continue;
    }
    if (offset >= chunk.modelStart && offset <= chunk.modelEnd) {
      const raw = chunk.rawOffsetForModelOffset(offset - chunk.modelStart);
      candidate = { node: chunk.node, offset: raw };
      if (affinity === "before") return candidate;
    }
  }
  if (candidate) return candidate;
  const lastText = [...chunks].reverse().find((chunk) => chunk.kind === "text" || chunk.kind === "transformed-text");
  return lastText ? { node: lastText.node, offset: lastText.rawText.length } : null;
}

function crossesExcluded(chunks, start, end) {
  return chunks.some((chunk) => chunk.kind === "excluded" && chunk.modelStart > start && chunk.modelEnd < end);
}

function sameMapping(a, b) {
  const relevantA = a.filter((chunk) => chunk.kind !== "synthetic" && chunk.kind !== "excluded");
  const relevantB = b.filter((chunk) => chunk.kind !== "synthetic" && chunk.kind !== "excluded");
  if (relevantA.length !== relevantB.length) return false;
  for (let i = 0; i < relevantA.length; i += 1) {
    const left = relevantA[i];
    const right = relevantB[i];
    if (left.kind !== right.kind || left.node !== right.node) return false;
    if (left.rawText !== right.rawText || left.modelStart !== right.modelStart || left.modelEnd !== right.modelEnd) return false;
  }
  return true;
}

function setSelectionAfter(root, node, offset) {
  const sel = root.ownerDocument?.defaultView?.getSelection?.();
  if (!sel) return;
  const range = root.ownerDocument.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function insertReplacement(range, replacement) {
  range.deleteContents();
  if (!replacement) {
    return { node: range.startContainer, offset: range.startOffset };
  }
  const node = range.startContainer.ownerDocument.createTextNode(replacement);
  range.insertNode(node);
  return { node, offset: replacement.length };
}

export function applyContentEditableCorrection(root, snapshot, correction) {
  const guard = guardedApply(root, snapshot, correction);
  if (!guard) return { applied: false };
  const { start, range, replacement, expected } = guard;
  const scroll = captureScroll(root);
  const beforeinput = createBeforeInputEvent(root, replacement, range);
  const accepted = root.dispatchEvent(beforeinput);
  if (!accepted) {
    // The page cancelled beforeinput — it owns the edit. Applied only if the
    // page's own handling produced the expected text.
    try {
      if (!textEquals(root, expected)) return { applied: false };
      const newCaret = start + replacement.length;
      setSelectionAtModelOffset(root, newCaret);
      return { applied: true, newCaret };
    } finally {
      restoreScroll(root, scroll);
    }
  }

  let caret;
  try {
    caret = insertReplacement(range, replacement);
    if (!textEquals(root, expected)) return { applied: false };
    if (caret) setSelectionAfter(root, caret.node, caret.offset);
    root.dispatchEvent(new (root.ownerDocument?.defaultView?.Event ?? Event)("input", { bubbles: true }));
    return { applied: true, newCaret: start + replacement.length };
  } finally {
    restoreScroll(root, scroll);
  }
}

export function createContentEditableSnapshot(root) {
  const { text, chunks } = createWalkState(root);
  const snapshot = {
    root,
    text,
    revision: chunks.map((chunk) => `${chunk.kind}:${chunk.modelStart}:${chunk.modelEnd}:${chunk.rawText}`).join("|"),
    kind: "dom",
    chunks,
    rangeForSpan(start, end) {
      if (!spanWithinSnapshot(snapshot, start, end)) return null;
      if (crossesExcluded(chunks, start, end)) return null;
      const startBoundary = boundaryForModelOffset(chunks, start, "after");
      const endBoundary = boundaryForModelOffset(chunks, end, "before");
      if (!startBoundary || !endBoundary) return null;
      const range = root.ownerDocument.createRange();
      try {
        range.setStart(startBoundary.node, startBoundary.offset);
        range.setEnd(endBoundary.node, endBoundary.offset);
        return range;
      } catch {
        return null;
      }
    },
    offsetForPoint(node, offset) {
      if (node?.nodeType !== Node.TEXT_NODE) return null;
      for (const chunk of chunks) {
        if ((chunk.kind === "text" || chunk.kind === "transformed-text") && chunk.node === node) {
          return chunk.modelStart + chunk.modelOffsetForRawOffset(offset);
        }
      }
      return null;
    },
    isCurrent() {
      if (!root.isConnected) return false;
      const next = createWalkState(root);
      return next.text === text && sameMapping(chunks, next.chunks);
    },
    dispose() {},
  };
  return snapshot;
}

export const contentEditableAdapter = Object.freeze({
  id: "contenteditable",
  match: isContentEditableField,
  root: (candidate) => isContentEditableField(candidate) ? candidate : null,
  isEligible: isEligibleContentEditableField,
  snapshot: createContentEditableSnapshot,
  apply: applyContentEditableCorrection,
});
