import { describe, expect, it, vi } from "vitest";
import { adapterForField, resolveAdapterRoot } from "../page/content/adapters/index.js";
import {
  ckeditor5Adapter,
  ckeditor5Root,
  isCKEditor5Root,
  isEligibleCKEditor5Root,
} from "../page/content/adapters/ckeditor5.js";
import { registerAdapterContractSuite } from "./helpers/adapter-suite.js";

function ckeditor(html = "<p>I seen it.</p>") {
  const el = document.createElement("div");
  el.className = "ck ck-content ck-editor__editable ck-rounded-corners";
  el.setAttribute("contenteditable", "true");
  el.setAttribute("role", "textbox");
  el.setAttribute("aria-multiline", "true");
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

describe("ckeditor5 adapter", () => {
  registerAdapterContractSuite({
    adapter: ckeditor5Adapter,
    editorName: "CKEditor 5",
    build: ckeditor,
    isRoot: isCKEditor5Root,
    isEligibleRoot: isEligibleCKEditor5Root,
    rootFor: ckeditor5Root,
    // CKEditor 5 writes through beforeinput, not execCommand — its apply
    // cases live below.
    execCommandApply: false,
  });

  it("normalizes CKEditor nested editables to the owning logical root", () => {
    const root = ckeditor(`
      <section class="ck-widget">
        <div class="ck-editor__nested-editable" contenteditable="true">
          <p>Nested caption</p>
        </div>
      </section>
      <p>I seen it.</p>
    `);
    const nested = root.querySelector(".ck-editor__nested-editable");
    expect(ckeditor5Root(nested)).toBe(root);
    expect(resolveAdapterRoot(nested.querySelector("p"))).toBe(root);
  });

  it("keeps genuinely independent nested editors separate", () => {
    const outer = ckeditor("<p>Outer editor.</p>");
    const inner = ckeditor("<p>Inner editor.</p>");
    outer.append(inner);

    expect(ckeditor5Root(inner)).toBe(inner);
    expect(resolveAdapterRoot(inner.querySelector("p"))).toBe(inner);
  });

  it("applies only when CKEditor consumes beforeinput and produces the verified text", async () => {
    const root = ckeditor("<p><span>I </span><strong>seen</strong><span> it.</span></p>");
    const seen = vi.fn();
    const beforeInputs = [];
    root.addEventListener("beforeinput", (event) => {
      beforeInputs.push({
        inputType: event.inputType,
        data: event.data,
        ranges: event.getTargetRanges?.().length ?? 0,
      });
      const selection = getSelection();
      const range = selection.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode(event.data));
    });
    root.addEventListener("input", seen);
    const snapshot = ckeditor5Adapter.snapshot(root);
    expect(snapshot.text).toBe("I seen it.");

    await expect(ckeditor5Adapter.apply(root, snapshot, {
      startIndex: 2,
      endIndex: 6,
      correction: "saw",
    })).resolves.toEqual({ applied: true, newCaret: 5 });

    expect(ckeditor5Adapter.snapshot(root).text).toBe("I saw it.");
    expect(beforeInputs).toEqual([{ inputType: "insertReplacementText", data: "saw", ranges: 1 }]);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("fails closed when CKEditor does not consume beforeinput", async () => {
    const root = ckeditor("<p>I seen it.</p>");
    const snapshot = ckeditor5Adapter.snapshot(root);
    await expect(ckeditor5Adapter.apply(root, snapshot, {
      startIndex: 2,
      endIndex: 6,
      correction: "saw",
    })).resolves.toEqual({ applied: false });
    expect(ckeditor5Adapter.snapshot(root).text).toBe("I seen it.");
  });

  it("refuses nested-only editables", () => {
    const nestedOnly = document.createElement("div");
    nestedOnly.className = "ck ck-editor__editable ck-editor__nested-editable";
    nestedOnly.setAttribute("contenteditable", "true");
    document.body.append(nestedOnly);
    expect(adapterForField(nestedOnly)).toBe(null);
  });
});
