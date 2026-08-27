import { afterEach, describe, expect, it } from "vitest";
import { createMockProofreader } from "./helpers/mock-proofreader.js";
import {
  field,
  focusField,
  loadContentPage,
  teardownContentPage,
  tick,
  typeInField,
} from "./helpers/content-page.js";
import { isEligibleField } from "../page/content/detect.js";

afterEach(() => {
  teardownContentPage();
});

describe("baseline eligibility locks", () => {
  it("delegated focus activates a dynamically mounted textarea", async () => {
    const mock = createMockProofreader({ availability: "available" });
    await loadContentPage({ mock, html: '<main id="mount"></main>' });
    const textarea = document.createElement("textarea");
    textarea.id = "field";
    document.getElementById("mount").appendChild(textarea);
    focusField(textarea);
    typeInField("I seen it.", textarea);
    await tick(1000);
    expect(mock.ledger.instances).toHaveLength(1);
    expect(mock.ledger.instances[0].proofreadCalls).toEqual(["I seen it."]);
  });

  it("activates GitHub's dynamically mounted inline review textarea despite spellcheck=false", async () => {
    const mock = createMockProofreader({ availability: "available" });
    await loadContentPage({ mock, html: '<main id="mount"></main>' });
    const thread = document.createElement("div");
    thread.dataset.markerId = "thread-1";
    thread.innerHTML = '<textarea id="field" aria-label="Markdown value" spellcheck="false"></textarea>';
    document.getElementById("mount").appendChild(thread);
    focusField(field());
    typeInField("This coment needs proofreading.");
    await tick(1000);
    expect(mock.ledger.instances).toHaveLength(1);
    expect(mock.ledger.instances[0].proofreadCalls).toEqual(["This coment needs proofreading."]);
  });

  it("does not broaden ordinary contenteditable eligibility beyond textbox-role composers", () => {
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    expect(isEligibleField(editor)).toBe(false);
    editor.setAttribute("role", "textbox");
    expect(isEligibleField(editor)).toBe(true);
  });

  it("leaves spellcheck=false ordinary rich-editor fixtures ineligible until the gated adapter exists", async () => {
    const mock = createMockProofreader({ availability: "available" });
    await loadContentPage({
      mock,
      html: '<div id="field" contenteditable="true" spellcheck="false">I seen it.</div>',
    });
    focusField(field());
    field().dispatchEvent(new Event("input", { bubbles: true }));
    await tick(2000);
    expect(mock.ledger.instances).toHaveLength(0);
  });
});
