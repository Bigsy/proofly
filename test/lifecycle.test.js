// P1/P2 — instance lifecycle and async wiring: the fresh-instance-per-call
// invariant, the 700 ms debounce, and out-of-order result handling.
//
// The mock's shared-afterEach tripwires already fail any test where an
// instance is reused or leaked; the tests here document the invariants
// explicitly and pin down the counts.

import { describe, expect, it } from "vitest";
import { createMockProofreader } from "./helpers/mock-proofreader.js";
import {
  $,
  clickEditorAt,
  loadPage,
  settle,
  squiggles,
  tick,
  typeInEditor,
} from "./helpers/page.js";
import basic from "./fixtures/basic-grammar-spelling.json";

describe("fresh-instance invariant", () => {
  it("uses a fresh create/proofread/destroy per proofread", async () => {
    const mock = createMockProofreader({ results: [basic.result] });
    await loadPage({ text: basic.input, mock }); // auto-run = proofread #1

    typeInEditor("Some new text to proofread.");
    await tick(700); // debounce → proofread #2

    const { instances } = mock.ledger;
    expect(instances).toHaveLength(2);
    expect(instances[0].proofreadCalls).toEqual([basic.input]);
    expect(instances[1].proofreadCalls).toEqual(["Some new text to proofread."]);
    for (const inst of instances) expect(inst.destroyed).toBe(true);
  });
});

describe("debounce", () => {
  it("coalesces rapid edits into one proofread after 700 ms", async () => {
    const mock = createMockProofreader();
    await loadPage({ mock }); // empty editor → no auto-run

    typeInEditor("first");
    await tick(200);
    typeInEditor("first second");
    await tick(200);
    typeInEditor("first second third");
    await tick(699);
    expect(mock.ledger.instances).toHaveLength(0); // not yet

    await tick(1);
    expect(mock.ledger.instances).toHaveLength(1); // exactly one
    expect(mock.ledger.instances[0].proofreadCalls).toEqual([
      "first second third",
    ]);
  });
});

describe("request sequencing", () => {
  it("ignores a superseded request's late result", async () => {
    const mock = createMockProofreader();
    await loadPage({ mock });

    // Request A: never resolves until we say so.
    const slowA = mock.enqueueControlled();
    typeInEditor("first draft");
    await tick(700);
    expect(mock.ledger.instances).toHaveLength(1); // A in flight

    // Request B supersedes it and lands immediately.
    mock.enqueue({
      correctedInput: "Second draft",
      corrections: [
        { startIndex: 0, endIndex: 6, correction: "Second", types: ["capitalization"] },
      ],
    });
    typeInEditor("second draft");
    await tick(700);

    expect(mock.ledger.instances).toHaveLength(2);
    expect(squiggles().map((s) => s.textContent)).toEqual(["second"]);
    expect($("summary").textContent).toBe("1 correction suggested.");

    // A's late resolution must change nothing.
    slowA.resolve({ correctedInput: "STALE", corrections: [] });
    await settle();
    expect($("summary").textContent).toBe("1 correction suggested.");
    expect(squiggles().map((s) => s.textContent)).toEqual(["second"]);

    // Apply-all applies B's corrected text, not A's stale one.
    $("applyBtn").click();
    await settle();
    expect($("editor").value).toBe("Second draft");
    // (afterEach tripwire also verifies A's instance still got destroyed.)
  });

  it("invalidates the in-flight request when superseded", async () => {
    const mock = createMockProofreader();
    await loadPage({ mock });

    // Request A: still in flight when B lands.
    mock.enqueueControlled();
    typeInEditor("first draft");
    await tick(700);
    typeInEditor("second draft");
    await tick(700);

    // Harper has no per-lint cancellation. B renders while A's eventual
    // response is ignored by the captured-snapshot guard.
    expect(mock.ledger.instances).toHaveLength(2);
    expect($("summary").textContent).toBe("No issues found");
    // (afterEach tripwire verifies A's aborted instance still got destroyed.)
  });
});

describe("stale-squiggle clearing", () => {
  it("clears squiggles and hides the popup the moment the text changes", async () => {
    const mock = createMockProofreader({ results: [basic.result] });
    await loadPage({ text: basic.input, mock });
    expect(squiggles()).toHaveLength(2);

    clickEditorAt(3); // inside "seen" → popup opens
    expect($("popup").hidden).toBe(false);

    typeInEditor(basic.input + " More.");
    // Synchronously on input — before the debounced proofread runs.
    expect(squiggles()).toHaveLength(0);
    expect($("highlights").textContent).toBe("");
    expect($("popup").hidden).toBe(true);

    await tick(700); // let the pending proofread land (default clean result)
    expect($("summary").textContent).toBe("No issues found");
  });
});
