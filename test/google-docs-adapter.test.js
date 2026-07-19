import { afterEach, describe, expect, it, vi } from "vitest";
import { createBridgeClient } from "../page/content/bridge/client.js";
import { createBridgeResponder } from "../page/content/bridge/main.js";
import {
  applyGoogleDocsCorrection,
  createGoogleDocsSnapshot,
  DOCS_PARAGRAPH_SENTINEL,
  DOCS_WIDGET_SENTINEL,
  GOOGLE_DOCS_BRIDGE_CAPABILITIES,
  normalizeGoogleDocsText,
  readGoogleDocsSnapshot,
} from "../page/content/adapters/google-docs.js";
import { assertSnapshot } from "../page/content/snapshot.js";

let responders = [];

afterEach(() => {
  for (const responder of responders) responder.dispose();
  responders = [];
});

function responder(options) {
  const r = createBridgeResponder(options);
  responders.push(r);
  return r;
}

function root() {
  const el = document.createElement("div");
  el.dataset.prooflyGoogleDocsRoot = "true";
  document.body.appendChild(el);
  return el;
}

function client(options = {}) {
  return createBridgeClient({
    allowedCapabilities: GOOGLE_DOCS_BRIDGE_CAPABILITIES,
    timeoutMs: 20,
    ...options,
  });
}

describe("google docs adapter", () => {
  it("normalizes Docs sentinels and keeps bidirectional maps explicit", () => {
    const normalized = normalizeGoogleDocsText(`Hi${DOCS_PARAGRAPH_SENTINEL}A${DOCS_WIDGET_SENTINEL}da`);
    expect(normalized.text).toBe("Hi\nAda");
    expect(normalized.rawToLogical).toEqual([0, 1, 2, 3, 4, 4, 5, 6]);
    expect(normalized.logicalToRaw).toEqual([0, 1, 2, 3, 4, 6, 7]);
  });

  it("creates a framework snapshot with visual ranges", () => {
    const el = root();
    const snapshot = createGoogleDocsSnapshot(el, {
      rawText: `I seen${DOCS_PARAGRAPH_SENTINEL}it.`,
      revision: "r1",
      layoutRevision: "l1",
      selectionOffset: 3,
      spans: [{ start: 2, end: 6, rects: [{ left: 1, top: 2, width: 30, height: 10 }] }],
    });
    expect(assertSnapshot(snapshot)).toBe(snapshot);
    expect(snapshot.kind).toBe("framework");
    expect(snapshot.text).toBe("I seen\nit.");
    expect(snapshot.rangeForSpan(2, 6).rects).toHaveLength(1);
    expect(snapshot.offsetForPoint()).toBe(3);
  });

  it("applies through the bridge and verifies the post-write logical text", async () => {
    const el = root();
    let text = "I seen it.";
    responder({
      handlers: {
        "docs.read": async () => ({
          logicalText: text,
          revision: text,
          layoutRevision: "layout",
          spans: [{ start: 2, end: 6, rects: [{}] }],
        }),
        "docs.replace": async ({ start, end, replacement, expectedText }) => {
          if (text.slice(start, end) !== expectedText) throw new Error("stale span");
          text = text.slice(0, start) + replacement + text.slice(end);
          return { ok: true };
        },
      },
    });
    const c = client();
    const snapshot = await readGoogleDocsSnapshot(el, c);

    await expect(applyGoogleDocsCorrection(el, snapshot, {
      startIndex: 2,
      endIndex: 6,
      correction: "saw",
    }, c)).resolves.toEqual({ applied: true, newCaret: 5 });
    expect(text).toBe("I saw it.");
    c.dispose();
  });

  it("fails closed for stale, read-only, visual-only, and unverifiable writes", async () => {
    const el = root();
    const c = client();
    responder({
      handlers: {
        "docs.read": async () => ({ logicalText: "I seen it.", revision: "after" }),
        "docs.replace": async () => ({ ok: true }),
      },
    });

    await expect(applyGoogleDocsCorrection(el, createGoogleDocsSnapshot(el, {
      logicalText: "I seen it.",
      current: false,
    }), { startIndex: 2, endIndex: 6, correction: "saw" }, c)).resolves.toEqual({ applied: false });

    await expect(applyGoogleDocsCorrection(el, createGoogleDocsSnapshot(el, {
      logicalText: "I seen it.",
      readOnly: true,
    }), { startIndex: 2, endIndex: 6, correction: "saw" }, c)).resolves.toEqual({ applied: false });

    await expect(applyGoogleDocsCorrection(el, createGoogleDocsSnapshot(el, {
      logicalText: "I seen it.",
      visualOnly: true,
    }), { startIndex: 2, endIndex: 6, correction: "saw" }, c)).resolves.toEqual({ applied: false });

    await expect(applyGoogleDocsCorrection(el, createGoogleDocsSnapshot(el, {
      logicalText: "I seen it.",
    }), { startIndex: 2, endIndex: 6, correction: "saw" }, c)).resolves.toEqual({ applied: false });
    c.dispose();
  });

  it("times out and disposes pending bridge requests", async () => {
    vi.useFakeTimers();
    const c = client();
    const promise = readGoogleDocsSnapshot(root(), c);
    const assertion = expect(promise).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
    c.dispose();
  });
});
