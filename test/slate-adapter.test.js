import { describe } from "vitest";
import {
  isEligibleSlateRoot,
  isSlateRoot,
  slateAdapter,
  slateRoot,
} from "../page/content/adapters/slate.js";
import { registerAdapterContractSuite } from "./helpers/adapter-suite.js";

function slate(html = "<p>I seen it.</p>") {
  const el = document.createElement("div");
  el.dataset.slateEditor = "true";
  el.setAttribute("contenteditable", "true");
  el.setAttribute("role", "textbox");
  el.setAttribute("aria-multiline", "true");
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

describe("slate adapter", () => {
  registerAdapterContractSuite({
    adapter: slateAdapter,
    editorName: "Slate",
    build: slate,
    isRoot: isSlateRoot,
    isEligibleRoot: isEligibleSlateRoot,
    rootFor: slateRoot,
    execCommandApply: true,
    chromeOnly: () => {
      const root = document.createElement("div");
      root.dataset.slateEditor = "true";
      root.textContent = "Preview";
      document.body.append(root);
      return root;
    },
  });
});
