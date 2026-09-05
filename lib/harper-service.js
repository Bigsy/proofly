import { ruleCatalog } from "./harper-rules.js";
import { normalizeOrganizedHarperLints } from "./harper-corrections.js";

export const HARPER_DIALECTS = Object.freeze([
  "american", "british", "australian", "canadian", "indian",
]);

function errorResult(requestId, code, error) {
  return {
    type: "harper:error",
    requestId: requestId ?? null,
    error: {
      code,
      message: error instanceof Error ? error.message : String(error || code),
    },
  };
}

// Owns one linter and one serialized operation queue. createLinter is injected
// so tests never load WASM; offscreen.js supplies the packaged WorkerLinter.
export function createHarperService({ createLinter, switchDialect = (worker, name) => worker.setDialect(name) }) {
  let linter = null;
  let dialect = null;
  let configuredRevision = -1;
  let appliedRuleOverrides = {};
  let appliedWeirpackIds = [];
  let setupState = "idle";
  let queue = Promise.resolve();
  let lintSequence = 0;
  const latestLintByScope = new Map();
  let disposed = false;

  function enqueue(task) {
    const result = queue.then(task, task);
    queue = result.catch(() => {});
    return result;
  }

  async function ensureLinter(nextDialect) {
    if (disposed) throw new Error("Harper service has been disposed");
    if (linter) return linter;
    setupState = "initializing";
    try {
      linter = await createLinter(nextDialect);
      await linter.setup();
      dialect = nextDialect;
      setupState = "ready";
      return linter;
    } catch (error) {
      const failedWorker = linter;
      linter = null;
      setupState = "error";
      try { await failedWorker?.dispose?.(); } catch { /* preserve the setup error */ }
      throw error;
    }
  }

  async function applyRuleOverrides(worker, ruleOverrides) {
    // getLintConfig becomes sparse after setLintConfig; defaults retain the
    // complete built-in catalogue. Include active pack-provided rules too.
    const available = { ...await worker.getDefaultLintConfig(), ...await worker.getLintConfig() };
    const supported = {};
    const changes = {};

    // A removed Proofly override must return to Harper's default in a
    // long-lived worker. Unsupported names are ignored so rule drift in a
    // future Harper upgrade cannot disable proofreading altogether.
    for (const name of Object.keys(appliedRuleOverrides)) {
      if (!Object.hasOwn(ruleOverrides, name) && Object.hasOwn(available, name)) {
        changes[name] = null;
      }
    }
    for (const [name, value] of Object.entries(ruleOverrides)) {
      if (!Object.hasOwn(available, name)) continue;
      supported[name] = value;
      changes[name] = value;
    }

    if (Object.keys(changes).length) await worker.setLintConfig(changes);
    appliedRuleOverrides = supported;
  }

  async function configure(message) {
    const {
      dialect: nextDialect, words, ruleOverrides, weirpacks = [], configurationRevision,
    } = message;
    const validRules = ruleOverrides && typeof ruleOverrides === "object"
      && !Array.isArray(ruleOverrides)
      && Object.entries(ruleOverrides).every(([name, value]) =>
        !!name && (typeof value === "boolean" || value === null));
    const validWeirpacks = Array.isArray(weirpacks)
      && weirpacks.every((pack) =>
        typeof pack?.id === "string" && pack.id
        && Array.isArray(pack.bytes)
        && pack.bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255));
    if (!HARPER_DIALECTS.includes(nextDialect)
      || !Array.isArray(words) || !validRules
      || !validWeirpacks
      || !Number.isInteger(configurationRevision) || configurationRevision < 0
      || words.some((word) => typeof word !== "string")) {
      return errorResult(null, "invalid_config", "Invalid Harper configuration");
    }
    return enqueue(async () => {
      try {
        const worker = await ensureLinter(nextDialect);
        if (dialect !== nextDialect) {
          await switchDialect(worker, nextDialect);
          dialect = nextDialect;
          configuredRevision = -1;
          appliedRuleOverrides = {};
          appliedWeirpackIds = [];
        }
        if (configuredRevision !== configurationRevision) {
          // Weirpacks can add rules as well as words and Harper has no
          // unload-pack API. Recreate the linter whenever an already-applied
          // pack configuration changes so removed/replaced rules cannot leak.
          if (appliedWeirpackIds.length || weirpacks.length) {
            if (configuredRevision >= 0) {
              await worker.dispose();
              linter = null;
              setupState = "initializing";
              linter = await createLinter(nextDialect);
              await linter.setup();
              setupState = "ready";
              appliedRuleOverrides = {};
            }
          }
          const configuredWorker = linter;
          // Invalidate before mutating any part of the worker. A partial
          // configure failure must not let an old-stamped lint proceed.
          configuredRevision = -1;
          await configuredWorker.clearWords();
          for (const pack of weirpacks) {
            const failures = await configuredWorker.loadWeirpackFromBytes(pack.bytes);
            if (failures !== undefined) {
              throw new Error(`Weirpack ${pack.id} failed its tests: ${JSON.stringify(failures)}`);
            }
          }
          if (words.length) await configuredWorker.importWords([...words]);
          await applyRuleOverrides(configuredWorker, ruleOverrides);
          appliedWeirpackIds = weirpacks.map(({ id }) => id);
          configuredRevision = configurationRevision;
        }
        return { type: "harper:configured", dialect, configurationRevision: configuredRevision };
      } catch (error) {
        const failedWorker = linter;
        linter = null;
        dialect = null;
        configuredRevision = -1;
        appliedRuleOverrides = {};
        appliedWeirpackIds = [];
        setupState = "error";
        try { await failedWorker?.dispose?.(); } catch { /* preserve the configuration error */ }
        return errorResult(null, "configure_failed", error);
      }
    });
  }

  async function lint(message) {
    const {
      requestId, text, dialect: requestedDialect, configurationRevision: requestedRevision,
    } = message;
    const scopeId = typeof message.scopeId === "string" && message.scopeId
      ? message.scopeId
      : "default";
    if ((typeof requestId !== "string" && !Number.isInteger(requestId))
      || typeof text !== "string" || !HARPER_DIALECTS.includes(requestedDialect)
      || !Number.isInteger(requestedRevision) || requestedRevision < 0) {
      return errorResult(requestId, "invalid_request", "Invalid Harper lint request");
    }
    const sequence = ++lintSequence;
    latestLintByScope.set(scopeId, sequence);
    return enqueue(async () => {
      if (sequence !== latestLintByScope.get(scopeId)) {
        return { type: "harper:stale", requestId };
      }
      if (dialect !== requestedDialect || configuredRevision !== requestedRevision) {
        if (latestLintByScope.get(scopeId) === sequence) latestLintByScope.delete(scopeId);
        return errorResult(requestId, "stale_configuration", "Harper configuration is stale");
      }
      let lints = [];
      try {
        const worker = await ensureLinter(requestedDialect);
        const groups = await worker.organizedLints(text, { language: "plaintext" });
        lints = Object.values(groups).flat();
        if (sequence !== latestLintByScope.get(scopeId)) {
          return { type: "harper:stale", requestId };
        }
        return {
          type: "harper:result",
          requestId,
          corrections: normalizeOrganizedHarperLints(text, groups),
        };
      } catch (error) {
        return errorResult(requestId, "lint_failed", error);
      } finally {
        for (const item of Array.isArray(lints) ? lints : []) {
          try { item?.free?.(); } catch { /* best-effort WASM cleanup */ }
        }
        if (latestLintByScope.get(scopeId) === sequence) latestLintByScope.delete(scopeId);
      }
    });
  }

  function rules() {
    return enqueue(async () => {
      try {
        if (!linter || configuredRevision < 0) throw new Error("Harper is not configured");
        const [structured, defaults, descriptions, available] = await Promise.all([
          linter.getStructuredLintConfig(), linter.getDefaultLintConfig(),
          linter.getLintDescriptions(), linter.getLintConfig(),
        ]);
        return { type: "harper:rules", rules: ruleCatalog(structured, defaults, descriptions, available) };
      } catch (error) {
        return errorResult(null, "rules_failed", error);
      }
    });
  }

  function status() {
    return {
      type: "harper:status",
      state: setupState,
      dialect,
      configurationRevision: configuredRevision,
    };
  }

  async function dispose() {
    disposed = true;
    await queue.catch(() => {});
    const worker = linter;
    linter = null;
    setupState = "disposed";
    if (worker) await worker.dispose();
  }

  function handle(message) {
    switch (message?.type) {
      case "harper:configure": return configure(message);
      case "harper:lint": return lint(message);
      case "harper:rules": return rules();
      case "harper:status": return Promise.resolve(status());
      default: return Promise.resolve(errorResult(message?.requestId, "unknown_request", "Unknown Harper request"));
    }
  }

  return { handle, dispose, status };
}
