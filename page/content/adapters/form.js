import { spanWithinSnapshot } from "../snapshot.js";

// Prose-bearing inputs only: url/tel values are never prose, so proofreading
// them produces only noise (and "corrected" phone numbers).
const TEXT_INPUT_TYPES = new Set(["text", "search"]);

export function isFormField(el) {
  if (!el) return false;
  if (el.closest?.(".CodeMirror")) return false;
  if (el.tagName === "TEXTAREA") return true;
  if (el.tagName === "INPUT") return TEXT_INPUT_TYPES.has((el.type || "text").toLowerCase());
  return false;
}

export function isEligibleFormField(el) {
  if (!isUsableFormField(el)) return false;
  // The page's own "don't check this" signal (code-editor textareas, ID
  // fields) — same self-only check as the contenteditable adapter's.
  if (el.getAttribute?.("spellcheck") === "false") return false;
  return true;
}

// Physical form-field eligibility without interpreting spellcheck=false.
// Site/editor adapters may reuse the textarea snapshot and writeback contract
// when a known prose editor disables the browser's native spellchecker for
// reasons that do not amount to a "do not proofread" signal.
export function isUsableFormField(el) {
  if (!isFormField(el) || el.disabled || el.readOnly) return false;
  if (el.getAttribute?.("aria-readonly") === "true") return false;
  if (el.getAttribute?.("aria-hidden") === "true" || el.closest?.("[aria-hidden='true']")) return false;
  return true;
}

export function readFormText(field) {
  return field?.value ?? "";
}

function nativeValueSetter(field) {
  const proto = field.tagName === "TEXTAREA"
    ? globalThis.HTMLTextAreaElement?.prototype
    : globalThis.HTMLInputElement?.prototype;
  return proto && Object.getOwnPropertyDescriptor(proto, "value")?.set;
}

export function setNativeValue(field, value) {
  const setter = nativeValueSetter(field);
  if (setter) setter.call(field, value);
  else field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

export function createFormSnapshot(root) {
  const text = readFormText(root);
  const snapshot = {
    root,
    text,
    revision: text,
    kind: "form",
    rangeForSpan(start, end) {
      return spanWithinSnapshot(snapshot, start, end)
        ? { kind: "form", root, start, end }
        : null;
    },
    offsetForPoint() {
      try {
        const pos = root.selectionStart;
        return Number.isInteger(pos) ? pos : null;
      } catch {
        return null;
      }
    },
    isCurrent() {
      return root.isConnected && readFormText(root) === text;
    },
    dispose() {},
  };
  return snapshot;
}

export function applyFormCorrection(root, snapshot, correction) {
  if (!snapshot?.isCurrent?.() || snapshot.root !== root) return { applied: false };
  const start = Number(correction?.startIndex);
  const end = Number(correction?.endIndex);
  if (!spanWithinSnapshot(snapshot, start, end)) return { applied: false };

  const replacement = correction.correction ?? "";
  const { scrollTop, scrollLeft } = root;
  setNativeValue(root, snapshot.text.slice(0, start) + replacement + snapshot.text.slice(end));

  const caret = start + replacement.length;
  try { root.setSelectionRange(caret, caret); } catch { /* type without selection API */ }
  root.scrollTop = scrollTop;
  root.scrollLeft = scrollLeft;
  return { applied: true, newCaret: caret };
}

export const formAdapter = Object.freeze({
  id: "form",
  match: isFormField,
  root: (candidate) => isFormField(candidate) ? candidate : null,
  isEligible: isEligibleFormField,
  snapshot: createFormSnapshot,
  apply: applyFormCorrection,
});
