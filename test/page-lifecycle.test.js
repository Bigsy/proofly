// page/content/index.js — the in-page lifecycle: focus-driven activation, the
// lint-on-pause debounce, the visibility/focus hard gate, supersede on
// edit, and the squiggle → popup → Apply loop (structure only — rects are
// stubbed inputs, never assertions; see helpers/content-page.js).

import { afterEach, describe, expect, it, vi } from "vitest";
import { EDITOR_ADAPTER_FLAGS_KEY } from "../page/content/adapter-flags.js";
import { MAX_EDITOR_CODE_UNITS } from "../page/content/constants.js";
import { createMockProofreader } from "./helpers/mock-proofreader.js";
import {
  blurField, clickFieldAt, compositionEnd, compositionStart, field, focusField, host,
  inputField, keyUp, loadContentPage, pagePopup,
  setVisibility, setWindowFocused, settle, squiggleBoxes, stubFieldGeometry,
  stubRangeRects, teardownContentPage, tick, typeInField,
} from "./helpers/content-page.js";

afterEach(() => {
  teardownContentPage();
});

const BAD = "I seen it.";
// "seen" → "saw", spans relative to BAD.
const seenFixture = (text) => ({
  correctedInput: text.replace("seen", "saw"),
  corrections: [{ startIndex: 2, endIndex: 6, correction: "saw", types: ["grammar"] }],
});

function mockWith(...results) {
  return createMockProofreader({ availability: "available", results });
}

describe("lint-on-pause", () => {
  it("debounces: no engine call before the pause, one after", async () => {
    const mock = mockWith(seenFixture);
    await loadContentPage({ mock });
    focusField();
    typeInField(BAD);

    await tick(900);
    expect(mock.ledger.instances.length).toBe(0);
    await tick(100);
    expect(mock.ledger.instances.length).toBe(1);
    expect(mock.ledger.instances[0].proofreadCalls).toEqual([BAD]);
  });

  it("each edit restarts the debounce", async () => {
    const mock = mockWith(seenFixture);
    await loadContentPage({ mock });
    focusField();
    typeInField("I seen");
    await tick(600);
    typeInField(BAD);
    await tick(600);
    expect(mock.ledger.instances.length).toBe(0); // neither pause completed
    await tick(400);
    expect(mock.ledger.instances.length).toBe(1);
    expect(mock.ledger.instances[0].proofreadCalls).toEqual([BAD]);
  });

  it("focusing a field that already has text lints it after the pause", async () => {
    const mock = mockWith(seenFixture);
    await loadContentPage({ mock });
    field().value = BAD;
    focusField();
    await tick(1000);
    expect(mock.ledger.instances.length).toBe(1);
  });

  it("an empty field is never sent to the engine", async () => {
    const mock = mockWith();
    await loadContentPage({ mock });
    focusField();
    typeInField("   ");
    await tick(2000);
    expect(mock.ledger.instances.length).toBe(0);
  });
});

describe("the visibility/focus hard gate", () => {
  it("hiding the tab cancels the pending debounce — no engine call — and the catch-up runs on return", async () => {
    const mock = mockWith(seenFixture);
    await loadContentPage({ mock });
    focusField();
    typeInField(BAD);
    setVisibility("hidden");

    await tick(5000);
    expect(mock.ledger.instances.length).toBe(0);
    expect(mock.ledger.availabilityCalls.length).toBe(0); // nothing reached the engine at all

    setVisibility("visible");
    await tick(1000);
    expect(mock.ledger.instances.length).toBe(1);
  });

  it("page-driven input while hidden never schedules a lint", async () => {
    const mock = mockWith();
    await loadContentPage({ mock });
    focusField();
    setVisibility("hidden");
    typeInField(BAD); // a site firing synthetic input in a background tab
    await tick(5000);
    expect(mock.ledger.instances.length).toBe(0);
  });

  it("losing window focus cancels like hiding; refocus catches up", async () => {
    const mock = mockWith(seenFixture);
    await loadContentPage({ mock });
    focusField();
    typeInField(BAD);
    setWindowFocused(false);

    await tick(5000);
    expect(mock.ledger.instances.length).toBe(0);

    setWindowFocused(true);
    await tick(1000);
    expect(mock.ledger.instances.length).toBe(1);
  });
});

describe("supersede on edit", () => {
  it("typing aborts the in-flight proofread and its result is never rendered", async () => {
    const mock = createMockProofreader({ availability: "available" });
    const controlled = mock.enqueueControlled();
    await loadContentPage({ mock });
    stubFieldGeometry();
    stubRangeRects([{ left: 10, top: 10, width: 60, height: 16 }]);

    focusField();
    typeInField(BAD);
    await tick(1000); // request 1 in flight
    expect(mock.ledger.instances.length).toBe(1);

    typeInField(BAD + " More."); // edit → invalidate + abort
    controlled.resolve(seenFixture(BAD));
    await settle();
    expect(squiggleBoxes().length).toBe(0); // stale result dropped

    await tick(1000); // the re-scheduled lint (queue empty → clean result)
    expect(mock.ledger.instances.length).toBe(2);
  });
});

describe("text-preserving churn (Slack-style decoration spans)", () => {
  const CE_HTML = '<div id="field" contenteditable="true" role="textbox" aria-multiline="true">I seen it.</div>';

  // What Slack's composer does constantly: re-wrap part of the text in a
  // decoration span. childList + characterData mutations, flattened text
  // unchanged.
  function wrapFirstWords() {
    const el = field();
    const textNode = el.firstChild;
    const rest = textNode.splitText(6);
    const span = document.createElement("span");
    span.className = "fake-decoration";
    el.insertBefore(span, rest);
    span.appendChild(textNode);
  }

  it("churn while a re-lint is pending does not reset the debounce", async () => {
    const mock = mockWith(seenFixture, seenFixture);
    await loadContentPage({ mock, html: CE_HTML });
    stubFieldGeometry();
    stubRangeRects([{ left: 10, top: 40, width: 60, height: 16 }]);
    focusField();
    await tick(1100);
    expect(mock.ledger.instances.length).toBe(1);

    field().firstChild.data = "I seen it again."; // real edit → re-lint scheduled
    await tick(600);
    wrapFirstWords(); // decoration churn, text unchanged
    await tick(400); // completes the ORIGINAL 1s pause — churn must not have reset it
    expect(mock.ledger.instances.length).toBe(2);
    expect(mock.ledger.instances[1].proofreadCalls).toEqual(["I seen it again."]);
  });

  it("the popup still opens after an apply whose editor normalization remaps nodes", async () => {
    const both = (text) => {
      const seen = text.indexOf("seen");
      const dont = text.indexOf("dont");
      return {
        correctedInput: text.replace("seen", "saw").replace("dont", "don't"),
        corrections: [
          { startIndex: seen, endIndex: seen + 4, correction: "saw", types: ["grammar"] },
          { startIndex: dont, endIndex: dont + 4, correction: "don't", types: ["grammar"] },
        ],
      };
    };
    const mock = createMockProofreader({ availability: "available" });
    mock.enqueue(both);
    mock.enqueueControlled(); // the post-apply immediate lint stays in flight
    await loadContentPage({
      mock,
      html: '<div id="field" contenteditable="true" role="textbox" aria-multiline="true">I seen it. He dont know.</div>',
    });
    stubFieldGeometry();
    stubRangeRects([{ left: 10, top: 40, width: 60, height: 16 }]);
    focusField();
    await tick(1100);
    expect(squiggleBoxes()).toHaveLength(2);

    clickFieldAt(3); // inside "seen"
    expect(pagePopup().hidden).toBe(false);
    pagePopup().querySelector(".citem__choice").click();
    await settle();
    expect(field().textContent).toBe("I saw it. He dont know.");

    // What Slack's Quill does right after our splice: rewrite the paragraph's
    // nodes without changing the text.
    field().normalize();
    await tick(20);

    clickFieldAt(field().textContent.indexOf("dont") + 1);
    expect(pagePopup().hidden).toBe(false);
    expect(pagePopup().textContent).toContain("don't");
  });

  it("churn during the in-flight proofread neither aborts it nor drops the finished result", async () => {
    const mock = createMockProofreader({ availability: "available" });
    const controlled = mock.enqueueControlled();
    await loadContentPage({ mock, html: CE_HTML });
    stubFieldGeometry();
    stubRangeRects([{ left: 10, top: 40, width: 60, height: 16 }]);
    focusField();
    await tick(1000); // lint in flight
    expect(mock.ledger.instances.length).toBe(1);

    wrapFirstWords(); // churn mid-flight: node mapping changes, text doesn't
    await settle();
    controlled.resolve(seenFixture(BAD));
    await tick(20); // let the commit + rAF-coalesced render run

    expect(squiggleBoxes()).toHaveLength(1); // committed via the retaken mapping
    expect(mock.ledger.instances.length).toBe(1); // and no wasteful re-lint
  });
});

describe("Phase 1 lifecycle safety", () => {
  it("waits for the final non-composing input after compositionend and lints exactly once", async () => {
    const mock = mockWith(seenFixture);
    await loadContentPage({ mock });
    focusField();

    compositionStart();
    inputField("I se", { isComposing: true });
    await tick(5000);
    expect(mock.ledger.instances.length).toBe(0);

    compositionEnd();
    await tick(5000);
    expect(mock.ledger.instances.length).toBe(0);

    inputField(BAD);
    await tick(1000);
    expect(mock.ledger.instances.length).toBe(1);
    expect(mock.ledger.instances[0].proofreadCalls).toEqual([BAD]);
  });

  it("uses keyup as the composition commit fallback when no final input arrives", async () => {
    const mock = mockWith(seenFixture);
    await loadContentPage({ mock });
    focusField();

    compositionStart();
    inputField("I se", { isComposing: true });
    compositionEnd();
    field().value = BAD;
    keyUp();
    await tick(1000);

    expect(mock.ledger.instances.length).toBe(1);
    expect(mock.ledger.instances[0].proofreadCalls).toEqual([BAD]);
  });

  it("ignores nested compositionstart and still lints only the committed text", async () => {
    const mock = mockWith(seenFixture);
    await loadContentPage({ mock });
    focusField();

    compositionStart();
    compositionStart();
    inputField("I se", { isComposing: true });
    compositionEnd();
    inputField(BAD);
    await tick(1000);

    expect(mock.ledger.instances.length).toBe(1);
    expect(mock.ledger.instances[0].proofreadCalls).toEqual([BAD]);
  });

  it("blur during composition resets without scheduling stale text", async () => {
    const mock = mockWith(seenFixture);
    await loadContentPage({ mock });
    focusField();
    compositionStart();
    inputField("I se", { isComposing: true });
    blurField();
    keyUp();
    await tick(5000);
    expect(mock.ledger.instances.length).toBe(0);
  });

  it("resolves a focused textarea inside an open shadow root through composedPath", async () => {
    const mock = mockWith(seenFixture);
    await loadContentPage({ mock, html: "<div id=\"host\"></div>" });
    const shadow = document.getElementById("host").attachShadow({ mode: "open" });
    const inner = document.createElement("textarea");
    shadow.appendChild(inner);

    inner.dispatchEvent(new FocusEvent("focusin", { bubbles: true, composed: true }));
    inputField(BAD, { el: inner, composed: true });
    await tick(1000);

    expect(mock.ledger.instances.length).toBe(1);
    expect(mock.ledger.instances[0].proofreadCalls).toEqual([BAD]);
  });

  it("tears down when the active root is detached", async () => {
    const mock = mockWith(seenFixture);
    await loadContentPage({ mock });
    stubFieldGeometry();
    stubRangeRects([{ left: 10, top: 40, width: 60, height: 16 }]);
    focusField();
    typeInField(BAD);
    await tick(1100);
    expect(squiggleBoxes()).toHaveLength(1);

    field().remove();
    await settle();
    expect(squiggleBoxes()).toHaveLength(0);
  });

  it("ignores decoration mutations but re-lints text mutations", async () => {
    const mock = mockWith(seenFixture, seenFixture);
    await loadContentPage({
      mock,
      html: '<div id="field" contenteditable="true" role="textbox" aria-multiline="true">I seen it.</div>',
    });
    stubFieldGeometry();
    stubRangeRects([{ left: 10, top: 40, width: 60, height: 16 }]);
    focusField();
    await tick(1100);
    expect(squiggleBoxes()).toHaveLength(1);

    field().className = "page-decoration";
    await settle();
    expect(squiggleBoxes()).toHaveLength(1);
    expect(mock.ledger.instances.length).toBe(1);

    field().firstChild.data = "I seen it again.";
    await settle();
    expect(squiggleBoxes()).toHaveLength(1); // safely retained until the fresh lint lands
    await tick(1000);
    expect(mock.ledger.instances.length).toBe(2);
    expect(mock.ledger.instances[1].proofreadCalls).toEqual(["I seen it again."]);
  });

  it("proofreads bounded document windows for text just over the shared editor size cap", async () => {
    const seenInWindow = (text) => {
      const start = text.indexOf("seen");
      return {
        correctedInput: text.replace("seen", "saw"),
        corrections: [{ startIndex: start, endIndex: start + 4, correction: "saw", types: ["grammar"] }],
      };
    };
    const mock = mockWith(seenInWindow, seenInWindow);
    await loadContentPage({ mock });
    stubFieldGeometry();
    stubRangeRects([{ left: 10, top: 40, width: 60, height: 16 }]);
    focusField();
    const prefix = "x".repeat(MAX_EDITOR_CODE_UNITS + 10);
    const text = `${prefix} I seen it.`;
    field().value = text;
    field().setSelectionRange(prefix.length + 4, prefix.length + 4);
    field().dispatchEvent(new Event("input", { bubbles: true }));
    await tick(1100);

    expect(mock.ledger.instances.length).toBe(2);
    expect(mock.ledger.instances[0].proofreadCalls[0].length).toBeLessThanOrEqual(MAX_EDITOR_CODE_UNITS);
    expect(mock.ledger.instances[1].proofreadCalls[0].length).toBeLessThanOrEqual(MAX_EDITOR_CODE_UNITS);
    expect(mock.ledger.instances[1].proofreadCalls[0]).toContain("I seen it.");
    expect(squiggleBoxes()).toHaveLength(1);

    clickFieldAt(prefix.length + 4);
    expect(pagePopup().hidden).toBe(false);
    pagePopup().querySelector(".citem__choice").click();
    await settle();

    expect(field().value).toBe(`${prefix} I saw it.`);
  });

  it("falls back to one focused caret window when the document window count is too large", async () => {
    const mock = mockWith((text) => {
      const start = text.indexOf("seen");
      return {
        correctedInput: text.replace("seen", "saw"),
        corrections: [{ startIndex: start, endIndex: start + 4, correction: "saw", types: ["grammar"] }],
      };
    });
    await loadContentPage({ mock });
    stubFieldGeometry();
    stubRangeRects([{ left: 10, top: 40, width: 60, height: 16 }]);
    focusField();
    const prefix = "x".repeat(MAX_EDITOR_CODE_UNITS * 4);
    field().value = `${prefix} I seen it.`;
    field().setSelectionRange(prefix.length + 4, prefix.length + 4);
    field().dispatchEvent(new Event("input", { bubbles: true }));
    await tick(1100);

    expect(mock.ledger.instances).toHaveLength(1);
    expect(mock.ledger.instances[0].proofreadCalls[0].length).toBeLessThanOrEqual(MAX_EDITOR_CODE_UNITS);
    expect(mock.ledger.instances[0].proofreadCalls[0]).toContain("I seen it.");
    expect(squiggleBoxes()).toHaveLength(1);
  });

  it("cancels a stale long-document caret window when typing continues", async () => {
    const mock = createMockProofreader({ availability: "available" });
    const stale = mock.enqueueControlled();
    const seenInWindow = (text) => {
      const start = text.indexOf("seen");
      return {
        correctedInput: text.replace("seen", "saw"),
        corrections: [{ startIndex: start, endIndex: start + 4, correction: "saw", types: ["grammar"] }],
      };
    };
    mock.enqueue(seenInWindow, seenInWindow);
    await loadContentPage({ mock });
    stubFieldGeometry();
    stubRangeRects([{ left: 10, top: 40, width: 60, height: 16 }]);
    focusField();
    const prefix = "x".repeat(MAX_EDITOR_CODE_UNITS + 10);
    field().value = `${prefix} I seen it.`;
    field().setSelectionRange(prefix.length + 4, prefix.length + 4);
    field().dispatchEvent(new Event("input", { bubbles: true }));
    await tick(1000);
    expect(mock.ledger.instances).toHaveLength(1);

    field().value = `${prefix} I seen it again.`;
    field().setSelectionRange(prefix.length + 4, prefix.length + 4);
    field().dispatchEvent(new Event("input", { bubbles: true }));
    stale.resolve({
      correctedInput: "I saw it.",
      corrections: [{ startIndex: 2, endIndex: 6, correction: "saw", types: ["grammar"] }],
    });
    await settle();
    expect(squiggleBoxes()).toHaveLength(0);

    await tick(1100);
    expect(mock.ledger.instances).toHaveLength(3);
    expect(mock.ledger.instances[2].proofreadCalls[0]).toContain("I seen it again.");
    expect(squiggleBoxes()).toHaveLength(1);
  });

  it("refuses to apply a long-document window correction after the whole editor text goes stale", async () => {
    const seenInWindow = (text) => {
      const start = text.indexOf("seen");
      return {
        correctedInput: text.replace("seen", "saw"),
        corrections: [{ startIndex: start, endIndex: start + 4, correction: "saw", types: ["grammar"] }],
      };
    };
    const mock = mockWith(seenInWindow, seenInWindow);
    await loadContentPage({ mock });
    stubFieldGeometry();
    stubRangeRects([{ left: 10, top: 40, width: 60, height: 16 }]);
    focusField();
    const prefix = "x".repeat(MAX_EDITOR_CODE_UNITS + 10);
    const original = `${prefix} I seen it.`;
    const changed = `${prefix} I seen this.`;
    field().value = original;
    field().setSelectionRange(prefix.length + 4, prefix.length + 4);
    field().dispatchEvent(new Event("input", { bubbles: true }));
    await tick(1100);
    expect(squiggleBoxes()).toHaveLength(1);

    clickFieldAt(prefix.length + 4);
    expect(pagePopup().hidden).toBe(false);
    field().value = changed;
    pagePopup().querySelector(".citem__choice").click();
    await settle();

    expect(field().value).toBe(changed);
  });

  it("drops a stale async completion after detachment", async () => {
    const mock = createMockProofreader({ availability: "available" });
    const controlled = mock.enqueueControlled();
    await loadContentPage({ mock });
    stubFieldGeometry();
    stubRangeRects([{ left: 10, top: 40, width: 60, height: 16 }]);
    focusField();
    typeInField(BAD);
    await tick(1000);
    expect(mock.ledger.instances.length).toBe(1);

    field().remove();
    await settle();
    controlled.resolve(seenFixture(BAD));
    await settle();

    expect(squiggleBoxes()).toHaveLength(0);
  });

  it("runtime global adapter disable tears down the active form session", async () => {
    const mock = mockWith(seenFixture);
    await loadContentPage({ mock });
    stubFieldGeometry();
    stubRangeRects([{ left: 10, top: 40, width: 60, height: 16 }]);
    focusField();
    typeInField(BAD);
    await tick(1100);
    expect(squiggleBoxes()).toHaveLength(1);

    await globalThis.chrome.storage.local.set({
      [EDITOR_ADAPTER_FLAGS_KEY]: { enabled: false, adapters: { form: true } },
    });
    await settle();

    expect(squiggleBoxes()).toHaveLength(0);
    typeInField(BAD + " More.");
    await tick(5000);
    expect(mock.ledger.instances.length).toBe(1);

    // The kill switch must survive a refocus — a disable that un-kills itself
    // on the next focusin is just a flicker, not a kill switch.
    blurField();
    focusField();
    typeInField(BAD + " Even more.");
    await tick(5000);
    expect(mock.ledger.instances.length).toBe(1);
  });

  it("runtime active-adapter disable tears down a contenteditable session", async () => {
    const mock = mockWith(seenFixture);
    await loadContentPage({
      mock,
      html: '<div id="field" contenteditable="true" role="textbox" aria-multiline="true">I seen it.</div>',
    });
    stubFieldGeometry();
    stubRangeRects([{ left: 10, top: 40, width: 60, height: 16 }]);
    focusField();
    await tick(1100);
    expect(squiggleBoxes()).toHaveLength(1);

    await globalThis.chrome.storage.local.set({
      [EDITOR_ADAPTER_FLAGS_KEY]: { enabled: true, adapters: { contenteditable: false } },
    });
    await settle();

    expect(squiggleBoxes()).toHaveLength(0);
    field().firstChild.data = "I seen it again.";
    field().dispatchEvent(new Event("input", { bubbles: true }));
    await tick(5000);
    expect(mock.ledger.instances.length).toBe(1);

    blurField();
    focusField();
    field().dispatchEvent(new Event("input", { bubbles: true }));
    await tick(5000);
    expect(mock.ledger.instances.length).toBe(1);
  });
});

describe("adapter flag enforcement at activation", () => {
  it("never activates a form field whose adapter flag is off at load", async () => {
    const mock = mockWith(seenFixture);
    await loadContentPage({
      mock,
      local: { [EDITOR_ADAPTER_FLAGS_KEY]: { enabled: true, adapters: { form: false } } },
    });
    focusField();
    typeInField(BAD);
    await tick(5000);
    expect(mock.ledger.instances.length).toBe(0);
  });

  it("never activates anything while the engine is globally disabled at load", async () => {
    const mock = mockWith(seenFixture);
    await loadContentPage({
      mock,
      html: '<div id="field" contenteditable="true" role="textbox" aria-multiline="true">I seen it.</div>',
      local: { [EDITOR_ADAPTER_FLAGS_KEY]: { enabled: false } },
    });
    focusField();
    field().dispatchEvent(new Event("input", { bubbles: true }));
    await tick(5000);
    expect(mock.ledger.instances.length).toBe(0);
  });

  it("a disabled rich adapter falls through to a still-enabled generic one", async () => {
    // Slack-shaped composer: quill-flavoured classes on a generic CE textbox.
    // With quill dark-launched off it must degrade to the contenteditable
    // adapter, not go dead.
    const mock = mockWith(seenFixture);
    await loadContentPage({
      mock,
      html: '<div id="field" class="ql-editor" data-qa="texty_input" contenteditable="true" role="textbox" aria-multiline="true"><p><br></p></div>',
      local: { [EDITOR_ADAPTER_FLAGS_KEY]: { enabled: true, adapters: { quill: false, contenteditable: true } } },
    });
    focusField();
    typeInField(BAD);
    await tick(1100);
    expect(mock.ledger.instances.length).toBe(1);
  });

  it("a runtime enable picks up the already-focused field without a refocus", async () => {
    const mock = mockWith(seenFixture);
    await loadContentPage({
      mock,
      local: { [EDITOR_ADAPTER_FLAGS_KEY]: { enabled: true, adapters: { form: false } } },
    });
    field().value = BAD;
    focusField();
    await tick(2000);
    expect(mock.ledger.instances.length).toBe(0);

    await globalThis.chrome.storage.local.set({
      [EDITOR_ADAPTER_FLAGS_KEY]: { enabled: true, adapters: { form: true } },
    });
    await tick(1100);
    expect(mock.ledger.instances.length).toBe(1);
  });

  it("debug flag traces why a focused field was not activated", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    try {
      const mock = mockWith(seenFixture);
      await loadContentPage({
        mock,
        local: { [EDITOR_ADAPTER_FLAGS_KEY]: { enabled: true, debug: true, adapters: { form: false } } },
      });
      await settle(); // let the async flag load land before the focus
      focusField();
      await tick(100);
      expect(mock.ledger.instances.length).toBe(0);
      const trace = debug.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(trace).toContain("form");
    } finally {
      debug.mockRestore();
    }
  });
});

describe("declared-language gate", () => {
  it("a field declaring an unsupported language never reaches the engine — not even the availability probe", async () => {
    const mock = mockWith(seenFixture);
    await loadContentPage({ mock, html: '<textarea id="field" lang="fr"></textarea>' });
    focusField();
    typeInField("Je l'ai vu hier.");
    await tick(2000);
    expect(mock.ledger.instances.length).toBe(0);
    expect(mock.ledger.availabilityCalls.length).toBe(0);
  });

  it("a page-level unsupported language gates fields that declare nothing themselves", async () => {
    const mock = mockWith(seenFixture);
    document.documentElement.setAttribute("lang", "fr");
    try {
      await loadContentPage({ mock });
      focusField();
      typeInField(BAD);
      await tick(2000);
      expect(mock.ledger.instances.length).toBe(0);
      expect(mock.ledger.availabilityCalls.length).toBe(0);
    } finally {
      document.documentElement.removeAttribute("lang");
    }
  });

  it("a mid-session lang swap stops linting and drops the squiggles without a refocus", async () => {
    const mock = mockWith(seenFixture, seenFixture);
    await loadContentPage({ mock });
    stubFieldGeometry();
    stubRangeRects([{ left: 10, top: 40, width: 60, height: 16 }]);
    focusField();
    typeInField(BAD);
    await tick(1100);
    expect(squiggleBoxes()).toHaveLength(1);

    field().setAttribute("lang", "fr"); // `lang` is a mapping mutation → re-lint → language gate clears
    await tick(1100);
    expect(squiggleBoxes()).toHaveLength(0);
    expect(mock.ledger.instances.length).toBe(1); // the swap never reached the engine again
  });
});

describe("incremental window rendering", () => {
  it("renders a finished window's squiggles while the next window is still in flight", async () => {
    const seenInWindow = (text) => {
      const start = text.indexOf("seen");
      return {
        correctedInput: text.replace("seen", "saw"),
        corrections: [{ startIndex: start, endIndex: start + 4, correction: "saw", types: ["grammar"] }],
      };
    };
    const mock = createMockProofreader({ availability: "available" });
    mock.enqueue(seenInWindow); // window 1 resolves normally
    const hung = mock.enqueueControlled(); // window 2 stays in flight
    await loadContentPage({ mock });
    stubFieldGeometry();
    stubRangeRects([{ left: 10, top: 40, width: 60, height: 16 }]);
    focusField();
    // Error text at the FRONT so it lands in window 1 of the two-window split.
    field().value = `I seen it. ${"x".repeat(MAX_EDITOR_CODE_UNITS + 10)}`;
    field().setSelectionRange(4, 4);
    field().dispatchEvent(new Event("input", { bubbles: true }));
    await tick(1100);

    // Window 2 is still pending, but window 1's correction is already on screen.
    expect(mock.ledger.instances).toHaveLength(2);
    expect(hung.settled).toBe(false);
    expect(squiggleBoxes()).toHaveLength(1);

    hung.resolve({ correctedInput: "", corrections: [] });
    await tick(100);
    expect(squiggleBoxes()).toHaveLength(1); // final merge keeps the same correction
  });
});

describe("squiggles → popup → Apply", () => {
  async function lintedPage() {
    const mock = mockWith(seenFixture);
    await loadContentPage({ mock });
    stubFieldGeometry();
    stubRangeRects([{ left: 10, top: 40, width: 60, height: 16 }]);
    focusField();
    typeInField(BAD);
    await tick(1100); // debounce + the rAF render tick
    return mock;
  }

  it("renders a squiggle box per measured rect, tagged with its correction", async () => {
    await lintedPage();
    const boxes = squiggleBoxes();
    expect(boxes.length).toBe(1);
    expect(boxes[0].dataset.correction).toBe("0");
    // grammar type → the shared per-type colour, as an SVG background tile
    expect(boxes[0].style.backgroundImage).toContain("data:image/svg+xml");
    expect(boxes[0].style.backgroundImage).toContain(encodeURIComponent("#f472b6"));
  });

  it("rebases untouched corrections onto a fresh snapshot while the next lint is pending", async () => {
    const initial = "I seen it and teh result.";
    const edited = `Today, ${initial}`;
    const mock = mockWith((text) => ({
      correctedInput: text.replace("seen", "saw").replace("teh", "the"),
      corrections: [
        { startIndex: 2, endIndex: 6, correction: "saw", types: ["grammar"] },
        { startIndex: 14, endIndex: 17, correction: "the", types: ["spelling"] },
      ],
    }));
    await loadContentPage({ mock });
    stubFieldGeometry();
    stubRangeRects([{ left: 10, top: 40, width: 60, height: 16 }]);
    focusField();
    typeInField(initial);
    await tick(1100);
    expect(squiggleBoxes()).toHaveLength(2);

    typeInField(edited);
    await tick(20);

    expect(mock.ledger.instances).toHaveLength(1);
    expect(squiggleBoxes()).toHaveLength(2);
    clickFieldAt(10);
    expect(pagePopup().hidden).toBe(false);
    expect(pagePopup().querySelector(".chip--from").textContent).toBe("seen");
    pagePopup().querySelector(".citem__choice").click();
    await settle();

    expect(field().value).toBe("Today, I saw it and teh result.");
    expect(mock.ledger.instances).toHaveLength(2);
    expect(mock.ledger.instances[1].proofreadCalls).toEqual(["Today, I saw it and teh result."]);
  });

  it("keeps the rebased result's snapshot usable while the follow-up lint is in flight", async () => {
    // Regression guard for the old aliasing bug: the session used to share
    // the result's snapshot and dispose it when the follow-up lint captured a
    // fresh one — leaving the on-screen (rebased) result rendering from a
    // disposed snapshot. Ownership now lives with the result, so the popup
    // must still resolve offsets from it while the next lint is in flight.
    const initial = "I seen it and teh result.";
    const mock = createMockProofreader({ availability: "available" });
    mock.enqueue((text) => ({
      correctedInput: text.replace("seen", "saw").replace("teh", "the"),
      corrections: [
        { startIndex: 2, endIndex: 6, correction: "saw", types: ["grammar"] },
        { startIndex: 14, endIndex: 17, correction: "the", types: ["spelling"] },
      ],
    }));
    const inFlight = mock.enqueueControlled();
    await loadContentPage({ mock });
    stubFieldGeometry();
    stubRangeRects([{ left: 10, top: 40, width: 60, height: 16 }]);
    focusField();
    typeInField(initial);
    await tick(1100);
    expect(squiggleBoxes()).toHaveLength(2);

    typeInField(`Today, ${initial}`); // rebase keeps the squiggles
    await tick(1000);                 // debounce fires — lint 2 now in flight
    expect(mock.ledger.instances).toHaveLength(2);

    clickFieldAt(10); // caret inside the rebased "seen"
    expect(pagePopup().hidden).toBe(false);
    expect(pagePopup().querySelector(".chip--from").textContent).toBe("seen");

    inFlight.resolve({
      correctedInput: `Today, ${initial}`.replace("seen", "saw").replace("teh", "the"),
      corrections: [],
    });
    await settle();
  });

  it("rebases untouched corrections in an oversized multi-window result while the next lint is pending", async () => {
    const windowFixture = (text) => {
      const corrections = [];
      const seen = text.indexOf("seen");
      const teh = text.indexOf("teh");
      if (seen >= 0) corrections.push({ startIndex: seen, endIndex: seen + 4, correction: "saw", types: ["grammar"] });
      if (teh >= 0) corrections.push({ startIndex: teh, endIndex: teh + 3, correction: "the", types: ["spelling"] });
      return {
        correctedInput: text.replace("seen", "saw").replace("teh", "the"),
        corrections,
      };
    };
    const mock = mockWith(windowFixture, windowFixture);
    await loadContentPage({ mock });
    stubFieldGeometry();
    stubRangeRects([{ left: 10, top: 40, width: 60, height: 16 }]);
    focusField();
    const prefix = "x".repeat(MAX_EDITOR_CODE_UNITS + 10);
    const initial = `${prefix} I seen it and teh result.`;
    typeInField(initial);
    field().setSelectionRange(prefix.length + 4, prefix.length + 4);
    await tick(1100);
    expect(mock.ledger.instances).toHaveLength(2);
    expect(squiggleBoxes()).toHaveLength(2);

    typeInField(`Today, ${initial}`);
    await tick(20);

    expect(mock.ledger.instances).toHaveLength(2);
    expect(squiggleBoxes()).toHaveLength(2);
    clickFieldAt("Today, ".length + prefix.length + 4);
    expect(pagePopup().hidden).toBe(false);
    expect(pagePopup().querySelector(".chip--from").textContent).toBe("seen");
  });

  it("click on the bad span opens the popup; click elsewhere closes it", async () => {
    await lintedPage();
    clickFieldAt(3); // caret inside "seen"
    const popup = pagePopup();
    expect(popup.hidden).toBe(false);
    expect(popup.querySelector(".chip--from").textContent).toBe("seen");
    expect(popup.querySelector(".chip--to").textContent).toBe("saw");
    expect(popup.querySelector(".badges")).toBeNull();

    clickFieldAt(9); // caret in "it." — no correction there
    expect(pagePopup().hidden).toBe(true);
    expect(squiggleBoxes()).toHaveLength(1); // outside close is not an ignore
  });

  it("shows advice details and Dismiss for now temporarily removes its underline", async () => {
    const text = "The city is famous its beaches.";
    const mock = mockWith({ corrections: [{
      startIndex: 4,
      endIndex: 9,
      correction: null,
      suggestions: [],
      types: ["miscellaneous"],
      explanation: "You may be missing a preposition here.",
    }] });
    await loadContentPage({ mock });
    stubFieldGeometry();
    stubRangeRects([{ left: 10, top: 40, width: 60, height: 16 }]);
    focusField();
    typeInField(text);
    await tick(1100);

    expect(squiggleBoxes()).toHaveLength(1);
    clickFieldAt(6);
    const popup = pagePopup();
    expect(popup.hidden).toBe(false);
    expect(popup.querySelector(".chip--from")).toBeNull();
    expect(popup.querySelector(".citem__choice")).toBeNull();
    expect(popup.querySelector(".badge").textContent).toBe("General");
    expect(popup.querySelector(".explain").textContent)
      .toBe("You may be missing a preposition here.");
    expect([...popup.querySelectorAll(".popup__actions button")]
      .map((button) => button.getAttribute("aria-label"))).toEqual(["Dismiss for now"]);
    expect(host().shadowRoot.querySelectorAll(".tint-box")).toHaveLength(1);

    popup.querySelector(".popup__dismiss").click();
    await tick(20);
    expect(popup.hidden).toBe(true);
    expect(squiggleBoxes()).toHaveLength(0);
    expect(host().shadowRoot.querySelectorAll(".tint-box")).toHaveLength(0);
    expect(mock.ledger.instances).toHaveLength(1);
  });

  it("keeps the dismissed occurrence quiet but flags the same word typed elsewhere", async () => {
    const typoFixture = (text) => {
      const corrections = [];
      let from = 0;
      for (let start = text.indexOf("teh", from); start >= 0; start = text.indexOf("teh", from)) {
        corrections.push({
          startIndex: start,
          endIndex: start + 3,
          correction: "the",
          types: ["spelling"],
        });
        from = start + 3;
      }
      return { correctedInput: text.replaceAll("teh", "the"), corrections };
    };
    const mock = mockWith(typoFixture, typoFixture);
    await loadContentPage({ mock });
    stubFieldGeometry();
    stubRangeRects([{ left: 10, top: 40, width: 60, height: 16 }]);
    focusField();
    typeInField("teh is here");
    await tick(1100);

    clickFieldAt(1);
    pagePopup().querySelector(".popup__dismiss").click();
    await tick(20);
    expect(squiggleBoxes()).toHaveLength(0);
    expect(mock.ledger.instances).toHaveLength(1); // dismiss itself never re-lints

    typeInField("teh is here and teh");
    await tick(1100);

    expect(mock.ledger.instances).toHaveLength(2);
    expect(squiggleBoxes()).toHaveLength(1); // only the newly typed occurrence
    clickFieldAt(17);
    expect(pagePopup().hidden).toBe(false);
    expect(pagePopup().querySelector(".chip--from").textContent).toBe("teh");
  });

  it("clicking the suggested word applies that correction and re-lints immediately", async () => {
    const initial = "I seen it and teh result.";
    const mock = mockWith((text) => ({
      correctedInput: text.replace("seen", "saw").replace("teh", "the"),
      corrections: [
        { startIndex: 2, endIndex: 6, correction: "saw", types: ["grammar"] },
        { startIndex: 14, endIndex: 17, correction: "the", types: ["spelling"] },
      ],
    }));
    await loadContentPage({ mock });
    stubFieldGeometry();
    stubRangeRects([{ left: 10, top: 40, width: 60, height: 16 }]);
    focusField();
    typeInField(initial);
    await tick(1100);
    expect(squiggleBoxes()).toHaveLength(2);

    clickFieldAt(3);
    const labels = [...pagePopup().querySelectorAll(".popup__actions button")]
      .map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual(["Dismiss for now"]);
    pagePopup().querySelector(".citem__choice").click();
    await settle();

    expect(field().value).toBe("I saw it and teh result.");
    expect(mock.ledger.instances).toHaveLength(2);
    expect(mock.ledger.instances[1].proofreadCalls).toEqual(["I saw it and teh result."]);
  });

  it("applies inside a dialog whose outside-pointer handler would otherwise close it", async () => {
    const mock = mockWith(seenFixture);
    await loadContentPage({
      mock,
      html: '<div id="review-dialog" role="dialog"><textarea id="field"></textarea></div>',
    });
    stubFieldGeometry();
    stubRangeRects([{ left: 10, top: 40, width: 60, height: 16 }]);
    const dialog = document.getElementById("review-dialog");
    const dismissOnOutsidePointer = (event) => {
      if (!dialog.contains(event.target)) dialog.remove();
    };
    document.addEventListener("pointerdown", dismissOnOutsidePointer, true);

    try {
      focusField();
      typeInField(BAD);
      await tick(1100);
      clickFieldAt(3);

      const choice = pagePopup().querySelector(".citem__choice");
      choice.dispatchEvent(new MouseEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        composed: true,
      }));
      choice.click();
      await settle();

      expect(dialog.isConnected).toBe(true);
      expect(field().value).toBe("I saw it.");
    } finally {
      document.removeEventListener("pointerdown", dismissOnOutsidePointer, true);
    }
  });

  it("Apply writes the fix back and re-lints immediately", async () => {
    const mock = await lintedPage();
    clickFieldAt(3);
    pagePopup().querySelector(".citem__choice").click();
    await settle();

    expect(field().value).toBe("I saw it.");
    expect(pagePopup().hidden).toBe(true);
    // immediate re-lint (no second 1 s pause): a fresh instance already exists
    expect(mock.ledger.instances.length).toBe(2);
    expect(mock.ledger.instances[1].proofreadCalls).toEqual(["I saw it."]);
  });

  it("applies a non-primary suggestion selected in the in-page popup", async () => {
    const mock = mockWith({
      corrections: [{
        startIndex: 0, endIndex: 5, correction: "weird",
        suggestions: [{ replacement: "weird" }, { replacement: "wired" }],
        types: ["spelling"],
      }],
    });
    await loadContentPage({ mock });
    stubFieldGeometry();
    stubRangeRects([{ left: 10, top: 40, width: 60, height: 16 }]);
    focusField();
    typeInField("wierd choice");
    await tick(1100);

    clickFieldAt(2);
    const popup = pagePopup();
    popup.querySelectorAll(".citem__suggestion")[1].click();
    await settle();

    expect(field().value).toBe("wired choice");
  });

  it("reads, renders, and applies in a Slack-shaped contenteditable composer", async () => {
    const mock = mockWith(seenFixture);
    await loadContentPage({
      mock,
      html: '<div id="field" class="ql-editor ql-blank" data-qa="texty_input" contenteditable="true" role="textbox" aria-multiline="true"><p><br></p></div>',
    });
    stubFieldGeometry();
    stubRangeRects([{ left: 10, top: 40, width: 60, height: 16 }]);
    focusField();
    typeInField(BAD);
    await tick(1100);

    expect(squiggleBoxes()).toHaveLength(1);
    clickFieldAt(3);
    expect(pagePopup().hidden).toBe(false);
    pagePopup().querySelector(".citem__choice").click();
    await settle();

    expect(field().textContent).toBe("I saw it.");
    expect(mock.ledger.instances.length).toBe(2);
    expect(mock.ledger.instances[1].proofreadCalls).toEqual(["I saw it."]);
  });

  it("opens the popup when a rich editor click targets an inner text span", async () => {
    const mock = mockWith(seenFixture);
    await loadContentPage({
      mock,
      html: '<div id="field" contenteditable="true" role="textbox" aria-multiline="true" data-lexical-editor="true"><p><span data-lexical-text="true">I seen it.</span></p></div>',
    });
    stubFieldGeometry();
    stubRangeRects([{ left: 10, top: 40, width: 60, height: 16 }]);
    focusField();
    field().dispatchEvent(new Event("input", { bubbles: true }));
    await tick(1100);

    const text = field().querySelector("[data-lexical-text]").firstChild;
    const range = document.createRange();
    range.setStart(text, 3);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    field().querySelector("[data-lexical-text]")
      .dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 20, clientY: 20 }));

    expect(pagePopup().hidden).toBe(false);
    expect(pagePopup().querySelector(".chip--from").textContent).toBe("seen");
  });

  it("activates a ProseMirror root before generic contenteditable and applies through its DOM contract", async () => {
    const mock = mockWith(seenFixture);
    await loadContentPage({
      mock,
      html: '<div id="field" class="ProseMirror" contenteditable="true"><p><span>I seen it.</span></p></div>',
    });
    stubFieldGeometry();
    stubRangeRects([{ left: 10, top: 40, width: 60, height: 16 }]);
    focusField();
    field().dispatchEvent(new Event("input", { bubbles: true }));
    await tick(1100);

    expect(mock.ledger.instances[0].proofreadCalls).toEqual(["I seen it."]);
    expect(squiggleBoxes()).toHaveLength(1);

    const text = field().querySelector("span").firstChild;
    const range = document.createRange();
    range.setStart(text, 3);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    field().querySelector("span")
      .dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 20, clientY: 20 }));
    pagePopup().querySelector(".citem__choice").click();
    await settle();

    expect(field().textContent).toBe("I saw it.");
    expect(mock.ledger.instances[1].proofreadCalls).toEqual(["I saw it."]);
  });

  it("does not offer Apply all for framework adapters", async () => {
    const mock = mockWith((text) => ({
      correctedInput: text.replace("seen", "saw").replace("teh", "the"),
      corrections: [
        { startIndex: 2, endIndex: 6, correction: "saw", types: ["grammar"] },
        { startIndex: 14, endIndex: 17, correction: "the", types: ["spelling"] },
      ],
    }));
    await loadContentPage({
      mock,
      html: '<div id="field" class="ProseMirror" contenteditable="true"><p><span>I seen it and teh result.</span></p></div>',
    });
    stubFieldGeometry();
    stubRangeRects([{ left: 10, top: 40, width: 60, height: 16 }]);
    focusField();
    field().dispatchEvent(new Event("input", { bubbles: true }));
    await tick(1100);

    const text = field().querySelector("span").firstChild;
    const range = document.createRange();
    range.setStart(text, 3);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    field().querySelector("span")
      .dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 20, clientY: 20 }));

    const labels = [...pagePopup().querySelectorAll(".popup__actions button")]
      .map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual(["Dismiss for now"]);
  });

  it("leaving the field clears the overlay and stops linting", async () => {
    const mock = await lintedPage();
    expect(squiggleBoxes().length).toBe(1);
    blurField();
    expect(squiggleBoxes().length).toBe(0);
    typeInField("more typing while unfocused");
    await tick(5000);
    expect(mock.ledger.instances.length).toBe(1); // only the original lint
  });
});

describe("custom dictionary (in-page)", () => {
  const TYPO = "I love teh web.";
  // "teh" → "the", spelling-typed: the suppressible kind.
  const typoFixture = (text) => ({
    correctedInput: text.replace("teh", "the"),
    corrections: [{ startIndex: 7, endIndex: 10, correction: "the", types: ["spelling"] }],
  });

  async function lintedTypoPage(storage = {}) {
    const mock = mockWith(typoFixture);
    const mod = await loadContentPage({ mock, storage });
    stubFieldGeometry();
    stubRangeRects([{ left: 10, top: 40, width: 60, height: 16 }]);
    focusField();
    typeInField(TYPO);
    await tick(1100); // debounce + the rAF render tick
    return { mock, mod };
  }

  it("a seeded dictionary filters the in-page render", async () => {
    await lintedTypoPage({ customDictionary: ["teh"] });
    expect(squiggleBoxes()).toHaveLength(0);
    clickFieldAt(8); // where the suppressed correction was — no popup either
    expect(pagePopup()?.hidden ?? true).toBe(true);
  });

  it("popup offers Add to dictionary only for suppressible corrections", async () => {
    await lintedTypoPage();
    clickFieldAt(8);
    const labels = [...pagePopup().querySelectorAll(".popup__actions button")]
      .map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual(["Add to dictionary", "Dismiss for now"]);
  });

  it("grammar corrections get no dictionary button", async () => {
    const mock = mockWith(seenFixture); // "seen" — grammar-typed
    await loadContentPage({ mock });
    stubFieldGeometry();
    stubRangeRects([{ left: 10, top: 40, width: 60, height: 16 }]);
    focusField();
    typeInField(BAD);
    await tick(1100);
    clickFieldAt(3);
    const labels = [...pagePopup().querySelectorAll(".popup__actions button")]
      .map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual(["Dismiss for now"]);
  });

  it("adding via the popup drops the squiggles, persists, and never re-lints", async () => {
    const { mock } = await lintedTypoPage();
    expect(squiggleBoxes()).toHaveLength(1);

    clickFieldAt(8);
    pagePopup().querySelector(".popup__dict").click();
    await tick(1100); // re-render tick + would-be debounce window

    expect(pagePopup().hidden).toBe(true);
    expect(squiggleBoxes()).toHaveLength(0);
    expect(field().value).toBe(TYPO); // text untouched — suppressed, not fixed
    const stored = await globalThis.chrome.storage.sync.get("customDictionary");
    expect(stored.customDictionary).toEqual(["teh"]);
    expect(mock.ledger.instances).toHaveLength(1); // a Set lookup, not a model call
  });

  it("an external sync change re-filters the live result without a lint", async () => {
    const { mock } = await lintedTypoPage();
    expect(squiggleBoxes()).toHaveLength(1);

    await globalThis.chrome.storage.sync.set({ customDictionary: ["teh"] });
    await tick(100); // the rAF-equivalent render timer
    expect(squiggleBoxes()).toHaveLength(0);
    expect(mock.ledger.instances).toHaveLength(1);
  });

  it("teardown unsubscribes — a later change neither calls back nor renders", async () => {
    const { mock, mod } = await lintedTypoPage();
    expect(globalThis.chrome.storage.onChanged.listenerCount()).toBe(3);

    mod.teardownPageProofly();
    expect(globalThis.chrome.storage.onChanged.listenerCount()).toBe(0);

    await globalThis.chrome.storage.sync.set({ customDictionary: ["teh"] });
    await tick(200);
    expect(host()).toBe(null); // still inert — nothing re-rendered
    expect(mock.ledger.instances).toHaveLength(1);
  });
});

describe("dialect changes", () => {
  it("clears old-dialect results immediately and re-lints the active field", async () => {
    const mock = mockWith(seenFixture, seenFixture);
    await loadContentPage({ mock });
    stubFieldGeometry();
    stubRangeRects([{ left: 10, top: 40, width: 60, height: 16 }]);
    focusField();
    typeInField(BAD);
    await tick(1100);
    expect(squiggleBoxes()).toHaveLength(1);

    await globalThis.chrome.storage.sync.set({ proofingSettings: { dialect: "british" } });
    expect(squiggleBoxes()).toHaveLength(0);
    await tick(1100);
    expect(mock.ledger.instances).toHaveLength(2);
    expect(squiggleBoxes()).toHaveLength(1);
  });
});

describe("teardown", () => {
  it("removes the shadow host and goes inert", async () => {
    const mock = mockWith(seenFixture);
    const mod = await loadContentPage({ mock });
    focusField();
    typeInField(BAD);
    await tick(1100);
    expect(host()).not.toBe(null);

    mod.teardownPageProofly();
    expect(host()).toBe(null);

    focusField();
    typeInField("I seen it again.");
    await tick(5000);
    expect(mock.ledger.instances.length).toBe(1); // nothing new after teardown
  });
});
