import { afterEach, expect, it, vi } from "vitest";
import { buildCorrectionCard } from "../ui/correction-card.js";
import { createOverlayRenderer, HOST_ID } from "../page/content/highlights.js";
import { initRender } from "../ui/render.js";

const correction = { startIndex: 0, endIndex: 3, correction: "good", rule: "SpellCheck" };
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
afterEach(() => { document.body.replaceChildren(); });

it("names the exact rule, prevents double submission, and reports save failures", async () => {
  let reject;
  const onDisableRule = vi.fn(() => new Promise((_, fail) => { reject = fail; }));
  const card = buildCorrectionCard("bad", correction, { onDisableRule });
  document.body.append(card);
  expect(card.textContent).toContain("Rule: Spell Check");
  const button = card.querySelector(".citem__disable-rule");
  button.click();
  button.click();
  expect(onDisableRule).toHaveBeenCalledExactlyOnceWith("SpellCheck");
  reject(new Error("storage failed"));
  await settle();
  expect(button.disabled).toBe(false);
  expect(card.querySelector('[role="status"]').textContent).toContain("Could not turn off");
  expect(correction.correction).toBe("good");
});

it("omits the action when a correction has no known source rule", () => {
  const card = buildCorrectionCard("bad", { ...correction, rule: undefined }, { onDisableRule: vi.fn() });
  expect(card.querySelector(".citem__disable-rule")).toBeNull();
});

it("wires the action through both popup renderers, including advice", async () => {
  const onDisableRule = vi.fn(async () => {});
  const advice = { startIndex: 0, endIndex: 3, correction: null, suggestions: [], rule: "Hedging" };
  const els = { popup: document.createElement("div"), editor: document.createElement("textarea") };
  document.body.append(els.popup, els.editor);
  const panel = initRender({ els, onDisableRule, syncScroll: () => {} });
  panel.showPopup("bad", advice, 0, 0, 0);
  els.popup.querySelector(".citem__disable-rule").click();
  await settle();
  expect(onDisableRule).toHaveBeenLastCalledWith("Hedging");
  const overlay = createOverlayRenderer();
  overlay.showPopup("bad", correction, 0, 0, 0, { onDisableRule });
  document.getElementById(HOST_ID).shadowRoot.querySelector(".citem__disable-rule").click();
  await settle();
  expect(onDisableRule).toHaveBeenLastCalledWith("SpellCheck");
  overlay.destroy();
});
