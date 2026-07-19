// Content-script harness — evaluates page/content/index.js (a side-effect ES
// module, like sidepanel.js) against a minimal "web page" DOM in Vitest's
// shared jsdom window, with the visibility/focus gate and geometry stubbed.
//
// The suite's rule: assert structure, never geometry. jsdom
// has no layout, so Range/element rects are STUBS tests set explicitly — a
// renderer test asserts "this stubbed rect became a squiggle box", not pixels.

import { vi } from "vitest";
import { installChromeStorageStub } from "./chrome-storage.js";

let mod = null;
let visibility = "visible";
let windowFocused = true;

// The visibility/focus hard gate's two inputs, controllable per test.
export function setVisibility(state) {
  visibility = state;
  document.dispatchEvent(new Event("visibilitychange"));
}

export function setWindowFocused(focused) {
  windowFocused = focused;
  window.dispatchEvent(new Event(focused ? "focus" : "blur"));
}

// Reset the DOM to a bare page with one field and evaluate the content
// module fresh (vi.resetModules, same pattern as helpers/page.js). Existing
// fixture results are adapted from MockProofreader onto the Harper runtime
// boundary; production never reads the mock global.
//
// `storage` seeds chrome.storage.sync (e.g. { customDictionary: [...] });
// `local` seeds chrome.storage.local (e.g. { editorAdapterFlags: {...} }).
// The stub is always installed — a content script always has chrome.storage —
// but NOT chrome.runtime, so index.js's onMessage wiring stays dormant
// (teardown in tests goes through teardownPageProofly directly).
export async function loadContentPage({
  mock = null,
  html = '<textarea id="field"></textarea>',
  storage = {},
  local = {},
} = {}) {
  vi.useFakeTimers();
  const chrome = installChromeStorageStub(storage, local);
  chrome.runtime = {
    onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    sendMessage: vi.fn(async (message) => {
      if (message?.type !== "harper:lint") {
        return { type: "harper:error", error: { code: "unknown_request", message: "Unknown request" } };
      }
      if (!mock) return { type: "harper:result", requestId: message.requestId, corrections: [] };
      let instance;
      try {
        instance = await mock.Proofreader.create({});
        const result = await instance.proofread(message.text);
        return {
          type: "harper:result", requestId: message.requestId,
          corrections: Array.isArray(result?.corrections) ? result.corrections : [],
        };
      } catch (error) {
        return {
          type: "harper:error", requestId: message.requestId,
          error: { code: "lint_failed", message: String(error?.message || error) },
        };
      } finally {
        instance?.destroy?.();
      }
    }),
  };
  visibility = "visible";
  windowFocused = true;
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  document.hasFocus = () => windowFocused;

  document.documentElement.innerHTML = `<head></head><body>${html}</body>`;

  vi.resetModules();
  mod = await import("../../page/content/index.js");
  return mod;
}

// Each test file's afterEach must call this BEFORE the global mock teardown
// (file-level afterEach hooks run first), so stale listeners from this load
// can't react to the next test's DOM.
export function teardownContentPage() {
  mod?.teardownPageProofly();
  mod = null;
}

export const field = () => document.getElementById("field");

// jsdom's focus() support for focusin/focusout varies; dispatch explicitly.
// Double delivery is harmless — activation is idempotent on the same field.
export function focusField(el = field()) {
  el.focus();
  el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
}

export function blurField(el = field()) {
  el.blur();
  el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
}

export function typeInField(text, el = field()) {
  if (el.isContentEditable || el.getAttribute("contenteditable") === "true") el.textContent = text;
  else el.value = text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

export function inputField(text, {
  el = field(),
  isComposing = false,
  composed = false,
} = {}) {
  if (el.isContentEditable || el.getAttribute("contenteditable") === "true") el.textContent = text;
  else el.value = text;
  const event = new InputEvent("input", { bubbles: true, composed, isComposing });
  el.dispatchEvent(event);
}

export function compositionStart(el = field(), { composed = false } = {}) {
  el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, composed }));
}

export function compositionEnd(el = field(), { composed = false } = {}) {
  el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, composed }));
}

export function keyUp(el = field(), { composed = false } = {}) {
  el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, composed, key: "Process" }));
}

export function clickFieldAt(pos, el = field()) {
  if (el.isContentEditable || el.getAttribute("contenteditable") === "true") {
    const node = el.firstChild ?? el.appendChild(document.createTextNode(""));
    const caret = Math.min(pos, node.nodeValue.length);
    const range = document.createRange();
    range.setStart(node, caret);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  } else {
    el.selectionStart = pos;
    el.selectionEnd = pos;
  }
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 20, clientY: 20 }));
}

// ---------- geometry stubs (inputs to the renderer, not assertions) ----------

// Give the field a non-degenerate on-screen presence so the renderer's
// visible-area clipping doesn't drop every box.
export function stubFieldGeometry(el = field(), {
  left = 0, top = 0, width = 400, height = 200,
} = {}) {
  el.getBoundingClientRect = () => ({
    left, top, width, height, right: left + width, bottom: top + height, x: left, y: top,
  });
  Object.defineProperty(el, "clientWidth", { configurable: true, get: () => width });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => height });
}

// What the mirror Range "measures" for every span. jsdom has no layout, so
// rects come from here.
export function stubRangeRects(rects) {
  const full = rects.map((r) => ({
    ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top,
  }));
  Range.prototype.getClientRects = () => full;
  Range.prototype.getBoundingClientRect = () =>
    full[0] ?? { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0 };
}

// ---------- shadow-root conveniences ----------

export const host = () => document.getElementById("proofly-highlight-host");
export const shadow = () => host()?.shadowRoot ?? null;
export const squiggleBoxes = () => [...(shadow()?.querySelectorAll(".squiggle-box") ?? [])];
export const tintBoxes = () => [...(shadow()?.querySelectorAll(".tint-box") ?? [])];
export const pagePopup = () => shadow()?.querySelector(".popup") ?? null;

// Flush microtasks (promises aren't faked by vi.useFakeTimers).
export async function settle(hops = 50) {
  for (let i = 0; i < hops; i++) await Promise.resolve();
}

// Advance fake timers and let the async lint chain settle.
export async function tick(ms) {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}
