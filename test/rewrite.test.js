// P2 — Rewrite (tone) dropdown: gating on the flag-gated
// Rewriter API, preset → create-options mapping, replace-via-undo-preserving-
// write + toast + undo round-trip, the shared abort/requestSeq pattern, and
// the busy state while a rewrite is in flight.

import { describe, expect, it } from "vitest";
import { createMockProofreader } from "./helpers/mock-proofreader.js";
import { createMockRewriter } from "./helpers/mock-rewriter.js";
import {
  $,
  execCommands,
  loadPage,
  settle,
  tick,
  typeInEditor,
} from "./helpers/page.js";

const TEXT = "We need to talk about the thing.";

const presetBtns = () => [...$("rewriteDrop").querySelectorAll("[data-rewrite]")];
const presetBtn = (key) => $("rewriteDrop").querySelector(`[data-rewrite="${key}"]`);

describe("gating (hidden unless present AND available/downloadable)", () => {
  it("stays hidden when the Rewriter API is absent", async () => {
    await loadPage({ text: TEXT, mock: createMockProofreader() });
    expect($("rewriteDrop").hidden).toBe(true);
  });

  it("stays hidden when availability() is unavailable", async () => {
    const rewriter = createMockRewriter({ availability: "unavailable" });
    await loadPage({ text: TEXT, mock: createMockProofreader(), rewriter });
    expect($("rewriteDrop").hidden).toBe(true);
  });

  it("stays hidden when availability() rejects", async () => {
    const rewriter = createMockRewriter({
      availability: () => { throw new Error("nope"); },
    });
    await loadPage({ text: TEXT, mock: createMockProofreader(), rewriter });
    expect($("rewriteDrop").hidden).toBe(true);
  });

  it("shows when available — availability() gets the output language", async () => {
    const rewriter = createMockRewriter();
    await loadPage({ text: TEXT, mock: createMockProofreader(), rewriter });
    expect($("rewriteDrop").hidden).toBe(false);
    // Quiets Chrome's "no output language" warning (from the inputLangs field).
    expect(rewriter.ledger.availabilityCalls).toEqual([{ outputLanguage: "en" }]);
  });

  it("shows when downloadable so the first rewrite can provision the model", async () => {
    const rewriter = createMockRewriter({ availability: "downloadable" });
    await loadPage({ text: TEXT, mock: createMockProofreader(), rewriter });
    expect($("rewriteDrop").hidden).toBe(false);
  });

  it("retries availability() bare when a build rejects the options", async () => {
    const rewriter = createMockRewriter({
      availability: (opts) => {
        if (opts && Object.keys(opts).length) throw new Error("bad option");
        return "available";
      },
    });
    await loadPage({ text: TEXT, mock: createMockProofreader(), rewriter });
    expect($("rewriteDrop").hidden).toBe(false);
    expect(rewriter.ledger.availabilityCalls).toHaveLength(2);
  });

  // Found by live MCP testing: the rewriter adapter was mid-download at page
  // load, and the dropdown stayed hidden for the whole session — nothing
  // re-ran the gate (the Download button never shows when the Proofreader's
  // model is already installed).
  it("re-checks a 'downloading' Rewriter and shows the dropdown when it lands", async () => {
    const rewriter = createMockRewriter({
      availability: ["downloading", "downloading", "available"],
    });
    await loadPage({ text: TEXT, mock: createMockProofreader(), rewriter });
    expect($("rewriteDrop").hidden).toBe(true); // mid-download at load

    await tick(5000); // re-check #1: still downloading
    expect($("rewriteDrop").hidden).toBe(true);

    await tick(5000); // re-check #2: download finished
    expect($("rewriteDrop").hidden).toBe(false);
    expect(rewriter.ledger.availabilityCalls).toHaveLength(3);
  });

  it("stops re-checking once availability reaches a terminal state", async () => {
    const rewriter = createMockRewriter({
      availability: ["downloading", "unavailable"],
    });
    await loadPage({ text: TEXT, mock: createMockProofreader(), rewriter });

    await tick(5000); // re-check → unavailable: terminal, no more polling
    await tick(60_000);
    expect(rewriter.ledger.availabilityCalls).toHaveLength(2);
    expect($("rewriteDrop").hidden).toBe(true);
  });

});

describe("preset → Rewriter.create options", () => {
  it.each([
    ["more-formal", "tone", "more-formal"],
    ["more-casual", "tone", "more-casual"],
    ["shorter", "length", "shorter"],
    ["longer", "length", "longer"],
  ])("%s → { %s: '%s' }", async (key, prop, value) => {
    const rewriter = createMockRewriter();
    await loadPage({ text: TEXT, mock: createMockProofreader(), rewriter });

    presetBtn(key).click();
    await settle();

    const [inst] = rewriter.ledger.instances;
    expect(inst.options[prop]).toBe(value);
    // Exactly the one knob + signal + output language — no stray options.
    expect(Object.keys(inst.options).sort())
      .toEqual([prop, "outputLanguage", "signal"].sort());
    expect(inst.options.outputLanguage).toBe("en"); // from the inputLangs field
    expect(inst.options.signal).toBeInstanceOf(AbortSignal);
    expect(inst.rewriteCalls).toEqual([TEXT]);
  });

  it("passes a download monitor when availability is downloadable", async () => {
    const rewriter = createMockRewriter({ availability: "downloadable" });
    await loadPage({ text: TEXT, mock: createMockProofreader(), rewriter });

    presetBtn("shorter").click();
    await settle();

    const [inst] = rewriter.ledger.instances;
    expect(inst.options.length).toBe("shorter");
    expect(inst.options.monitor).toBeTypeOf("function");
  });
});

describe("rewrite replaces the editor text", () => {
  it("replaces via the undo-preserving write, shows the toast, undo restores", async () => {
    const rewriter = createMockRewriter({ results: ["Formal text."] });
    await loadPage({ text: TEXT, mock: createMockProofreader(), rewriter });

    presetBtn("more-formal").click();
    await settle();

    expect($("editor").value).toBe("Formal text.");
    expect(execCommands()).toContainEqual(["insertText", "Formal text."]);
    expect($("toast").hidden).toBe(false);
    expect($("toastText").textContent).toBe("Rewrote text");

    $("toastUndo").click();
    expect(execCommands()).toContainEqual(["undo"]);
    expect($("editor").value).toBe(TEXT);
    expect($("toast").hidden).toBe(true);
    await tick(700); // let the undo's debounced re-proofread land
  });

  it("triggers exactly ONE proofread of the rewritten text — debounce cancelled", async () => {
    const mock = createMockProofreader();
    const rewriter = createMockRewriter({ results: ["New text."] });
    await loadPage({ text: TEXT, mock, rewriter });
    expect(mock.ledger.instances).toHaveLength(1); // load

    presetBtn("longer").click();
    await settle();
    expect(mock.ledger.instances).toHaveLength(2); // immediate re-proofread
    expect(mock.ledger.instances[1].proofreadCalls).toEqual(["New text."]);

    await tick(700); // the input event's debounce must NOT fire a duplicate
    expect(mock.ledger.instances).toHaveLength(2);
  });

  it("collapses the dropdown on selection so the result is visible", async () => {
    const rewriter = createMockRewriter();
    await loadPage({ text: TEXT, mock: createMockProofreader(), rewriter });
    $("rewriteDrop").open = true;

    presetBtn("shorter").click();
    await settle();
    expect($("rewriteDrop").open).toBe(false);
  });

  it("does nothing on whitespace-only text", async () => {
    const rewriter = createMockRewriter();
    await loadPage({ text: "   ", mock: createMockProofreader(), rewriter });

    presetBtn("shorter").click();
    await settle();
    expect(rewriter.ledger.instances).toHaveLength(0);
  });

  it("surfaces rewrite failures in the status line, editor untouched", async () => {
    const rewriter = createMockRewriter();
    await loadPage({ text: TEXT, mock: createMockProofreader(), rewriter });

    const token = rewriter.enqueueControlled();
    presetBtn("shorter").click();
    await settle();
    token.reject(new Error("boom"));
    await settle();

    expect($("statusText").textContent).toBe("Rewrite failed: boom");
    expect($("editor").value).toBe(TEXT);
    expect($("toast").hidden).toBe(true);
  });
});

describe("abort (shared requestSeq/currentAbort pattern)", () => {
  it("an editor edit aborts an in-flight rewrite — no toast, no stale replace", async () => {
    const mock = createMockProofreader();
    const rewriter = createMockRewriter();
    await loadPage({ text: TEXT, mock, rewriter });

    rewriter.enqueueControlled();
    presetBtn("more-casual").click();
    await settle();
    const [inst] = rewriter.ledger.instances;
    expect(inst.options.signal.aborted).toBe(false);

    // Synchronously on input — the same path that aborts stale proofreads.
    typeInEditor("My own edit.");
    expect(inst.options.signal.aborted).toBe(true);

    // The aborted rewrite is still the newest one, so its wind-down clears
    // the busy state — the buttons must come back (an edit bumps requestSeq,
    // so guarding the clear on it would strand them disabled).
    await settle();
    expect(presetBtns().every((b) => !b.disabled)).toBe(true);

    await tick(700); // the edit's debounced proofread proceeds normally
    expect($("editor").value).toBe("My own edit.");
    expect($("toast").hidden).toBe(true);
  });

  // Found by live MCP testing: typing arms the 700 ms proofread debounce, and
  // clicking a preset inside that window let the debounce fire mid-rewrite —
  // the proofread superseded the rewrite through the shared slot, killing it
  // silently (no error, no toast, text unchanged).
  it("cancels a just-armed proofread debounce instead of being superseded by it", async () => {
    const mock = createMockProofreader();
    const rewriter = createMockRewriter();
    await loadPage({ text: TEXT, mock, rewriter }); // load auto-proofread = #1

    typeInEditor(TEXT + " edited"); // arms the proofread debounce
    const slow = rewriter.enqueueControlled();
    presetBtn("shorter").click(); // rewrite begins inside the debounce window
    await settle();

    await tick(700); // the armed debounce would fire here — it must not
    slow.resolve("[shorter] text");
    await settle();

    expect($("editor").value).toBe("[shorter] text");
    expect($("toastText").textContent).toBe("Rewrote text");
    // replaceEditorText's immediate re-proofread is the only one after the
    // edit (instances: load-time + post-rewrite) — the debounced one died.
    expect(mock.ledger.instances).toHaveLength(2);
  });

  it("a new rewrite aborts the in-flight one; only the new result lands", async () => {
    const rewriter = createMockRewriter();
    await loadPage({ text: TEXT, mock: createMockProofreader(), rewriter });

    const first = rewriter.enqueueControlled();
    presetBtn("shorter").click();
    await settle();
    const [a] = rewriter.ledger.instances;
    expect(a.options.signal.aborted).toBe(false);

    // The UI disables the buttons while running; force one back on to
    // exercise the abort guard that protects any other entry path.
    const second = rewriter.enqueueControlled();
    presetBtn("more-formal").disabled = false;
    presetBtn("more-formal").click();
    await settle();
    expect(a.options.signal.aborted).toBe(true);

    // The superseded rewrite's wind-down has run by now — it must NOT have
    // re-enabled the buttons under the newer, still-in-flight rewrite.
    expect(presetBtns().every((b) => b.disabled)).toBe(true);

    first.resolve("Short text."); // stale result must not land
    await settle();
    expect($("editor").value).toBe(TEXT);

    second.resolve("Formal text.");
    await settle();
    expect($("editor").value).toBe("Formal text.");
    expect(presetBtns().every((b) => !b.disabled)).toBe(true);
  });

  it("a proofread superseding an in-flight rewrite still re-enables the buttons", async () => {
    const mock = createMockProofreader();
    const rewriter = createMockRewriter();
    await loadPage({ text: TEXT, mock, rewriter });

    rewriter.enqueueControlled();
    presetBtn("shorter").click();
    await settle();
    expect(presetBtns().every((b) => b.disabled)).toBe(true);

    // An editor change invalidates the rewrite and schedules Harper. The
    // rewrite is still the newest one, so its wind-down must clear the busy
    // state (guarding the clear on currentAbort identity would strand the
    // buttons disabled here).
    typeInEditor(`${TEXT} edited`);
    await settle();
    expect(presetBtns().every((b) => !b.disabled)).toBe(true);
  });

  it("starting a rewrite invalidates an in-flight Harper result", async () => {
    const mock = createMockProofreader();
    const rewriter = createMockRewriter();
    await loadPage({ text: TEXT, mock, rewriter });

    // Start a Harper request and leave it in flight when Rewrite begins.
    mock.enqueueControlled();
    typeInEditor(`${TEXT} edited`);
    await tick(700);

    presetBtn("shorter").click();
    await settle();
  });
});

describe("busy state", () => {
  it("disables the presets while a rewrite is in flight, re-enables after", async () => {
    const rewriter = createMockRewriter();
    await loadPage({ text: TEXT, mock: createMockProofreader(), rewriter });
    expect(presetBtns().every((b) => !b.disabled)).toBe(true);

    const token = rewriter.enqueueControlled();
    presetBtn("shorter").click();
    await settle();
    expect(presetBtns().every((b) => b.disabled)).toBe(true);

    // A click event on a disabled preset (dispatched directly — .click() on
    // a disabled control doesn't fire) must not start another rewrite.
    presetBtn("longer").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();
    expect(rewriter.ledger.instances).toHaveLength(1);

    token.resolve("Short.");
    await settle();
    expect(presetBtns().every((b) => !b.disabled)).toBe(true);
    expect($("editor").value).toBe("Short.");
  });
});
