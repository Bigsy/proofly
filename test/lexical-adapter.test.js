import { describe } from "vitest";
import {
  isEligibleLexicalRoot,
  isLexicalRoot,
  lexicalAdapter,
  lexicalRoot,
} from "../page/content/adapters/lexical.js";
import { registerAdapterContractSuite } from "./helpers/adapter-suite.js";

function lexical(html = "<p>I seen it.</p>") {
  const el = document.createElement("div");
  el.dataset.lexicalEditor = "true";
  el.setAttribute("contenteditable", "true");
  el.setAttribute("role", "textbox");
  el.setAttribute("aria-multiline", "true");
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

describe("lexical adapter", () => {
  registerAdapterContractSuite({
    adapter: lexicalAdapter,
    editorName: "Lexical",
    build: lexical,
    isRoot: isLexicalRoot,
    isEligibleRoot: isEligibleLexicalRoot,
    rootFor: lexicalRoot,
    execCommandApply: true,
    chromeOnly: () => {
      const root = document.createElement("div");
      root.dataset.lexicalEditor = "true";
      root.textContent = "Preview";
      document.body.append(root);
      return root;
    },
  });
});
