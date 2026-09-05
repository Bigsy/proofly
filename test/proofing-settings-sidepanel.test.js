import { afterEach, describe, expect, it } from "vitest";
import { createMockProofreader } from "./helpers/mock-proofreader.js";
import { $, loadPage, settle } from "./helpers/page.js";

afterEach(() => { document.documentElement.innerHTML = ""; });

describe("side-panel dialect setting", () => {
  it("loads the persisted choice and saves user changes", async () => {
    await loadPage({ storage: { proofingSettings: { dialect: "british" } } });
    expect($("proofingDialect").value).toBe("british");

    $("proofingDialect").value = "australian";
    $("proofingDialect").dispatchEvent(new Event("change", { bubbles: true }));
    await settle();

    expect(await chrome.storage.sync.get("proofingSettings"))
      .toEqual({ proofingSettings: { dialect: "australian" } });

    await chrome.storage.sync.set({ proofingSettings: { dialect: "canadian" } });
    expect($("proofingDialect").value).toBe("canadian");
  });
});

it("closes a stale popup before a rule change refreshes its correction indices", async () => {
  const mock = createMockProofreader({ results: [{ corrections: [
    { startIndex: 0, endIndex: 3, correction: "good", rule: "SpellCheck" },
  ] }] });
  await loadPage({ text: "bad", mock });
  $("editor").setSelectionRange(1, 1);
  $("editor").dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect($("popup").hidden).toBe(false);
  await chrome.storage.sync.set({ proofingSettings: { dialect: "auto", ruleOverrides: { SpellCheck: false } } });
  expect($("popup").hidden).toBe(true);
});
