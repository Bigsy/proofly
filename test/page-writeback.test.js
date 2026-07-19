// page/content/writeback.js — applying fixes into arbitrary pages' fields:
// the native-setter + input-event contract (controlled inputs must see the
// change), the stale-text refusal, and caret placement.

import { describe, expect, it, vi } from "vitest";
import { applyCorrectionsToField, applyCorrectionToField, setNativeValue } from "../page/content/writeback.js";

function textarea(value = "") {
  const el = document.createElement("textarea");
  el.value = value;
  document.body.appendChild(el);
  return el;
}

function contenteditable(value = "") {
  const el = document.createElement("div");
  el.setAttribute("contenteditable", "true");
  el.setAttribute("role", "textbox");
  el.textContent = value;
  document.body.appendChild(el);
  return el;
}

// A React-style value tracker: frameworks shadow `value` on the element
// INSTANCE to detect changes; writes that go through the instance setter are
// treated as "already known" and the input event gets deduped away. The
// whole point of the native-prototype-setter trick is to bypass this.
function installValueTracker(el) {
  const native = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
  const tracker = { instanceSets: [] };
  Object.defineProperty(el, "value", {
    configurable: true,
    get() { return native.get.call(this); },
    set(v) {
      tracker.instanceSets.push(v);
      native.set.call(this, v);
    },
  });
  return tracker;
}

describe("setNativeValue", () => {
  it("sets the value and fires a bubbling input event", () => {
    const el = textarea("old");
    const seen = vi.fn();
    document.body.addEventListener("input", (e) => seen(e.target.value, e.bubbles));
    setNativeValue(el, "new");
    expect(el.value).toBe("new");
    expect(seen).toHaveBeenCalledWith("new", true);
  });

  it("bypasses an instance-level value tracker (controlled-input harness)", () => {
    const el = textarea("old");
    const tracker = installValueTracker(el);
    setNativeValue(el, "new");
    expect(el.value).toBe("new");           // visible through the tracker's getter
    expect(tracker.instanceSets).toEqual([]); // but its setter never saw the write
  });
});

describe("applyCorrectionToField", () => {
  const text = "I seen him.";
  const c = { startIndex: 2, endIndex: 6, correction: "saw" };

  it("splices the correction and fires input", () => {
    const el = textarea(text);
    const seen = vi.fn();
    el.addEventListener("input", seen);
    expect(applyCorrectionToField(el, text, c)).toBe(true);
    expect(el.value).toBe("I saw him.");
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("leaves the caret right after the applied fix", () => {
    const el = textarea(text);
    applyCorrectionToField(el, text, c);
    expect(el.selectionStart).toBe(2 + "saw".length);
    expect(el.selectionEnd).toBe(2 + "saw".length);
  });

  it("handles zero-width insertions", () => {
    const el = textarea("In France we ate.");
    const ins = { startIndex: 9, endIndex: 9, correction: "," };
    expect(applyCorrectionToField(el, "In France we ate.", ins)).toBe(true);
    expect(el.value).toBe("In France, we ate.");
  });

  it("refuses when the field moved on (stale correction)", () => {
    const el = textarea("I seen him. And more typing");
    const seen = vi.fn();
    el.addEventListener("input", seen);
    expect(applyCorrectionToField(el, text, c)).toBe(false);
    expect(el.value).toBe("I seen him. And more typing"); // untouched
    expect(seen).not.toHaveBeenCalled();
  });

  it("refuses malformed spans", () => {
    const el = textarea(text);
    expect(applyCorrectionToField(el, text, { startIndex: NaN, endIndex: 4, correction: "x" })).toBe(false);
    expect(applyCorrectionToField(el, text, { startIndex: 6, endIndex: 2, correction: "x" })).toBe(false);
    expect(applyCorrectionToField(el, text, { startIndex: 0, endIndex: 999, correction: "x" })).toBe(false);
    expect(el.value).toBe(text);
  });

  it("splices corrections into contenteditable textbox text", () => {
    const el = contenteditable(text);
    const seen = vi.fn();
    el.addEventListener("input", seen);
    expect(applyCorrectionToField(el, text, c)).toBe(true);
    expect(el.textContent).toBe("I saw him.");
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("refuses a stale contenteditable correction", () => {
    const el = contenteditable(`${text} more`);
    expect(applyCorrectionToField(el, text, c)).toBe(false);
    expect(el.textContent).toBe(`${text} more`);
  });
});

describe("applyCorrectionsToField", () => {
  it("splices multiple filtered corrections into a textarea with one input event", () => {
    const text = "I seen it and teh result.";
    const el = textarea(text);
    const seen = vi.fn();
    el.addEventListener("input", seen);

    expect(applyCorrectionsToField(el, text, [
      { startIndex: 2, endIndex: 6, correction: "saw" },
      { startIndex: 14, endIndex: 17, correction: "the" },
    ])).toBe(true);

    expect(el.value).toBe("I saw it and the result.");
    expect(seen).toHaveBeenCalledTimes(1);
    expect(el.selectionStart).toBe("I saw it and the result.".length);
  });

  it("refuses stale whole-text apply-all writes", () => {
    const text = "I seen it.";
    const el = textarea(`${text} More typing`);
    const seen = vi.fn();
    el.addEventListener("input", seen);

    expect(applyCorrectionsToField(el, text, [
      { startIndex: 2, endIndex: 6, correction: "saw" },
    ])).toBe(false);

    expect(el.value).toBe(`${text} More typing`);
    expect(seen).not.toHaveBeenCalled();
  });

  it("does not write or dispatch input when every correction is invalid", () => {
    const text = "I seen it.";
    const el = textarea(text);
    const seen = vi.fn();
    el.addEventListener("input", seen);

    expect(applyCorrectionsToField(el, text, [
      { startIndex: -1, endIndex: 6, correction: "saw" },
      { startIndex: 0, endIndex: 999, correction: "bad" },
    ])).toBe(false);

    expect(el.value).toBe(text);
    expect(seen).not.toHaveBeenCalled();
  });

  it("splices multiple corrections into a contenteditable textbox", () => {
    const text = "I seen it and teh result.";
    const el = contenteditable(text);
    const seen = vi.fn();
    el.addEventListener("input", seen);

    expect(applyCorrectionsToField(el, text, [
      { startIndex: 2, endIndex: 6, correction: "saw" },
      { startIndex: 14, endIndex: 17, correction: "the" },
    ])).toBe(true);

    expect(el.textContent).toBe("I saw it and the result.");
    expect(seen).toHaveBeenCalledTimes(1);
  });
});
