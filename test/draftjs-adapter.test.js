import { describe } from "vitest";
import {
  draftJSAdapter,
  draftJSRoot,
  isDraftJSRoot,
  isEligibleDraftJSRoot,
} from "../page/content/adapters/draftjs.js";
import { registerAdapterContractSuite } from "./helpers/adapter-suite.js";

function draftjs(html = "<div>I seen it.</div>") {
  const el = document.createElement("div");
  el.className = "public-DraftEditor-content";
  el.setAttribute("contenteditable", "true");
  el.setAttribute("role", "textbox");
  el.setAttribute("aria-multiline", "true");
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

describe("draftjs adapter", () => {
  registerAdapterContractSuite({
    adapter: draftJSAdapter,
    editorName: "DraftJS",
    build: draftjs,
    isRoot: isDraftJSRoot,
    isEligibleRoot: isEligibleDraftJSRoot,
    rootFor: draftJSRoot,
    execCommandApply: true,
    chromeOnly: () => {
      const root = document.createElement("div");
      root.className = "public-DraftEditor-content";
      root.textContent = "Preview";
      document.body.append(root);
      return root;
    },
  });
});
