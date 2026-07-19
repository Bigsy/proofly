import { createContentEditableSnapshot, hasEditableContent } from "./contenteditable.js";
import {
  asElement, captureScroll, execCommandInsert, guardedApply, isEligibleEditableRoot,
  restoreScroll, setSelectionAtModelOffset, textEquals,
} from "./apply-kit.js";
import { createBridgeClient } from "../bridge/client.js";

export const TRIX_BRIDGE_REPLACE = "trix.replace";
export const TRIX_BRIDGE_CAPABILITIES = Object.freeze([TRIX_BRIDGE_REPLACE]);

export function isTrixRoot(el) {
  return !!el
    && el.nodeType === Node.ELEMENT_NODE
    && el.localName === "trix-editor"
    && hasEditableContent(el);
}

export function trixRoot(candidate) {
  const closest = asElement(candidate)?.closest?.("trix-editor");
  return isTrixRoot(closest) ? closest : null;
}

export function isEligibleTrixRoot(el) {
  if (!isTrixRoot(el)) return false;
  if (el.disabled === true || el.hasAttribute?.("disabled")) return false;
  return isEligibleEditableRoot(el);
}

async function applyViaTrixBridge(root, snapshot, start, end, replacement, expected) {
  if (!root.id) return false;
  const client = createBridgeClient({
    allowedCapabilities: TRIX_BRIDGE_CAPABILITIES,
    timeoutMs: 500,
  });

  try {
    const result = await client.request(TRIX_BRIDGE_REPLACE, {
      rootId: root.id,
      start,
      end,
      replacement,
      expectedText: snapshot.text.slice(start, end),
      expectedResult: expected,
    });
    return result?.applied === true;
  } catch {
    return false;
  } finally {
    client.dispose();
  }
}

// Three channels, in order of fidelity: the element's Trix editor API (same
// world), the MAIN-world bridge, then the generic execCommand path.
export async function applyTrixCorrection(root, snapshot, correction) {
  const guard = guardedApply(root, snapshot, correction);
  if (!guard) return { applied: false };
  const { start, end, range, replacement, expected } = guard;
  const scroll = captureScroll(root);
  try {
    let usedTrixApi = false;
    if (root.editor && typeof root.editor.setSelectedRange === "function" && typeof root.editor.insertString === "function") {
      root.editor.recordUndoEntry?.("Proofly");
      root.editor.setSelectedRange([start, end]);
      root.editor.insertString(replacement);
      usedTrixApi = true;
    } else if (await applyViaTrixBridge(root, snapshot, start, end, replacement, expected)) {
      usedTrixApi = true;
    } else if (!execCommandInsert(root, range, replacement)) {
      return { applied: false };
    }
    if (!textEquals(root, expected)) return { applied: false };
    const newCaret = start + replacement.length;
    if (!usedTrixApi) setSelectionAtModelOffset(root, newCaret);
    return { applied: true, newCaret };
  } finally {
    restoreScroll(root, scroll);
  }
}

export const trixAdapter = Object.freeze({
  id: "trix",
  match: (candidate) => !!trixRoot(candidate),
  root: trixRoot,
  isEligible: isEligibleTrixRoot,
  snapshot: createContentEditableSnapshot,
  apply: applyTrixCorrection,
});
