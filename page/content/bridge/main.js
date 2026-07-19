// EXPERIMENTAL — NO PRODUCTION CALLER. This is the MAIN-world half of the
// editor bridge (the responder); nothing injects it today. The client half
// (bridge/client.js) IS live — the codemirror and trix adapters import it —
// so bridge/* must stay in web_accessible_resources; only this file and the
// google-docs adapter factory are parked. See adapters/google-docs.js for
// what shipping this would take.

import { BRIDGE_PROTOCOL_VERSION, BRIDGE_REQUEST_EVENT, BRIDGE_RESPONSE_EVENT } from "./client.js";

export function createBridgeResponder({
  target = globalThis,
  protocolVersion = BRIDGE_PROTOCOL_VERSION,
  requestEvent = BRIDGE_REQUEST_EVENT,
  responseEvent = BRIDGE_RESPONSE_EVENT,
  handlers = {},
} = {}) {
  let disposed = false;

  async function onRequest(event) {
    const detail = event?.detail;
    if (disposed || !isValidRequest(detail, protocolVersion)) return;
    const { requestId, capability, payload } = detail;
    const handler = handlers[capability];
    if (typeof handler !== "function") {
      respond(requestId, false, null, `Bridge capability unavailable: ${capability}`);
      return;
    }
    try {
      respond(requestId, true, await handler(payload), null);
    } catch (err) {
      respond(requestId, false, null, err?.message ?? "Bridge handler failed");
    }
  }

  function respond(requestId, ok, payload, error) {
    target.dispatchEvent?.(new CustomEvent(responseEvent, {
      detail: { protocolVersion, requestId, ok, payload, error },
    }));
  }

  target.addEventListener?.(requestEvent, onRequest);

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      target.removeEventListener?.(requestEvent, onRequest);
    },
  };
}

function isValidRequest(detail, protocolVersion) {
  return !!detail
    && detail.protocolVersion === protocolVersion
    && typeof detail.requestId === "string"
    && typeof detail.capability === "string";
}
