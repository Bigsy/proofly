import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockProofreader } from "./helpers/mock-proofreader.js";
import {
  compositionEnd, compositionStart, field, focusField, inputField, loadContentPage,
  setVisibility, setWindowFocused, settle, teardownContentPage, tick, typeInField,
} from "./helpers/content-page.js";

afterEach(teardownContentPage);

const TEXT = "I seen it.";

async function loadDormantField() {
  const mock = createMockProofreader({ results: [() => ({ corrections: [] })] });
  await loadContentPage({ mock, html: '<textarea id="field" readonly></textarea>' });
  await settle();
  focusField(); // Ineligible at focus time; no session is created.
  field().value = TEXT;
  return mock;
}

function expectLint(mock, text = TEXT) {
  expect(mock.ledger.instances).toHaveLength(1);
  expect(mock.ledger.instances[0].proofreadCalls).toEqual([text]);
}

describe("focused editor recovery", () => {
  it("detects on focus immediately and does no extra adapter discovery while typing", async () => {
    await loadContentPage();
    await settle();
    const adapters = await import("../page/content/adapters/index.js");
    const resolver = await import("../page/content/resolve.js");
    const selectAdapter = vi.spyOn(adapters, "adapterForField");
    const resolveActive = vi.spyOn(resolver, "resolveActiveField");
    try {
      focusField();
      // No timer or queued scan is needed to claim the field, and duplicate
      // focus delivery does not repeat adapter selection.
      expect(selectAdapter).toHaveBeenCalledTimes(1);
      for (let i = 0; i < 100; i++) inputField(`${TEXT} ${i}`);
      expect(selectAdapter).toHaveBeenCalledTimes(1);
      expect(resolveActive).not.toHaveBeenCalled();
    } finally {
      selectAdapter.mockRestore();
      resolveActive.mockRestore();
    }
  });

  it.each(["visibility", "window", "pageshow", "resume"])("rediscovers an editor on %s without another focusin", async (event) => {
    const mock = await loadDormantField();
    if (event === "visibility") setVisibility("hidden");
    if (event === "window") setWindowFocused(false);
    field().readOnly = false;
    await tick(5000);
    expect(mock.ledger.instances).toHaveLength(0);

    if (event === "visibility") setVisibility("visible");
    else if (event === "window") setWindowFocused(true);
    else (event === "pageshow" ? window : document).dispatchEvent(new Event(event));
    await tick(1000);
    expectLint(mock);
  });

  it.each(["input", "click"])("recovers on %s when editability changed after focus", async (event) => {
    const mock = await loadDormantField();
    field().readOnly = false;
    field().dispatchEvent(new Event(event, { bubbles: true }));
    await tick(1000);
    expectLint(mock);
  });

  it("receives focus before a site's bubbling handler stops propagation", async () => {
    const mock = await loadDormantField();
    field().blur();
    field().readOnly = false;
    field().addEventListener("focusin", (event) => event.stopPropagation());
    focusField();
    await tick(1000);
    expectLint(mock);
  });

  it("does not let synthetic input on an unfocused editor steal detection", async () => {
    const mock = await loadDormantField();
    const other = document.createElement("textarea");
    document.body.appendChild(other);
    typeInField(TEXT, other);
    await tick(1000);
    expect(mock.ledger.instances).toHaveLength(0);
  });

  it("keeps recovery behind the visibility and window-focus gate", async () => {
    const mock = await loadDormantField();
    field().readOnly = false;
    setVisibility("hidden");
    typeInField(TEXT);
    document.dispatchEvent(new Event("resume"));
    window.dispatchEvent(new Event("pageshow"));
    await tick(5000);
    expect(mock.ledger.instances).toHaveLength(0);

    setWindowFocused(false);
    setVisibility("visible");
    await tick(5000);
    expect(mock.ledger.instances).toHaveLength(0);
    setWindowFocused(true);
    await tick(1000);
    expectLint(mock);
  });

  it("recovers a replacement editor inside a shadow root on return", async () => {
    const mock = await loadDormantField();
    field().readOnly = false;
    typeInField(TEXT);
    setVisibility("hidden");
    field().remove();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    const replacement = document.createElement("textarea");
    replacement.readOnly = true;
    shadow.appendChild(replacement);
    replacement.focus();
    replacement.value = TEXT;
    replacement.readOnly = false;
    await settle();

    setVisibility("visible");
    await tick(1000);
    expectLint(mock);
  });

  it("recovers a Slack-shaped Quill composer made writable after focus", async () => {
    const mock = createMockProofreader({ results: [() => ({ corrections: [] })] });
    await loadContentPage({
      mock,
      html: '<div class="ql-container"><div id="field" class="ql-editor" contenteditable="true" role="textbox" aria-readonly="true"><p>I seen it.</p></div></div>',
    });
    await settle();
    focusField();
    field().removeAttribute("aria-readonly");
    field().querySelector("p").dispatchEvent(new InputEvent("input", { bubbles: true }));
    await tick(1000);
    expectLint(mock);
  });

  it("coalesces return events without postponing the pending lint", async () => {
    const mock = await loadDormantField();
    field().readOnly = false;
    document.dispatchEvent(new Event("resume"));
    await tick(500);
    window.dispatchEvent(new Event("pageshow"));
    setWindowFocused(true);
    setVisibility("visible");
    await tick(500);
    expectLint(mock);
    await tick(2000);
    expectLint(mock);
  });

  it.each(["pagehide", "freeze"])("cancels pending work on %s and catches up on restoration", async (event) => {
    const mock = await loadDormantField();
    field().readOnly = false;
    typeInField(TEXT);
    (event === "pagehide" ? window : document).dispatchEvent(new Event(event));
    await tick(5000);
    expect(mock.ledger.instances).toHaveLength(0);
    window.dispatchEvent(new Event("pageshow"));
    await tick(1000);
    expectLint(mock);
  });

  it("recovery during composition waits for the committed input", async () => {
    const mock = await loadDormantField();
    field().readOnly = false;
    compositionStart();
    inputField("I se", { isComposing: true });
    window.dispatchEvent(new Event("pageshow"));
    await tick(5000);
    expect(mock.ledger.instances).toHaveLength(0);
    compositionEnd();
    inputField(TEXT);
    await tick(1000);
    expectLint(mock);
  });

  it("leaves recovery inert after teardown", async () => {
    const mock = await loadDormantField();
    teardownContentPage();
    field().readOnly = false;
    typeInField(TEXT);
    document.dispatchEvent(new Event("resume"));
    window.dispatchEvent(new Event("pageshow"));
    setWindowFocused(true);
    await tick(5000);
    expect(mock.ledger.instances).toHaveLength(0);
  });
});
