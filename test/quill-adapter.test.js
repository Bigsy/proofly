import { describe, expect, it } from "vitest";
import { adapterForField } from "../page/content/adapters/index.js";
import {
  isEligibleQuillRoot,
  isQuillRoot,
  quillAdapter,
  quillRoot,
} from "../page/content/adapters/quill.js";
import { registerAdapterContractSuite } from "./helpers/adapter-suite.js";

function quill(html = "<p>I seen it.</p>") {
  const container = document.createElement("div");
  container.className = "ql-container ql-snow";
  const el = document.createElement("div");
  el.className = "ql-editor";
  el.setAttribute("contenteditable", "true");
  el.setAttribute("role", "textbox");
  el.setAttribute("aria-multiline", "true");
  el.innerHTML = html;
  container.appendChild(el);
  document.body.appendChild(container);
  return el;
}

describe("quill adapter", () => {
  registerAdapterContractSuite({
    adapter: quillAdapter,
    editorName: "Quill",
    build: quill,
    isRoot: isQuillRoot,
    isEligibleRoot: isEligibleQuillRoot,
    rootFor: quillRoot,
    execCommandApply: true,
  });

  it("does not claim Slack-shaped ql-editor roots without a Quill container", () => {
    const root = document.createElement("div");
    root.className = "ql-editor ql-blank";
    root.dataset.qa = "texty_input";
    root.setAttribute("contenteditable", "true");
    root.setAttribute("role", "textbox");
    root.setAttribute("aria-multiline", "true");
    document.body.append(root);

    expect(quillRoot(root)).toBe(null);
    expect(adapterForField(root)?.id).toBe("contenteditable");
  });
});
