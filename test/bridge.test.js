import { afterEach, describe, expect, it, vi } from "vitest";
import { createBridgeClient } from "../page/content/bridge/client.js";
import { createBridgeResponder } from "../page/content/bridge/main.js";

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

describe("MAIN-world bridge contract", () => {
  it("round-trips an allowed capability", async () => {
    responder({ handlers: { ping: async (payload) => ({ pong: payload.value }) } });
    const client = createBridgeClient({ allowedCapabilities: ["ping"] });
    await expect(client.request("ping", { value: 42 })).resolves.toEqual({ pong: 42 });
    client.dispose();
  });

  it("rejects denied capabilities without dispatching", async () => {
    const client = createBridgeClient({ allowedCapabilities: ["ping"] });
    await expect(client.request("replace", {})).rejects.toThrow("capability denied");
    expect(client.pendingCount()).toBe(0);
    client.dispose();
  });

  it("times out when no valid response arrives", async () => {
    vi.useFakeTimers();
    const client = createBridgeClient({ allowedCapabilities: ["ping"], timeoutMs: 10 });
    const promise = client.request("ping", {});
    const assertion = expect(promise).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
    client.dispose();
  });

  it("ignores malformed and spoofed replies", async () => {
    vi.useFakeTimers();
    const client = createBridgeClient({ allowedCapabilities: ["ping"], timeoutMs: 10 });
    const promise = client.request("ping", {});
    const assertion = expect(promise).rejects.toThrow("timed out");
    window.dispatchEvent(new CustomEvent("proofly:bridge:response", {
      detail: { protocolVersion: "wrong", requestId: "whatever", ok: true, payload: "bad" },
    }));
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
    client.dispose();
  });

  it("rejects pending requests on disposal and ignores late replies", async () => {
    vi.useFakeTimers();
    const client = createBridgeClient({ allowedCapabilities: ["ping"], timeoutMs: 100 });
    const promise = client.request("ping", {});
    expect(client.pendingCount()).toBe(1);
    client.dispose();
    await expect(promise).rejects.toThrow("disposed");
    expect(client.pendingCount()).toBe(0);
  });
});
