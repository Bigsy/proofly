import { describe, expect, it, vi } from "vitest";
import { createHarperCoordinator } from "../lib/harper-coordinator.js";

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

describe("Harper coordinator", () => {
  it("requires a stable scope id", () => {
    expect(() => createHarperCoordinator()).toThrow(/scopeId/);
    expect(() => createHarperCoordinator({ scopeId: "" })).toThrow(/scopeId/);
  });

  it("stamps requests and returns only a matching serializable result", async () => {
    const sendMessage = vi.fn(async (message) => ({
      type: "harper:result", requestId: message.requestId, corrections: [{ correction: "weird" }],
    }));
    const statuses = [];
    const coordinator = createHarperCoordinator({
      scopeId: "sidepanel:note-1", sendMessage, onStatus: (status) => statuses.push(status.state),
    });

    expect(await coordinator.capture().lint("wierd")).toEqual([{ correction: "weird" }]);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "harper:lint", scopeId: "sidepanel:note-1", text: "wierd",
      requestId: "sidepanel:note-1:1",
    }));
    expect(statuses).toEqual(["proofreading", "ready"]);
  });

  it("ignores an older result as soon as a newer snapshot acquires the slot", async () => {
    const first = deferred();
    const sendMessage = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(async (message) => ({
        type: "harper:result", requestId: message.requestId, corrections: [],
      }));
    const coordinator = createHarperCoordinator({ scopeId: "field-1", sendMessage });
    const old = coordinator.capture().lint("old");
    const latest = coordinator.capture().lint("latest");
    first.resolve({ type: "harper:result", requestId: "field-1:1", corrections: [{ correction: "x" }] });

    expect(await old).toBe(null);
    expect(await latest).toEqual([]);
  });

  it("allows several sequential windows in one captured snapshot", async () => {
    const sendMessage = vi.fn(async (message) => ({
      type: "harper:result", requestId: message.requestId, corrections: [message.text],
    }));
    const batch = createHarperCoordinator({ scopeId: "tab:frame:field", sendMessage }).capture();

    // The real service is latest-only within a scope. Window orchestration is
    // intentionally sequential; a batch prevents its sequential windows from
    // being invalidated locally by a newer editor snapshot.
    expect(await batch.lint("window one")).toEqual(["window one"]);
    expect(await batch.lint("window two")).toEqual(["window two"]);
  });

  it("retries a stale response only while the captured snapshot remains current", async () => {
    const sendMessage = vi.fn()
      .mockResolvedValueOnce({ type: "harper:stale", requestId: "panel:1" })
      .mockImplementationOnce(async (message) => ({
        type: "harper:result", requestId: message.requestId, corrections: [],
      }));
    const coordinator = createHarperCoordinator({ scopeId: "panel", sendMessage });
    expect(await coordinator.capture().lint("text")).toEqual([]);
    expect(sendMessage).toHaveBeenCalledTimes(2);

    const pending = deferred();
    sendMessage.mockImplementationOnce(() => pending.promise);
    const old = coordinator.capture();
    const result = old.lint("old");
    coordinator.invalidate();
    pending.resolve({ type: "harper:stale", requestId: "panel:3" });
    expect(await result).toBe(null);
    expect(sendMessage).toHaveBeenCalledTimes(3);
  });

  it("degrades quietly and reports errors without throwing into the surface", async () => {
    const statuses = [];
    const coordinator = createHarperCoordinator({
      scopeId: "panel",
      sendMessage: async () => { throw new Error("worker gone"); },
      onStatus: (status) => statuses.push(status),
    });
    expect(await coordinator.capture().lint("text")).toBe(null);
    expect(statuses.at(-1)).toMatchObject({ state: "error", error: { message: "worker gone" } });
  });
});
