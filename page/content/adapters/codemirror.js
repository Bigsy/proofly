import {
  createContentEditableSnapshot,
  hasEditableContent,
} from "./contenteditable.js";
import {
  asElement, captureScroll, guardedApply, restoreScroll, textEquals,
} from "./apply-kit.js";
import { createBridgeClient } from "../bridge/client.js";
import { spanWithinSnapshot } from "../snapshot.js";

export const CODEMIRROR_BRIDGE_REPLACE = "codemirror.replace";
export const CODEMIRROR_BRIDGE_CAPABILITIES = Object.freeze([CODEMIRROR_BRIDGE_REPLACE]);

const PROSE_MODES = new Set([
  "asciidoc",
  "markdown",
  "mediawiki",
  "md",
  "plain",
  "plaintext",
  "text",
  "textile",
  "wiki",
  "wikitext",
]);

const PROGRAMMING_MODES = new Set([
  "c",
  "clojure",
  "cpp",
  "css",
  "go",
  "html",
  "java",
  "javascript",
  "json",
  "jsx",
  "php",
  "python",
  "ruby",
  "rust",
  "shell",
  "sql",
  "tsx",
  "typescript",
  "xml",
  "yaml",
]);

function cm6Content(candidate) {
  const content = asElement(candidate)?.closest?.(".cm-content");
  if (!content?.closest?.(".cm-editor")) return null;
  return content;
}

function cm5Code(candidate) {
  const el = asElement(candidate);
  const direct = el?.closest?.(".CodeMirror-code");
  if (direct?.closest?.(".CodeMirror")) return direct;
  const shell = el?.closest?.(".CodeMirror");
  return shell?.querySelector?.(".CodeMirror-code") ?? null;
}

function isCodeMirror5Root(root) {
  return !!root?.classList?.contains("CodeMirror-code") && !!root.closest?.(".CodeMirror");
}

export function codeMirrorRoot(candidate) {
  return cm6Content(candidate) ?? cm5Code(candidate);
}

export function codeMirrorShell(root) {
  if (!root) return null;
  if (root.classList?.contains("cm-content")) return root.closest?.(".cm-editor") ?? null;
  if (root.classList?.contains("CodeMirror-code")) return root.closest?.(".CodeMirror") ?? null;
  return null;
}

export function isCodeMirrorRoot(el) {
  return !!el
    && el.nodeType === Node.ELEMENT_NODE
    && (cm6Content(el) === el || cm5Code(el) === el);
}

function normalizeMode(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return null;
  const withoutMime = raw
    .replace(/^text\/x-/, "")
    .replace(/^text\//, "")
    .replace(/^application\/x-/, "")
    .replace(/^application\//, "");
  return withoutMime.replace(/^gfm$/, "markdown");
}

export function codeMirrorMode(root) {
  const shell = codeMirrorShell(root);
  const values = [
    root?.dataset?.language,
    root?.dataset?.mode,
    root?.dataset?.codemirrorLanguage,
    shell?.dataset?.language,
    shell?.dataset?.mode,
    shell?.dataset?.codemirrorLanguage,
    root?.getAttribute?.("data-language"),
    shell?.getAttribute?.("data-language"),
  ];
  for (const value of values) {
    const mode = normalizeMode(value);
    if (mode) return mode;
  }
  return null;
}

export function isProseCodeMirrorMode(mode) {
  const normalized = normalizeMode(mode);
  if (!normalized) return false;
  if (normalized.includes(",") || normalized.includes(" ")) return false;
  if (PROGRAMMING_MODES.has(normalized)) return false;
  return PROSE_MODES.has(normalized);
}

export function isEligibleCodeMirrorRoot(root) {
  if (!isCodeMirrorRoot(root)) return false;
  const shell = codeMirrorShell(root);
  if (!shell) return false;
  if (!isProseCodeMirrorMode(codeMirrorMode(root))) return false;
  if (root.classList?.contains("cm-content") && !hasEditableContent(root)) return false;
  if (root.getAttribute?.("aria-hidden") === "true" || root.closest?.("[aria-hidden='true']")) return false;
  if (shell.getAttribute?.("aria-hidden") === "true" || shell.closest?.("[aria-hidden='true']")) return false;
  if (root.getAttribute?.("aria-readonly") === "true" || shell.getAttribute?.("aria-readonly") === "true") return false;
  if (root.getAttribute?.("aria-disabled") === "true" || shell.getAttribute?.("aria-disabled") === "true") return false;
  return true;
}

export function createCodeMirrorSnapshot(root) {
  if (isCodeMirror5Root(root)) return createCodeMirror5Snapshot(root);
  const snapshot = createContentEditableSnapshot(root);
  const mode = codeMirrorMode(root);
  const isCurrent = snapshot.isCurrent.bind(snapshot);
  snapshot.adapter = "codemirror";
  snapshot.codeMirrorMode = mode;
  snapshot.isCurrent = () =>
    isCurrent()
    && codeMirrorMode(root) === mode
    && isEligibleCodeMirrorRoot(root);
  return snapshot;
}

function createTextChunk(node, modelStart) {
  const text = node.nodeValue ?? "";
  return {
    kind: "text",
    node,
    rawText: text,
    modelText: text,
    modelStart,
    modelEnd: modelStart + text.length,
  };
}

function createLineBreakChunk(line, modelStart) {
  return {
    kind: "synthetic",
    node: line,
    rawText: "",
    modelText: "\n",
    modelStart,
    modelEnd: modelStart + 1,
  };
}

function createCodeMirror5Walk(root) {
  const chunks = [];
  let text = "";
  const lines = [...root.querySelectorAll("pre")];
  const sourceLines = lines.length ? lines : [root];
  for (const [lineIndex, line] of sourceLines.entries()) {
    if (lineIndex > 0) {
      const chunk = createLineBreakChunk(line, text.length);
      chunks.push(chunk);
      text += chunk.modelText;
    }
    const walker = root.ownerDocument.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const chunk = createTextChunk(node, text.length);
      if (!chunk.modelText) continue;
      chunks.push(chunk);
      text += chunk.modelText;
    }
  }
  return { text, chunks };
}

function codeMirror5BoundaryForOffset(chunks, offset, side) {
  if (!chunks.length) return null;
  for (const chunk of chunks) {
    if (chunk.kind !== "text") continue;
    if (offset < chunk.modelStart || offset > chunk.modelEnd) continue;
    if (offset === chunk.modelEnd && side === "after") continue;
    return { node: chunk.node, offset: Math.max(0, Math.min(offset - chunk.modelStart, chunk.rawText.length)) };
  }
  if (offset === chunks[chunks.length - 1].modelEnd) {
    const textChunks = chunks.filter((chunk) => chunk.kind === "text");
    const last = textChunks[textChunks.length - 1];
    if (last) return { node: last.node, offset: last.rawText.length };
  }
  return null;
}

function sameCodeMirror5Mapping(a, b) {
  if (a.length !== b.length) return false;
  return a.every((chunk, index) => {
    const next = b[index];
    return chunk.kind === next.kind
      && chunk.node === next.node
      && chunk.modelStart === next.modelStart
      && chunk.modelEnd === next.modelEnd
      && chunk.rawText === next.rawText;
  });
}

function createCodeMirror5Snapshot(root) {
  const { text, chunks } = createCodeMirror5Walk(root);
  const mode = codeMirrorMode(root);
  const snapshot = {
    root,
    text,
    revision: chunks.map((chunk) => `${chunk.kind}:${chunk.modelStart}:${chunk.modelEnd}:${chunk.rawText}`).join("|"),
    kind: "dom",
    adapter: "codemirror",
    codeMirrorMode: mode,
    chunks,
    rangeForSpan(start, end) {
      if (!spanWithinSnapshot(snapshot, start, end)) return null;
      const startBoundary = codeMirror5BoundaryForOffset(chunks, start, "after");
      const endBoundary = codeMirror5BoundaryForOffset(chunks, end, "before");
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
        if (chunk.kind === "text" && chunk.node === node) {
          return chunk.modelStart + Math.max(0, Math.min(offset, chunk.rawText.length));
        }
      }
      return null;
    },
    isCurrent() {
      if (!root.isConnected || codeMirrorMode(root) !== mode || !isEligibleCodeMirrorRoot(root)) return false;
      const next = createCodeMirror5Walk(root);
      return next.text === text && sameCodeMirror5Mapping(chunks, next.chunks);
    },
    dispose() {},
  };
  return snapshot;
}

// CodeMirror scrolls in its shell as well as the content root.
function restoreScrollWithShell(root, scroll) {
  const shell = codeMirrorShell(root);
  if (shell) {
    shell.scrollTop = scroll.shellTop;
    shell.scrollLeft = scroll.shellLeft;
  }
  restoreScroll(root, scroll);
}

async function applyViaCodeMirrorBridge(root, snapshot, start, end, replacement, expected) {
  if (!root.id) return false;
  const client = createBridgeClient({
    allowedCapabilities: CODEMIRROR_BRIDGE_CAPABILITIES,
    timeoutMs: 500,
  });

  try {
    const result = await client.request(CODEMIRROR_BRIDGE_REPLACE, {
      rootId: root.id,
      start,
      end,
      replacement,
      expectedText: snapshot.text.slice(start, end),
      expectedResult: expected,
      mode: snapshot.codeMirrorMode,
    });
    return result?.applied === true;
  } catch {
    return false;
  } finally {
    client.dispose();
  }
}

export async function applyCodeMirrorCorrection(root, snapshot, correction) {
  const guard = guardedApply(root, snapshot, correction);
  if (!guard) return { applied: false };
  const { start, end, replacement, expected } = guard;
  const shell = codeMirrorShell(root);
  const scroll = {
    ...captureScroll(root),
    shellTop: shell?.scrollTop ?? 0,
    shellLeft: shell?.scrollLeft ?? 0,
  };

  try {
    if (!await applyViaCodeMirrorBridge(root, snapshot, start, end, replacement, expected)) {
      return { applied: false };
    }
    if (!textEquals(root, expected)) return { applied: false };
    return { applied: true, newCaret: start + replacement.length };
  } finally {
    restoreScrollWithShell(root, scroll);
  }
}

export const codeMirrorAdapter = Object.freeze({
  id: "codemirror",
  match: (candidate) => !!codeMirrorRoot(candidate),
  root: codeMirrorRoot,
  isEligible: isEligibleCodeMirrorRoot,
  snapshot: createCodeMirrorSnapshot,
  apply: applyCodeMirrorCorrection,
  // A language/mode swap re-decides prose-vs-programming eligibility, so
  // those attribute changes are mapping mutations for this adapter.
  mutationAttributes: Object.freeze(["data-codemirror-language", "data-language", "data-mode"]),
});
