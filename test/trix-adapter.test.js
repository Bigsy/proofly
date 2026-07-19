import { describe } from "vitest";
import {
  isEligibleTrixRoot,
  isTrixRoot,
  trixAdapter,
  trixRoot,
} from "../page/content/adapters/trix.js";
import { registerAdapterContractSuite } from "./helpers/adapter-suite.js";

function trix(html = "<div>I seen it.</div>") {
  const el = document.createElement("trix-editor");
  el.setAttribute("contenteditable", "true");
  el.setAttribute("role", "textbox");
  el.setAttribute("aria-multiline", "true");
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

describe("trix adapter", () => {
  registerAdapterContractSuite({
    adapter: trixAdapter,
    editorName: "Trix",
    build: trix,
    isRoot: isTrixRoot,
    isEligibleRoot: isEligibleTrixRoot,
    rootFor: trixRoot,
    execCommandApply: true,
    chromeOnly: () => {
      const root = document.createElement("trix-editor");
      root.textContent = "Preview";
      document.body.append(root);
      return root;
    },
    extraRefusals: [(root) => root.setAttribute("disabled", "")],
  });
});
