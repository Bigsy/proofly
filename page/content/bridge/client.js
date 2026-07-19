export const BRIDGE_PROTOCOL_VERSION = "proofly-editor-bridge/v1";
export const BRIDGE_REQUEST_EVENT = "proofly:bridge:request";
export const BRIDGE_RESPONSE_EVENT = "proofly:bridge:response";

export function createBridgeClient({
  target = globalThis,
  protocolVersion = BRIDGE_PROTOCOL_VERSION,
  requestEvent = BRIDGE_REQUEST_EVENT,
  responseEvent = BRIDGE_RESPONSE_EVENT,
  timeoutMs = 500,
  allowedCapabilities = [],
} = {}) {
  let seq = 0;
  let disposed = false;
  const pending = new Map();
  const allowed = new Set(allowedCapabilities);

  function onResponse(event) {
    const detail = event?.detail;
    if (!detail || detail.protocolVersion !== protocolVersion) return;
    const slot = pending.get(detail.requestId);
    if (!slot) return;
    clearTimeout(slot.timer);
    pending.delete(detail.requestId);
    if (detail.ok === true) slot.resolve(detail.payload);
    else slot.reject(new Error(typeof detail.error === "string" ? detail.error : "Bridge request failed"));
  }

  target.addEventListener?.(responseEvent, onResponse);

  function request(capability, payload) {
    if (disposed) return Promise.reject(new Error("Bridge client disposed"));
    if (!allowed.has(capability)) return Promise.reject(new Error(`Bridge capability denied: ${capability}`));

    const requestId = `proofly-${Date.now()}-${++seq}`;
    const message = { protocolVersion, requestId, capability, payload };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`Bridge request timed out: ${capability}`));
      }, timeoutMs);
      pending.set(requestId, { resolve, reject, timer });
      target.dispatchEvent?.(new CustomEvent(requestEvent, { detail: message }));
    });
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    target.removeEventListener?.(responseEvent, onResponse);
    for (const [requestId, slot] of pending) {
      clearTimeout(slot.timer);
      slot.reject(new Error(`Bridge request ${requestId} disposed`));
    }
    pending.clear();
  }

  return { request, dispose, pendingCount: () => pending.size };
}
