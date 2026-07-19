import { describe, expect, it } from "vitest";
import { adapterForField, resolveAdapterRoot } from "../page/content/adapters/index.js";
import {
  ckeditor4Adapter,
  ckeditor4Root,
  isCKEditor4Root,
  isEligibleCKEditor4Root,
} from "../page/content/adapters/ckeditor4.js";
import { registerAdapterContractSuite } from "./helpers/adapter-suite.js";

function ckeditor(html = "<p>I seen it.</p>") {
  const el = document.createElement("div");
  el.className = "cke_editable cke_editable_inline cke_contents_ltr";
  el.setAttribute("contenteditable", "true");
  el.setAttribute("role", "textbox");
  el.setAttribute("aria-multiline", "true");
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

describe("ckeditor4 adapter", () => {
  registerAdapterContractSuite({
    adapter: ckeditor4Adapter,
    editorName: "CKEditor 4",
    build: ckeditor,
    isRoot: isCKEditor4Root,
    isEligibleRoot: isEligibleCKEditor4Root,
    rootFor: ckeditor4Root,
    execCommandApply: true,
  });

  it("normalizes CKEditor nested editables to the owning logical root", () => {
    const root = ckeditor(`
      <section class="cke_widget_wrapper">
        <div class="cke_nested_editable" contenteditable="true">
          <p>Nested caption</p>
        </div>
      </section>
      <p>I seen it.</p>
    `);
    const nested = root.querySelector(".cke_nested_editable");
    expect(ckeditor4Root(nested)).toBe(root);
    expect(resolveAdapterRoot(nested.querySelector("p"))).toBe(root);
  });

  it("keeps genuinely independent nested editors separate", () => {
    const outer = ckeditor("<p>Outer editor.</p>");
    const inner = ckeditor("<p>Inner editor.</p>");
    outer.append(inner);

    expect(ckeditor4Root(inner)).toBe(inner);
    expect(resolveAdapterRoot(inner.querySelector("p"))).toBe(inner);
  });

  it("refuses nested-only editables", () => {
    const nestedOnly = document.createElement("div");
    nestedOnly.className = "cke_editable cke_nested_editable";
    nestedOnly.setAttribute("contenteditable", "true");
    document.body.append(nestedOnly);
    expect(adapterForField(nestedOnly)).toBe(null);
  });
});
