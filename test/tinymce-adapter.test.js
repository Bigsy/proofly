import { describe, expect, it } from "vitest";
import { adapterForField } from "../page/content/adapters/index.js";
import {
  hasTinyMCEProofingPluginState,
  isEligibleTinyMCERoot,
  isTinyMCERoot,
  tinyMCEAdapter,
  tinyMCERoot,
} from "../page/content/adapters/tinymce.js";
import { registerAdapterContractSuite } from "./helpers/adapter-suite.js";

function tinymce(html = "<p>I seen it.</p>") {
  const el = document.createElement("body");
  el.className = "mce-content-body";
  el.setAttribute("contenteditable", "true");
  el.setAttribute("spellcheck", "false");
  el.innerHTML = html;
  document.documentElement.appendChild(el);
  return el;
}

describe("tinymce adapter", () => {
  registerAdapterContractSuite({
    adapter: tinyMCEAdapter,
    editorName: "TinyMCE",
    build: tinymce,
    isRoot: isTinyMCERoot,
    isEligibleRoot: isEligibleTinyMCERoot,
    rootFor: tinyMCERoot,
    execCommandApply: true,
    chromeOnly: () => {
      const root = document.createElement("div");
      root.className = "mce-content-body";
      root.textContent = "Preview";
      document.body.append(root);
      return root;
    },
  });

  it("fails closed when TinyMCE proofing plugin state is visible", () => {
    const root = tinymce('<p>I <span class="mce-spellchecker-word">seen</span> it.</p>');
    expect(hasTinyMCEProofingPluginState(root)).toBe(true);
    expect(isEligibleTinyMCERoot(root)).toBe(false);
    expect(adapterForField(root)).toBe(null);
  });
});
