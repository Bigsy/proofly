import { Dialect, WorkerLinter } from "./vendor/harper/index.js";
import { binary } from "./vendor/harper/binary.js";
import { createHarperService } from "./lib/harper-service.js";

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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "harper:offscreen") return undefined;
  const { target: _target, ...request } = message;
  service.handle(request).then(sendResponse).catch((error) => sendResponse({
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
