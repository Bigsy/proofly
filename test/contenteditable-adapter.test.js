import { describe, expect, it } from "vitest";
import { assertAdapter } from "../page/content/adapters/contracts.js";
import {
  applyContentEditableCorrection,
  contentEditableAdapter,
  createContentEditableSnapshot,
  isEligibleContentEditableField,
} from "../page/content/adapters/contenteditable.js";
import { assertSnapshot } from "../page/content/snapshot.js";

function editor(html) {
  const el = document.createElement("div");
  el.setAttribute("contenteditable", "true");
  el.setAttribute("role", "textbox");
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

describe("contenteditable adapter", () => {
  it("satisfies the adapter and snapshot contracts", () => {
    const root = editor("I seen it.");
    expect(assertAdapter(contentEditableAdapter)).toBe(contentEditableAdapter);
    const snapshot = createContentEditableSnapshot(root);
    expect(assertSnapshot(snapshot)).toBe(snapshot);
    expect(snapshot.kind).toBe("dom");
    expect(snapshot.text).toBe("I seen it.");
  });

  it("normalizes block boundaries and br elements into explicit newlines", () => {
    const root = editor("<p>Hello<br>there</p><p>World</p>");
    const snapshot = createContentEditableSnapshot(root);
    expect(snapshot.text).toBe("Hello\nthere\nWorld");
  });

  it("keeps empty br-only blocks as model newlines", () => {
    const root = editor("<p><br></p>");
    const snapshot = createContentEditableSnapshot(root);
    expect(snapshot.text).toBe("\n");
  });

  it("maps transformed NBSP and zero-width text in both directions", () => {
    const root = editor("A&nbsp;\u200Bword");
    const text = root.firstChild;
    const snapshot = createContentEditableSnapshot(root);
    expect(snapshot.text).toBe("A word");
    expect(snapshot.offsetForPoint(text, 2)).toBe(2);
    expect(snapshot.offsetForPoint(text, 3)).toBe(2);
    expect(snapshot.offsetForPoint(text, 4)).toBe(3);
    const range = snapshot.rangeForSpan(0, snapshot.text.length);
    expect(range.startContainer).toBe(text);
    expect(range.startOffset).toBe(0);
    expect(range.endContainer).toBe(text);
    expect(range.endOffset).toBe(text.nodeValue.length);
  });

  it("maps supported multi-node spans to DOM ranges", () => {
    const root = editor("<span>I </span><strong>seen</strong><span> it.</span>");
    const snapshot = createContentEditableSnapshot(root);
    expect(snapshot.text).toBe("I seen it.");
    const range = snapshot.rangeForSpan(2, 6);
    expect(range).not.toBe(null);
    expect(range.toString()).toBe("seen");
  });

  it("returns null for spans crossing excluded islands", () => {
    const root = editor('Hello <span contenteditable="false">@Ada</span> world');
    const snapshot = createContentEditableSnapshot(root);
    expect(snapshot.text).toBe("Hello  world");
    expect(snapshot.rangeForSpan(0, snapshot.text.length)).toBe(null);
  });

  it("uses mapped node identity for freshness, so same-text replacement is stale", () => {
    const root = editor("I seen it.");
    const snapshot = createContentEditableSnapshot(root);
    expect(snapshot.isCurrent()).toBe(true);
    root.textContent = "I seen it.";
    expect(snapshot.isCurrent()).toBe(false);
  });

  it("does not make ignored zero-width islands part of freshness identity", () => {
    const root = editor('I <span contenteditable="false">::</span>seen it.');
    const snapshot = createContentEditableSnapshot(root);
    expect(snapshot.text).toBe("I seen it.");
    const next = document.createElement("span");
    next.setAttribute("contenteditable", "false");
    next.textContent = "!!";
    root.querySelector("[contenteditable='false']").replaceWith(next);
    expect(snapshot.isCurrent()).toBe(true);
  });

  it("checks generic contenteditable eligibility without broadening spellcheck=false", () => {
    const root = editor("I seen it.");
    expect(isEligibleContentEditableField(root)).toBe(true);
    root.setAttribute("spellcheck", "false");
    expect(isEligibleContentEditableField(root)).toBe(false);
  });

  it("applies a mapped replacement and dispatches exactly one input event", () => {
    const root = editor("I seen it.");
    const snapshot = createContentEditableSnapshot(root);
    const before = [];
    const input = [];
    root.addEventListener("beforeinput", (event) => {
      before.push({
        inputType: event.inputType,
        data: event.data,
        ranges: event.getTargetRanges?.().length ?? 0,
      });
    });
    root.addEventListener("input", () => input.push(root.textContent));

    expect(applyContentEditableCorrection(root, snapshot, {
      startIndex: 2,
      endIndex: 6,
      correction: "saw",
    })).toEqual({ applied: true, newCaret: 5 });

    expect(root.textContent).toBe("I saw it.");
    expect(before).toEqual([{ inputType: "insertReplacementText", data: "saw", ranges: 1 }]);
    expect(input).toEqual(["I saw it."]);
    expect(window.getSelection().anchorNode.nodeValue).toBe("saw");
    expect(window.getSelection().anchorOffset).toBe(3);
  });

  it("applies insertions, deletions, and multi-node spans through the same snapshot mapping", () => {
    const inserted = editor("In France we ate.");
    expect(applyContentEditableCorrection(inserted, createContentEditableSnapshot(inserted), {
      startIndex: 9,
      endIndex: 9,
      correction: ",",
    }).applied).toBe(true);
    expect(inserted.textContent).toBe("In France, we ate.");

    const deleted = editor("very very good");
    expect(applyContentEditableCorrection(deleted, createContentEditableSnapshot(deleted), {
      startIndex: 0,
      endIndex: 5,
      correction: "",
    }).applied).toBe(true);
    expect(deleted.textContent).toBe("very good");

    const multi = editor("<span>I </span><strong>seen</strong><span> it.</span>");
    expect(applyContentEditableCorrection(multi, createContentEditableSnapshot(multi), {
      startIndex: 2,
      endIndex: 6,
      correction: "saw",
    }).applied).toBe(true);
    expect(createContentEditableSnapshot(multi).text).toBe("I saw it.");
  });

  it("treats canceled beforeinput as a notification seam, not an editing command", () => {
    const root = editor("I seen it.");
    const input = [];
    root.addEventListener("beforeinput", (event) => event.preventDefault());
    root.addEventListener("input", () => input.push(root.textContent));

    expect(applyContentEditableCorrection(root, createContentEditableSnapshot(root), {
      startIndex: 2,
      endIndex: 6,
      correction: "saw",
    })).toEqual({ applied: false });

    expect(root.textContent).toBe("I seen it.");
    expect(input).toEqual([]);
  });

  it("accepts a canceled beforeinput only when the host already made the intended edit", () => {
    const root = editor("I seen it.");
    root.addEventListener("beforeinput", (event) => {
      event.preventDefault();
      root.textContent = "I saw it.";
    });

    expect(applyContentEditableCorrection(root, createContentEditableSnapshot(root), {
      startIndex: 2,
      endIndex: 6,
      correction: "saw",
    })).toEqual({ applied: true, newCaret: 5 });
    expect(root.textContent).toBe("I saw it.");
  });

  it("refuses stale, malformed, and excluded contenteditable corrections", () => {
    const root = editor("I seen it.");
    const snapshot = createContentEditableSnapshot(root);
    root.textContent = "I seen it. More.";
    expect(applyContentEditableCorrection(root, snapshot, {
      startIndex: 2,
      endIndex: 6,
      correction: "saw",
    })).toEqual({ applied: false });

    const fresh = createContentEditableSnapshot(root);
    expect(applyContentEditableCorrection(root, fresh, {
      startIndex: 99,
      endIndex: 100,
      correction: "x",
    })).toEqual({ applied: false });

    const excluded = editor('Hello <span contenteditable="false">@Ada</span> world');
    const blocked = createContentEditableSnapshot(excluded);
    expect(applyContentEditableCorrection(excluded, blocked, {
      startIndex: 0,
      endIndex: blocked.text.length,
      correction: "Hello Ada world",
    })).toEqual({ applied: false });
    expect(excluded.textContent).toBe("Hello @Ada world");
  });
});
