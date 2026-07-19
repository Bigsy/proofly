import { describe, expect, it, vi } from "vitest";
import { assertAdapter } from "../page/content/adapters/contracts.js";
import {
  applyFormCorrection,
  createFormSnapshot,
  formAdapter,
  isEligibleFormField,
  readFormText,
} from "../page/content/adapters/form.js";
import { assertSnapshot } from "../page/content/snapshot.js";

function textarea(value = "") {
  const el = document.createElement("textarea");
  el.value = value;
  document.body.appendChild(el);
  return el;
}

describe("form adapter", () => {
  it("satisfies the adapter and snapshot contracts", () => {
    const el = textarea("I seen it.");
    expect(assertAdapter(formAdapter)).toBe(formAdapter);
    const snapshot = formAdapter.snapshot(el);
    expect(assertSnapshot(snapshot)).toBe(snapshot);
    expect(snapshot.kind).toBe("form");
    expect(snapshot.text).toBe("I seen it.");
  });

  it("owns form reads and freshness checks", () => {
    const el = textarea("I seen it.");
    const snapshot = createFormSnapshot(el);
    expect(readFormText(el)).toBe("I seen it.");
    expect(snapshot.isCurrent()).toBe(true);
    el.value = "I saw it.";
    expect(snapshot.isCurrent()).toBe(false);
  });

  it("maps ranges and caret offsets through the snapshot", () => {
    const el = textarea("I seen it.");
    el.setSelectionRange(3, 3);
    const snapshot = createFormSnapshot(el);
    expect(snapshot.rangeForSpan(2, 6)).toEqual({ kind: "form", root: el, start: 2, end: 6 });
    expect(snapshot.rangeForSpan(6, 2)).toBe(null);
    expect(snapshot.offsetForPoint(el, 0)).toBe(3);
  });

  it("applies through the native setter contract and preserves scroll/caret", () => {
    const el = textarea("I seen it.");
    el.scrollTop = 12;
    el.scrollLeft = 3;
    const seen = vi.fn();
    el.addEventListener("input", seen);
    const snapshot = createFormSnapshot(el);

    expect(applyFormCorrection(el, snapshot, {
      startIndex: 2,
      endIndex: 6,
      correction: "saw",
    })).toEqual({ applied: true, newCaret: 5 });

    expect(el.value).toBe("I saw it.");
    expect(el.selectionStart).toBe(5);
    expect(el.selectionEnd).toBe(5);
    expect(el.scrollTop).toBe(12);
    expect(el.scrollLeft).toBe(3);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("refuses stale or malformed form corrections", () => {
    const el = textarea("I seen it.");
    const snapshot = createFormSnapshot(el);
    el.value = "I seen it. More.";
    expect(applyFormCorrection(el, snapshot, {
      startIndex: 2,
      endIndex: 6,
      correction: "saw",
    })).toEqual({ applied: false });

    const fresh = createFormSnapshot(el);
    expect(applyFormCorrection(el, fresh, {
      startIndex: 100,
      endIndex: 101,
      correction: "x",
    })).toEqual({ applied: false });
  });

  it("keeps form eligibility separate from contenteditable eligibility", () => {
    const ok = textarea();
    expect(isEligibleFormField(ok)).toBe(true);
    ok.readOnly = true;
    expect(isEligibleFormField(ok)).toBe(false);
  });

  it("honours spellcheck=false on the field itself (same self-only check as contenteditable)", () => {
    const el = textarea("code, not prose");
    expect(isEligibleFormField(el)).toBe(true);
    el.setAttribute("spellcheck", "false");
    expect(isEligibleFormField(el)).toBe(false);
    // Self-only on purpose: an ancestor's spellcheck=false doesn't leak down.
    el.removeAttribute("spellcheck");
    const wrapper = document.createElement("div");
    wrapper.setAttribute("spellcheck", "false");
    wrapper.appendChild(el);
    document.body.appendChild(wrapper);
    try {
      expect(isEligibleFormField(el)).toBe(true);
    } finally {
      wrapper.remove();
    }
  });
});
