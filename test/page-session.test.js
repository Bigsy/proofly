// page/content/session.js — the snapshot-ownership discipline. The rule
// (documented in session.js/index.js): the lint result owns its snapshot;
// a session never keeps one, and every temporary snapshot a session creates
// is disposed before the method returns. The fake adapter here poisons
// disposed snapshots so any use-after-dispose throws instead of passing
// silently (real DOM snapshots have a no-op dispose, which is exactly how
// the old aliasing bug stayed latent).

import { describe, expect, it, vi } from "vitest";
import { EditorSession } from "../page/content/session.js";

function makeFakeAdapter({ reverifyByText = false } = {}) {
  const snapshots = [];
  const adapter = {
    id: "fake",
    match: () => true,
    root: (el) => el,
    isEligible: () => true,
    snapshot(field) {
      const snap = {
        root: field,
        text: field.value ?? "",
        kind: "form",
        disposed: false,
        rangeForSpan() {
          if (this.disposed) throw new Error("rangeForSpan on disposed snapshot");
          return null;
        },
        offsetForPoint() {
          if (this.disposed) throw new Error("offsetForPoint on disposed snapshot");
          return 0;
        },
        isCurrent() {
          if (this.disposed) throw new Error("isCurrent on disposed snapshot");
          return (field.value ?? "") === this.text;
        },
        dispose() { this.disposed = true; },
      };
      snapshots.push(snap);
      return snap;
    },
    apply: vi.fn(async () => ({ applied: true })),
    reverifyByText,
  };
  return { adapter, snapshots };
}

function makeHost(overrides = {}) {
  return {
    gateOpen: () => true,
    isActiveSession: () => true,
    abortInFlight: vi.fn(),
    hidePopup: vi.fn(),
    clearOverlay: vi.fn(),
    clearResult: vi.fn(),
    tryRebase: vi.fn(() => false),
    requestRender: vi.fn(),
    deactivate: vi.fn(),
    runLint: vi.fn(),
    hasResult: () => false,
    resultSnapshot: () => undefined,
    debounceMs: 1000,
    pollMs: 100,
    ...overrides,
  };
}

function makeSession(options) {
  const { adapter, snapshots } = makeFakeAdapter(options);
  const field = document.createElement("textarea");
  document.body.appendChild(field);
  const session = new EditorSession(field, adapter, makeHost());
  return { session, field, adapter, snapshots };
}

describe("EditorSession snapshot ownership", () => {
  it("currentText disposes its temporary snapshot", () => {
    const { session, field, snapshots } = makeSession();
    field.value = "I seen it.";
    expect(session.currentText()).toBe("I seen it.");
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].disposed).toBe(true);
    session.dispose();
  });

  it("takeSnapshot hands ownership to the caller — later session work never disposes it", () => {
    const { session, field, snapshots } = makeSession();
    field.value = "I seen it.";
    const owned = session.takeSnapshot();
    session.currentText();
    session.resultIsCurrent({ text: "I seen it.", snapshot: owned });
    session.dispose(); // session teardown must not touch caller-owned snapshots
    expect(owned.disposed).toBe(false);
    // ...while every temporary the session made for itself was disposed.
    for (const snap of snapshots.filter((s) => s !== owned)) {
      expect(snap.disposed).toBe(true);
    }
  });

  it("resultIsCurrent's reverify path disposes its temporary, not the result's snapshot", () => {
    const { session, field, snapshots } = makeSession({ reverifyByText: true });
    field.value = "I seen it.";
    const resultSnapshot = session.takeSnapshot();
    field.value = "I seen it. "; // stale mapping…
    field.value = "I seen it.";  // …then the text lands back where the result expects
    resultSnapshot.text = "I seen it. "; // simulate a decoration-invalidated snapshot
    expect(resultSnapshot.isCurrent()).toBe(false);

    expect(session.resultIsCurrent({ text: "I seen it.", snapshot: resultSnapshot })).toBe(true);
    const temp = snapshots.at(-1);
    expect(temp).not.toBe(resultSnapshot);
    expect(temp.disposed).toBe(true);
    expect(resultSnapshot.disposed).toBe(false);
    session.dispose();
  });

  it("applyCorrection's reverify path applies through a fresh snapshot and disposes it", async () => {
    const { session, field, adapter, snapshots } = makeSession({ reverifyByText: true });
    field.value = "I seen it.";
    const resultSnapshot = session.takeSnapshot();
    resultSnapshot.text = "outdated mapping"; // stale, but reverifiable by text

    const applied = await session.applyCorrection(
      { text: "I seen it.", snapshot: resultSnapshot },
      { startIndex: 2, endIndex: 6, correction: "saw" },
    );
    expect(applied).toBe(true);
    const temp = snapshots.at(-1);
    expect(adapter.apply).toHaveBeenCalledWith(field, temp, { startIndex: 2, endIndex: 6, correction: "saw" });
    expect(temp.disposed).toBe(true);
    expect(resultSnapshot.disposed).toBe(false);
    session.dispose();
  });

  it("a text-preserving mutation batch neither aborts nor invalidates (Slack-style decoration churn)", () => {
    const { session, field } = makeSession();
    field.value = "I seen it.";
    session.scheduleLint(); // pipeline takes responsibility for this text
    session.host.abortInFlight.mockClear();
    session.host.clearResult.mockClear();

    session.onMutation("mapping"); // decoration span wrap/unwrap — text unchanged
    expect(session.host.abortInFlight).not.toHaveBeenCalled();
    expect(session.host.clearResult).not.toHaveBeenCalled();
    expect(session.host.tryRebase).not.toHaveBeenCalled(); // no result to refresh

    field.value = "I seen it again."; // a real edit still invalidates
    session.onMutation("text");
    expect(session.host.abortInFlight).toHaveBeenCalled();
    session.dispose();
  });

  it("a text-preserving mutation refreshes a stale result mapping via rebase", () => {
    const { adapter } = makeFakeAdapter();
    const field = document.createElement("textarea");
    document.body.appendChild(field);
    const staleResultSnapshot = { isCurrent: () => false };
    const host = makeHost({ resultSnapshot: () => staleResultSnapshot });
    const session = new EditorSession(field, adapter, host);
    field.value = "I seen it.";
    session.scheduleLint();

    session.onMutation("mapping");
    expect(host.tryRebase).toHaveBeenCalledTimes(1);
    expect(host.abortInFlight).not.toHaveBeenCalled();
    session.dispose();
  });

  it("mutations before any scheduled lint, and lang swaps, never take the churn skip", () => {
    const { session, field } = makeSession();
    field.value = "I seen it.";
    session.onMutation("mapping"); // lastText unknown → must invalidate
    expect(session.host.abortInFlight).toHaveBeenCalledTimes(1);

    session.scheduleLint();
    field.setAttribute("lang", "fr"); // unsupported declared language
    session.onMutation("mapping");    // text unchanged, but the gate must run
    expect(session.host.abortInFlight).toHaveBeenCalledTimes(2);
    session.dispose();
  });

  it("refuses to apply when the reverify text no longer matches, without touching the result snapshot", async () => {
    const { session, field, adapter, snapshots } = makeSession({ reverifyByText: true });
    field.value = "The text moved on.";
    const resultSnapshot = session.takeSnapshot();
    resultSnapshot.text = "outdated mapping";

    const applied = await session.applyCorrection(
      { text: "I seen it.", snapshot: resultSnapshot },
      { startIndex: 2, endIndex: 6, correction: "saw" },
    );
    expect(applied).toBe(false);
    expect(adapter.apply).not.toHaveBeenCalled();
    expect(snapshots.at(-1).disposed).toBe(true);
    expect(resultSnapshot.disposed).toBe(false);
    session.dispose();
  });
});
