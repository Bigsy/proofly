// Page harness — loads the real sidepanel.html + sidepanel.js into Vitest's
// shared jsdom window, NOT a per-test JSDOM instance: vi.useFakeTimers()
// patches *this* environment's setTimeout, so the 700 ms debounce only works
// under fake timers if the script runs here too.

import { vi } from "vitest";
// Vite ?raw import — the page exactly as shipped, as a string.
import pageSource from "../../sidepanel.html?raw";
// Seed notes through the real store so the seeded index matches production
// derivation + key layout exactly (no hand-built fixtures to drift).
import { saveNote } from "../../lib/notes-store.js";
// The chrome.storage stub (sync + local + a working onChanged emitter) is
// shared with the content-script harness — see helpers/chrome-storage.js.
import { installChromeStorageStub } from "./chrome-storage.js";

// Inner markup of <html>, with the <script> tag stripped — the script is
// imported by hand after the Harper runtime boundary is stubbed.
const innerHtml = pageSource
  .replace(/<script type="module" src="sidepanel\.js"><\/script>/, "")
  .match(/<html[^>]*>([\s\S]*)<\/html>/)[1];

// The #statusText placeholder, read from the HTML rather than hand-copied —
// the staleness tripwire in loadPage() compares against it, so a tweak to the
// placeholder text must not silently stop the tripwire firing.
const STATUS_PLACEHOLDER = pageSource.match(/<span id="statusText">([^<]*)<\/span>/)[1];

// sidepanel.js is a pure side-effect ES module: importing it evaluates the
// top-level state and wires listeners onto the *current* DOM. Each loadPage()
// must re-evaluate it fresh — vi.resetModules() clears Vitest's module
// registry so the next import re-runs the module body. If the registry ever
// serves a stale evaluation anyway, flip BUST_CACHE to import a unique URL
// per load instead (the staleness tripwire in loadPage() is what catches it).
const BUST_CACHE = false;
let loadSeq = 0;

async function importSidepanel() {
  vi.resetModules();
  if (BUST_CACHE) return import(/* @vite-ignore */ `../../sidepanel.js?t=${++loadSeq}`);
  return import("../../sidepanel.js");
}

// jsdom gap: no document.execCommand / queryCommandEnabled. Stub the subset
// sidepanel.js uses — insertText/undo/redo against the editor — recording
// every call and firing the same `input` event the real commands emit.
// insertText honours the current selection (the app must select() the full
// range first — a missing select shows up as garbled text in assertions).
// History is one-deep: enough for a single undo/redo round-trip.
let execCommandLog = [];

export function execCommands() {
  return execCommandLog.slice();
}

function installExecCommandStub() {
  const editor = document.getElementById("editor");
  execCommandLog = [];
  let undoValue = null; // value before the last insertText (or redo)
  let redoValue = null; // value undone by the last undo
  const fire = () => editor.dispatchEvent(new Event("input", { bubbles: true }));

  document.execCommand = vi.fn((cmd, _ui, value) => {
    execCommandLog.push(value === undefined ? [cmd] : [cmd, value]);
    if (cmd === "insertText") {
      undoValue = editor.value;
      redoValue = null;
      const s = editor.selectionStart;
      const e = editor.selectionEnd;
      editor.value = editor.value.slice(0, s) + value + editor.value.slice(e);
      editor.selectionStart = editor.selectionEnd = s + value.length;
      fire();
      return true;
    }
    if (cmd === "undo") {
      if (undoValue === null) return false;
      redoValue = editor.value;
      editor.value = undoValue;
      undoValue = null;
      fire();
      return true;
    }
    if (cmd === "redo") {
      if (redoValue === null) return false;
      undoValue = editor.value;
      editor.value = redoValue;
      redoValue = null;
      fire();
      return true;
    }
    return false;
  });

  document.queryCommandEnabled = vi.fn((cmd) => {
    if (cmd === "undo") return undoValue !== null;
    if (cmd === "redo") return redoValue !== null;
    return false;
  });
}

// jsdom gaps for the .txt export: no URL.createObjectURL/revokeObjectURL, and
// <a>.click() with an href would try to navigate (logs a not-implemented
// warning). Stub all three and record the last download so tests can assert the
// filename and read the Blob's contents.
let lastDownload = null;
export function lastDownloadedFile() { return lastDownload; }

function installDownloadStub() {
  lastDownload = null;
  let lastBlob = null;
  URL.createObjectURL = vi.fn((blob) => { lastBlob = blob; return "blob:proofly-mock"; });
  URL.revokeObjectURL = vi.fn();
  HTMLAnchorElement.prototype.click = vi.fn(function click() {
    if (!this.download) return;
    // jsdom's Blob is opaque (no .text()/.arrayBuffer()); read it via FileReader
    // instead. Start the read NOW (eagerly) — its load fires on a faked timer,
    // so the test does tick() after the click to flush it, then awaits text().
    const textPromise = new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error);
      fr.readAsText(lastBlob);
    });
    lastDownload = { filename: this.download, blob: lastBlob, text: () => textPromise };
  });
}

// Reset the document from the real sidepanel.html and evaluate sidepanel.js.
//
//   loadPage({ text, mock, rewriter, storage, notes })
//     text — initial editor text, default "". With no seeded notes, init opens
//            a new doc containing this text in the editor view (and, when the
//            model is available, auto-proofreads it on load — so most existing
//            tests pass `text` to get a live, wired editor). Tests opt in
//            explicitly so load-time create/proofread calls don't pollute every
//            ledger.
//     mock — a createMockProofreader() handle, installed as the global before
//            the script evaluates; omit it to simulate an unsupported build
//     rewriter — a createMockRewriter() handle, same deal; omit it to
//            simulate a build without the flag-gated Rewriter API
//     storage — initial chrome.storage.sync contents (e.g. { customPrompts:
//            [...] } or { customDictionary: [...] }); the stub is always
//            installed (an extension page always has chrome.storage), so
//            default {} = empty storage
//     notes — note records to seed into chrome.storage.local before init,
//            each { id, body, createdAt?, updatedAt? }. Seeded through the real
//            saveNote() so the index matches production. A non-empty seed makes
//            init open the LIBRARY view (vs the editor for the no-notes case).
//
// A fixed "now" for every page load, so the library's relative-time meta and
// Today/Yesterday grouping are deterministic. Tests seed note timestamps
// relative to this (e.g. NOW - 2 * 3600_000 for "edited 2 hours ago" → Today).
export const NOW = new Date("2026-06-08T12:00:00").getTime();

// Installs fake timers and resolves once init() has settled.
export async function loadPage({ text = "", mock = null, rewriter = null, storage = {}, notes = [] } = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  document.documentElement.innerHTML = innerHtml;

  // jsdom gap: flashItem() calls scrollIntoView on every showPopup().
  Element.prototype.scrollIntoView = vi.fn();

  installExecCommandStub();
  const chrome = installChromeStorageStub(storage);
  // Existing fixture tests script results through MockProofreader. Adapt that
  // mock at the new runtime-message boundary so the assertions keep testing
  // side-panel behaviour rather than Harper engine output.
  chrome.runtime = {
    openOptionsPage: vi.fn(),
    sendMessage: vi.fn(async (message) => {
      if (message?.type !== "harper:lint") {
        return { type: "harper:error", error: { code: "unknown_request", message: "Unknown request" } };
      }
      if (!mock) {
        return { type: "harper:result", requestId: message.requestId, corrections: [] };
      }
      let instance;
      try {
        instance = await mock.Proofreader.create({});
        const result = await instance.proofread(message.text);
        return {
          type: "harper:result",
          requestId: message.requestId,
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
  installDownloadStub();

  // Seed notes via the real store (chrome stub is now installed). Each note's
  // own updatedAt drives the sort, so library order is deterministic in tests.
  for (const n of notes) {
    await saveNote({ id: n.id, body: n.body ?? "", createdAt: n.createdAt }, n.updatedAt ?? n.createdAt ?? 0);
  }

  if (mock) globalThis.Proofreader = mock.Proofreader;
  else delete globalThis.Proofreader;

  if (rewriter) globalThis.Rewriter = rewriter.Rewriter;
  else delete globalThis.Rewriter;

  document.getElementById("editor").value = text;

  await importSidepanel();
  await settle(); // init() is an async IIFE — quiesce before handing control back

  // Staleness tripwire: a stale (cached) module evaluation re-wires NOTHING
  // onto the freshly reset DOM, and every downstream assertion then fails in
  // confusing ways. init() always rewrites the status line by this point
  // (unsupported build, availability error, and all four availability states
  // alike), so the HTML placeholder still showing = the module didn't re-run.
  if (document.getElementById("statusText").textContent === STATUS_PLACEHOLDER) {
    throw new Error(
      "loadPage(): sidepanel.js did not re-evaluate (stale module cache?) — " +
        "#statusText still shows the HTML placeholder. Try BUST_CACHE in helpers/page.js.",
    );
  }
}

// Flush enough microtasks for the await-chains (availability → create →
// proofread → render) to run to completion. Promises aren't faked by
// vi.useFakeTimers(), so plain microtask hops do it.
export async function settle(hops = 50) {
  for (let i = 0; i < hops; i++) await Promise.resolve();
}

// Advance fake timers (firing the debounce) and let the async proofread
// chain behind the timer callback settle.
export async function tick(ms) {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

// ---------- small DOM conveniences ----------

export const $ = (id) => document.getElementById(id);

export function typeInEditor(text) {
  const editor = $("editor");
  editor.value = text;
  editor.dispatchEvent(new Event("input", { bubbles: true }));
}

export function clickEditorAt(pos) {
  const editor = $("editor");
  editor.selectionStart = pos;
  editor.selectionEnd = pos;
  editor.dispatchEvent(new MouseEvent("click", { clientX: 20, clientY: 20 }));
}

export function squiggles() {
  return [...$("highlights").querySelectorAll("span")];
}

export function correctionCards() {
  return [...$("correctionsList").querySelectorAll("li.citem")];
}

// ---------- library conveniences ----------

export function inLibrary() {
  return !$("library").hidden && $("editor-view").hidden;
}

export function inEditor() {
  return !$("editor-view").hidden && $("library").hidden;
}

export function docCards() {
  return [...$("docList").querySelectorAll(".doc-card")];
}

export function docTitles() {
  return docCards().map((c) => c.querySelector(".doc-card__title").textContent);
}

export function groupHeadings() {
  return [...$("docList").querySelectorAll(".group-heading")].map((h) => h.textContent);
}

// Open a card's "…" menu and return its buttons by label.
export function openCardMenu(card) {
  card.querySelector(".doc-card__menu-btn").click();
  return [...card.querySelectorAll(".doc-menu button")];
}
