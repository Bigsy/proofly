import {
  Dialect, WorkerLinter, unpackWeirpackBytes,
} from "./vendor/harper/index.js";
import { binary } from "./vendor/harper/binary.js";
import { createHarperService } from "./lib/harper-service.js";
import { MAX_WEIRPACK_FILE_BYTES } from "./lib/weirpack-store.js";

const DIALECT = Object.freeze({
  american: Dialect.American,
  british: Dialect.British,
  australian: Dialect.Australian,
  canadian: Dialect.Canadian,
  indian: Dialect.Indian,
});

const service = createHarperService({
  createLinter: async (dialect) => new WorkerLinter({ binary, dialect: DIALECT[dialect] }),
  switchDialect: (worker, dialect) => worker.setDialect(DIALECT[dialect]),
});

const manifestText = (value, maxLength) =>
  (typeof value === "string" ? value.trim().slice(0, maxLength) : "");

async function validateWeirpack(message) {
  let validator;
  try {
    if (!Array.isArray(message.bytes)
      || !message.bytes.length || message.bytes.length > MAX_WEIRPACK_FILE_BYTES
      || message.bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
      throw new Error("Invalid Weirpack bytes");
    }
    const bytes = Uint8Array.from(message.bytes);
    const { manifest } = unpackWeirpackBytes(bytes);
    validator = new WorkerLinter({ binary, dialect: Dialect.American });
    await validator.setup();
    const failures = await validator.loadWeirpackFromBytes(bytes);
    if (failures !== undefined) {
      throw new Error(`Weirpack tests failed: ${JSON.stringify(failures)}`);
    }
    return {
      type: "harper:weirpack-valid",
      manifest: {
        author: manifestText(manifest?.author, 120),
        version: manifestText(manifest?.version, 40),
        description: manifestText(manifest?.description, 500),
      },
    };
  } catch (error) {
    return {
      type: "harper:error",
      requestId: null,
      error: { code: "invalid_weirpack", message: String(error?.message || error) },
    };
  } finally {
    await validator?.dispose?.().catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "harper:offscreen") return undefined;
  const { target: _target, ...request } = message;
  const operation = request.type === "harper:validate-weirpack"
    ? validateWeirpack(request)
    : service.handle(request);
  operation.then(sendResponse).catch((error) => sendResponse({
    type: "harper:error",
    requestId: request.requestId ?? null,
    error: {
      code: "offscreen_handler_failed",
      message: String(error?.message || error),
    },
  }));
  return true;
});

globalThis.addEventListener("pagehide", () => {
  service.dispose().catch(() => {});
}, { once: true });
