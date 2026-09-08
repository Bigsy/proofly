import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildCorrectionCard } from "../ui/correction-card.js";
import { createOverlayRenderer, HOST_ID } from "../page/content/highlights.js";
import { initRender } from "../ui/render.js";

const correction = { startIndex: 0, endIndex: 3, correction: "good", rule: "RepeatedWords" };
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
beforeEach(() => {
  vi.useFakeTimers();
  // jsdom has no native Popover API; interaction is verified in Chromium.
  HTMLElement.prototype.showPopover = vi.fn();
  HTMLElement.prototype.hidePopover = vi.fn();
});
afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllTimers();
  vi.useRealTimers();
  delete HTMLElement.prototype.showPopover;
  delete HTMLElement.prototype.hidePopover;
});

it("names the exact rule in the menu, prevents double submission, and reports save failures", async () => {
  let reject;
  const onDisableRule = vi.fn(() => new Promise((_, fail) => { reject = fail; }));
  const card = buildCorrectionCard("bad", correction, { onDisableRule });
  document.body.append(card);
  expect(card.querySelector(".citem__rule")).toBeNull();
  expect(card.querySelector(".rule-menu__trigger").getAttribute("aria-label")).toBe("More options");
  const button = card.querySelector(".citem__disable-rule");
  expect(button.textContent).toBe("Turn off “Repeated Words”");
  button.click();
  button.click();
  expect(onDisableRule).toHaveBeenCalledExactlyOnceWith("RepeatedWords");
  reject(new Error("storage failed"));
  await settle();
  expect(button.disabled).toBe(false);
  expect(card.querySelector('[role="status"]').textContent).toContain("Could not turn off");
});

it.each([{ rule: undefined }, { rule: "SpellCheck" }, { rule: "CustomSpelling", types: ["spelling"] }])(
  "omits the menu for spelling or an unknown source: %j", (override) => {
    const card = buildCorrectionCard("bad", { ...correction, ...override }, { onDisableRule: vi.fn() });
    expect(card.querySelector(".rule-menu")).toBeNull();
  },
);

it("wires both popup menus beside dismiss, including advice, and preserves dictionary actions", async () => {
  const onDisableRule = vi.fn(async () => {});
  const advice = { startIndex: 0, endIndex: 3, correction: null, suggestions: [], rule: "Hedging" };
  const els = { popup: document.createElement("div"), editor: document.createElement("textarea") };
  document.body.append(els.popup, els.editor);
  const panel = initRender({ els, onDisableRule, syncScroll: () => {} });
  panel.showPopup("bad", advice, 0, 0, 0);
  els.popup.querySelector(".popup__actions .citem__disable-rule").click();
  await settle();
  expect(onDisableRule).toHaveBeenLastCalledWith("Hedging");
  const overlay = createOverlayRenderer();
  overlay.showPopup("bad", correction, 0, 0, 0, { onDisableRule });
  const shadow = document.getElementById(HOST_ID).shadowRoot;
  shadow.querySelector(".popup__actions .citem__disable-rule").click();
  await settle();
  expect(onDisableRule).toHaveBeenLastCalledWith("RepeatedWords");
  overlay.showPopup("bad", { ...correction, rule: "SpellCheck" }, 0, 0, 0, {
    onDisableRule, onAddToDictionary: vi.fn(),
  });
  expect(shadow.querySelector(".rule-menu")).toBeNull();
  expect(shadow.querySelector(".popup__dict")).not.toBeNull();
  overlay.destroy();
});

it("keeps Undo available after a card is removed, and lets a failed Undo retry", async () => {
  const undo = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ ok: true });
  const card = buildCorrectionCard("bad", correction, { onDisableRule: async () => {
    card.remove();
    return undo;
  } });
  document.body.append(card);
  card.querySelector(".citem__disable-rule").click();
  await settle();
  const toast = document.querySelector(".rule-toast");
  const button = toast.querySelector("button");
  expect(toast.textContent).toContain("turned off");
  button.click();
  await settle();
  expect(button.disabled).toBe(false);
  expect(toast.textContent).toContain("Could not restore");
  button.click();
  await settle();
  expect(undo).toHaveBeenCalledTimes(2);
  expect(toast.textContent).toContain("restored");
  vi.advanceTimersByTime(8000);
  expect(toast.isConnected).toBe(false);
});
