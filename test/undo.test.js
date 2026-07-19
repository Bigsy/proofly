// P1 — real undo: every programmatic mutation routes
// through replaceEditorText (execCommand "insertText" → native undo stack),
// exactly one proofread per apply, the Apply-all toast, the header ↶/↷
// buttons, and abort-on-mutation.
//
// The page harness stubs execCommand/queryCommandEnabled (jsdom has
// neither) with a one-deep history — see helpers/page.js.

import { describe, expect, it } from "vitest";
import { createMockProofreader } from "./helpers/mock-proofreader.js";
import {
  $,
  correctionCards,
  execCommands,
  loadPage,
  settle,
  tick,
  typeInEditor,
} from "./helpers/page.js";
import basic from "./fixtures/basic-grammar-spelling.json";

async function loadFixture(fixture) {
  const mock = createMockProofreader({ results: [fixture.result] });
  await loadPage({ text: fixture.input, mock });
  return mock;
}

describe("replaceEditorText (undo-preserving writes)", () => {
  it("routes single-fix apply through execCommand('insertText')", async () => {
    await loadFixture(basic);

    correctionCards()[0].querySelector("button").click(); // "seen" → "saw"
    await settle();

    const expected =
      "I saw him yesterday at the store, and he bought two loafs of bread.";
    expect($("editor").value).toBe(expected);
    expect(execCommands()).toContainEqual(["insertText", expected]);
  });

  it("routes Apply-all through execCommand('insertText')", async () => {
    await loadFixture(basic);

    $("applyBtn").click();
    await settle();

    expect($("editor").value).toBe(basic.result.correctedInput);
    expect(execCommands()).toContainEqual([
      "insertText",
      basic.result.correctedInput,
    ]);
  });

  it("triggers exactly ONE proofread per apply — the debounce is cancelled", async () => {
    const mock = await loadFixture(basic);

    correctionCards()[0].querySelector("button").click();
    await settle();
    // Immediate re-proofread (load + apply = 2 instances)…
    expect(mock.ledger.instances).toHaveLength(2);

    // …and the input event's 700 ms debounce must NOT fire a duplicate.
    await tick(700);
    expect(mock.ledger.instances).toHaveLength(2);
  });
});

describe("undo toast", () => {
  it("appears on Apply-all with the correction count, not on single-fix apply", async () => {
    await loadFixture(basic);
    expect($("toast").hidden).toBe(true);

    $("applyBtn").click();
    await settle();
    expect($("toast").hidden).toBe(false);
    expect($("toastText").textContent).toBe("Applied 2 corrections");
  });

  it("stays hidden for a single-fix apply", async () => {
    await loadFixture(basic);

    correctionCards()[0].querySelector("button").click();
    await settle();
    expect($("toast").hidden).toBe(true);
  });

  it("auto-dismisses after 8 s", async () => {
    await loadFixture(basic);

    $("applyBtn").click();
    await settle();
    expect($("toast").hidden).toBe(false);

    await tick(7999);
    expect($("toast").hidden).toBe(false);
    await tick(1);
    expect($("toast").hidden).toBe(true);
  });

  it("dismisses on the next user edit", async () => {
    await loadFixture(basic);

    $("applyBtn").click();
    await settle();
    expect($("toast").hidden).toBe(false);

    typeInEditor(basic.result.correctedInput + " More.");
    expect($("toast").hidden).toBe(true);
  });

  it("Undo restores the pre-apply text and re-proofreads via the debounce", async () => {
    const mock = await loadFixture(basic);

    $("applyBtn").click();
    await settle();
    expect($("editor").value).toBe(basic.result.correctedInput);
    expect(mock.ledger.instances).toHaveLength(2); // load + apply

    $("toastUndo").click();
    expect(execCommands()).toContainEqual(["undo"]);
    expect($("editor").value).toBe(basic.input);
    expect($("toast").hidden).toBe(true);

    // Undo goes through the plain debounced path — no immediate proofread.
    expect(mock.ledger.instances).toHaveLength(2);
    await tick(700);
    expect(mock.ledger.instances).toHaveLength(3);
    expect(mock.ledger.instances[2].proofreadCalls).toEqual([basic.input]);
  });
});

describe("header undo/redo buttons", () => {
  it("start disabled and enable/disable with the native stack state", async () => {
    await loadFixture(basic);
    expect($("undoBtn").disabled).toBe(true);
    expect($("redoBtn").disabled).toBe(true);

    $("applyBtn").click(); // insertText pushes an undo entry
    await settle();
    expect($("undoBtn").disabled).toBe(false);
    expect($("redoBtn").disabled).toBe(true);
  });

  it("round-trips undo → redo through execCommand", async () => {
    await loadFixture(basic);

    $("applyBtn").click();
    await settle();

    $("undoBtn").click();
    expect(execCommands()).toContainEqual(["undo"]);
    expect($("editor").value).toBe(basic.input);
    // One-deep stub history: the undo is consumed, redo becomes available.
    expect($("undoBtn").disabled).toBe(true);
    expect($("redoBtn").disabled).toBe(false);

    $("redoBtn").click();
    expect(execCommands()).toContainEqual(["redo"]);
    expect($("editor").value).toBe(basic.result.correctedInput);
    expect($("undoBtn").disabled).toBe(false);
    expect($("redoBtn").disabled).toBe(true);

    await tick(700); // let the debounced re-proofread land (clean default)
  });
});

describe("Harper invalidation on mutation", () => {
  it("invalidates an in-flight lint the moment the editor mutates", async () => {
    const mock = createMockProofreader();
    await loadPage({ mock });

    mock.enqueueControlled();
    typeInEditor("first draft");
    await tick(700);
    // Synchronously on input — NOT 700 ms later when the next run starts —
    // the captured snapshot becomes stale. Harper itself is not cancellable.
    typeInEditor("second draft");

    await tick(700); // request B proceeds normally
    expect(mock.ledger.instances).toHaveLength(2);
    expect($("summary").textContent).toBe("No issues found");
  });

  it("a programmatic write invalidates an in-flight lint", async () => {
    const mock = await loadFixture(basic);

    // Start a new lint from an edit and leave it in flight.
    mock.enqueueControlled();
    typeInEditor(basic.input + " ");
    await tick(700);

    // A programmatic whole-text apply also invalidates that snapshot and
    // immediately issues a fresh lint.
    $("editor").value = basic.input;
    $("editor").dispatchEvent(new Event("input", { bubbles: true }));
    await tick(700);
    await settle();
    expect(mock.ledger.instances).toHaveLength(3);
  });
});

describe("stale Apply-all guard", () => {
  it("disables Apply-all the moment the editor mutates, until fresh results land", async () => {
    const mock = await loadFixture(basic);
    expect($("applyBtn").disabled).toBe(false);

    typeInEditor("I seen him yesterday."); // user edit → result is stale
    expect($("applyBtn").disabled).toBe(true);

    // A click in the stale window must not touch the editor (the old
    // correctedInput refers to text that no longer exists).
    $("applyBtn").click();
    await settle();
    expect($("editor").value).toBe("I seen him yesterday.");
    expect($("toast").hidden).toBe(true);

    mock.enqueue({
      correctedInput: "I saw him yesterday.",
      corrections: [{ startIndex: 2, endIndex: 6, correction: "saw" }],
    });
    await tick(700);
    expect($("applyBtn").disabled).toBe(false);
  });

  it("is disabled after a clean result — nothing to apply", async () => {
    const mock = createMockProofreader();
    await loadPage({ text: "All good here.", mock });
    expect($("applyBtn").disabled).toBe(true);
  });

  it("is disabled during the post-apply window, so the toast count can't lie", async () => {
    const mock = await loadFixture(basic);

    mock.enqueueControlled(); // the re-proofread after the fix hangs
    correctionCards()[0].querySelector("button").click();
    await settle();
    // No "Applied 0 corrections" possible: the action is gone until the
    // re-proofread renders a fresh result.
    expect($("applyBtn").disabled).toBe(true);
  });
});
