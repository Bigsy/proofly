// In-page Harper adapter: validation, stable scopes, supersession, incremental
// window results, and silent failure below the DOM/session boundary.

import { describe, expect, it, vi } from "vitest";
import { createPageEngine, normalizeCorrections } from "../page/content/engine.js";
import { createSupersedeSlot } from "../lib/supersede.js";

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function responder(results = []) {
  const queue = [...results];
  return vi.fn(async (message) => {
    const next = queue.shift() ?? [];
    const corrections = typeof next === "function" ? await next(message) : await next;
    return { type: "harper:result", requestId: message.requestId, corrections };
  });
}

function makeEngine(sendMessage) {
  return createPageEngine({ supersede: createSupersedeSlot(), sendMessage });
}

describe("normalizeCorrections", () => {
  const text = "I seen it.";

  it("keeps well-formed corrections, including insertions", () => {
    const ok = [
      { startIndex: 2, endIndex: 6, correction: "saw" },
      { startIndex: 10, endIndex: 10, correction: "," },
    ];
    expect(normalizeCorrections(text, ok)).toEqual(ok);
  });

  it("drops malformed and out-of-range entries", () => {
    expect(normalizeCorrections(text, [
      null,
      { startIndex: "x", endIndex: 4, correction: "a" },
      { startIndex: -1, endIndex: 4, correction: "a" },
      { startIndex: 6, endIndex: 2, correction: "a" },
      { startIndex: 0, endIndex: 999, correction: "a" },
      { startIndex: 0, endIndex: 2, correction: 42 },
    ])).toEqual([]);
  });
});

describe("createPageEngine", () => {
  it("returns canonical corrections and derives corrected text by splicing", async () => {
    const correction = { startIndex: 2, endIndex: 6, correction: "saw", types: ["grammar"] };
    const engine = makeEngine(responder([[correction]]));
    expect(await engine.proofread("I seen it.", { scopeId: "field:1" })).toEqual({
      text: "I seen it.", corrections: [correction], corrected: "I saw it.",
    });
  });

  it("stamps the stable field scope on runtime requests", async () => {
    const sendMessage = responder([[]]);
    await makeEngine(sendMessage).proofread("text", { scopeId: "tab:4:frame:0:field:2" });
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "harper:lint", scopeId: "tab:4:frame:0:field:2", text: "text",
    }));
  });

  it("supersedes an in-flight result without waiting for Harper cancellation", async () => {
    const slow = deferred();
    const sendMessage = responder([
      slow.promise,
      [{ startIndex: 0, endIndex: 6, correction: "Second" }],
    ]);
    const engine = makeEngine(sendMessage);
    const first = engine.proofread("first", { scopeId: "field:1" });
    const second = engine.proofread("second", { scopeId: "field:1" });
    expect(await second).toMatchObject({ corrected: "Second" });
    slow.resolve([]);
    expect(await first).toBe(null);
  });

  it("does not supersede independent field scopes at the Harper boundary", async () => {
    const first = deferred();
    const sendMessage = responder([first.promise, []]);
    const engine = makeEngine(sendMessage);
    const a = engine.proofread("one", { scopeId: "field:a" });
    // The page-level supersede slot still reflects the one-active-field UI,
    // but the emitted service scopes remain independent and stable.
    const b = engine.proofread("two", { scopeId: "field:b" });
    first.resolve([]);
    await Promise.all([a, b]);
    expect(sendMessage.mock.calls.map(([m]) => m.scopeId)).toEqual(["field:a", "field:b"]);
  });

  it("proofreads windows sequentially and reports completed prefixes", async () => {
    const first = { text: "I seen it.", baseOffset: 0 };
    const second = { text: "teh result.", baseOffset: 8 };
    const sendMessage = responder([
      [{ startIndex: 2, endIndex: 6, correction: "saw" }],
      [{ startIndex: 0, endIndex: 3, correction: "the" }],
    ]);
    const partials = [];
    const result = await makeEngine(sendMessage).proofreadWindows([first, second], {
      scopeId: "field:1",
      onWindowResult: (soFar) => partials.push(soFar),
    });
    expect(partials).toHaveLength(1);
    expect(partials[0][0]).toMatchObject({ window: first, corrected: "I saw it." });
    expect(result[1]).toMatchObject({ window: second, corrected: "the result." });
    expect(sendMessage.mock.calls.map(([m]) => m.text)).toEqual(["I seen it.", "teh result."]);
  });

  it("keeps already-reported windows when a later window fails", async () => {
    const sendMessage = vi.fn()
      .mockImplementationOnce(async (message) => ({
        type: "harper:result", requestId: message.requestId, corrections: [],
      }))
      .mockImplementationOnce(async (message) => ({
        type: "harper:error", requestId: message.requestId,
        error: { code: "lint_failed", message: "WASM failed" },
      }));
    const partials = [];
    const result = await makeEngine(sendMessage).proofreadWindows(
      [{ text: "first" }, { text: "second" }],
      { onWindowResult: (soFar) => partials.push(soFar) },
    );
    expect(result).toBe(null);
    expect(partials).toHaveLength(1);
  });

  it("silently degrades on messaging failures and malformed responses", async () => {
    const failed = makeEngine(async () => { throw new Error("context invalidated"); });
    expect(await failed.proofread("text")).toBe(null);
    const malformed = makeEngine(async () => ({ type: "unexpected" }));
    expect(await malformed.proofread("text")).toBe(null);
  });
});
