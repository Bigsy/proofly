import { describe, expect, it, vi } from "vitest";
import { createHarperService } from "../lib/harper-service.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function makeLint({ start = 0, end = 3, replacement = "good" } = {}) {
  const free = vi.fn();
  return {
    free,
    span: () => ({ start, end, free: vi.fn() }),
    lint_kind: () => "Spelling",
    message: () => "Possible spelling mistake.",
    suggestions: () => [{
      kind: () => 0,
      get_replacement_text: () => replacement,
      free: vi.fn(),
    }],
  };
}

function makeWorker() {
  return {
    setup: vi.fn(async () => {}),
    lint: vi.fn(async () => []),
    getLintConfig: vi.fn(async () => ({ LongSentences: null })),
    setLintConfig: vi.fn(async () => {}),
    setDialect: vi.fn(async () => {}),
    clearWords: vi.fn(async () => {}),
    importWords: vi.fn(async () => {}),
    loadWeirpackFromBytes: vi.fn(async () => undefined),
    dispose: vi.fn(async () => {}),
  };
}

describe("Harper service", () => {
  it("lazily creates exactly one worker and exposes readiness", async () => {
    const worker = makeWorker();
    const createLinter = vi.fn(async () => worker);
    const service = createHarperService({ createLinter });

    expect(service.status()).toMatchObject({ state: "idle", dialect: null });
    expect(await service.handle({
      type: "harper:configure", dialect: "british", words: [], ruleOverrides: {},
      configurationRevision: 0,
    })).toEqual({ type: "harper:configured", dialect: "british", configurationRevision: 0 });
    expect(service.status()).toMatchObject({ state: "ready", dialect: "british" });
    expect(createLinter).toHaveBeenCalledOnce();
    expect(worker.setup).toHaveBeenCalledOnce();

    await service.handle({
      type: "harper:configure", dialect: "british", words: [], ruleOverrides: {},
      configurationRevision: 0,
    });
    expect(createLinter).toHaveBeenCalledOnce();
  });

  it("serializes dialect changes and batch reimports the complete dictionary", async () => {
    const worker = makeWorker();
    const service = createHarperService({ createLinter: async () => worker });
    await service.handle({
      type: "harper:configure", dialect: "american", words: ["Proofly"],
      ruleOverrides: { LongSentences: false }, configurationRevision: 1,
    });
    await service.handle({
      type: "harper:configure", dialect: "british", words: ["Proofly", "Acme"],
      ruleOverrides: { LongSentences: false }, configurationRevision: 2,
    });

    expect(worker.setDialect).toHaveBeenCalledWith("british");
    expect(worker.clearWords).toHaveBeenCalledTimes(2);
    expect(worker.importWords).toHaveBeenNthCalledWith(1, ["Proofly"]);
    expect(worker.importWords).toHaveBeenNthCalledWith(2, ["Proofly", "Acme"]);
    expect(worker.setLintConfig).toHaveBeenNthCalledWith(1, { LongSentences: false });
    expect(worker.setLintConfig).toHaveBeenNthCalledWith(2, { LongSentences: false });
  });

  it("resets removed rules and ignores overrides unavailable in this Harper build", async () => {
    const worker = makeWorker();
    const service = createHarperService({ createLinter: async () => worker });
    await service.handle({
      type: "harper:configure", dialect: "american", words: [],
      ruleOverrides: { LongSentences: false }, configurationRevision: 1,
    });
    await service.handle({
      type: "harper:configure", dialect: "american", words: [],
      ruleOverrides: {}, configurationRevision: 2,
    });
    expect(worker.setLintConfig).toHaveBeenNthCalledWith(2, { LongSentences: null });

    worker.getLintConfig.mockResolvedValue({ SomeOtherRule: null });
    await expect(service.handle({
      type: "harper:configure", dialect: "american", words: [],
      ruleOverrides: { RemovedUpstreamRule: false }, configurationRevision: 3,
    })).resolves.toEqual({
      type: "harper:configured", dialect: "american", configurationRevision: 3,
    });
    expect(worker.setLintConfig).toHaveBeenCalledTimes(2);
  });

  it("loads Weirpacks before user words and rebuilds the linter when packs are removed", async () => {
    const first = makeWorker();
    const second = makeWorker();
    const createLinter = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const service = createHarperService({ createLinter });

    await expect(service.handle({
      type: "harper:configure",
      dialect: "american",
      words: ["Proofly"],
      ruleOverrides: { LongSentences: false },
      weirpacks: [{ id: "acme", bytes: [80, 75, 3, 4] }],
      configurationRevision: 1,
    })).resolves.toMatchObject({ type: "harper:configured", configurationRevision: 1 });
    expect(first.loadWeirpackFromBytes).toHaveBeenCalledWith([80, 75, 3, 4]);
    expect(first.importWords).toHaveBeenCalledWith(["Proofly"]);

    await expect(service.handle({
      type: "harper:configure",
      dialect: "american",
      words: ["Proofly"],
      ruleOverrides: { LongSentences: false },
      weirpacks: [],
      configurationRevision: 2,
    })).resolves.toMatchObject({ type: "harper:configured", configurationRevision: 2 });
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(second.loadWeirpackFromBytes).not.toHaveBeenCalled();
    expect(createLinter).toHaveBeenCalledTimes(2);
  });

  it("rejects a Weirpack whose embedded tests fail and discards partial linter state", async () => {
    const worker = makeWorker();
    worker.loadWeirpackFromBytes.mockResolvedValue([{ test: "failure" }]);
    const service = createHarperService({ createLinter: async () => worker });

    await expect(service.handle({
      type: "harper:configure",
      dialect: "american",
      words: [],
      ruleOverrides: {},
      weirpacks: [{ id: "broken", bytes: [1] }],
      configurationRevision: 1,
    })).resolves.toMatchObject({
      type: "harper:error",
      error: { code: "configure_failed", message: expect.stringContaining("failed its tests") },
    });
    expect(worker.dispose).toHaveBeenCalledOnce();
    expect(service.status()).toMatchObject({ state: "error", dialect: null });
  });

  it("returns plain corrections and frees every Harper lint", async () => {
    const worker = makeWorker();
    const rawLint = makeLint();
    worker.lint.mockResolvedValue([rawLint]);
    const service = createHarperService({ createLinter: async () => worker });
    await service.handle({
      type: "harper:configure", dialect: "american", words: [], ruleOverrides: {},
      configurationRevision: 0,
    });
    const result = await service.handle({
      type: "harper:lint", requestId: "panel:1", text: "bad", dialect: "american",
      configurationRevision: 0,
    });

    expect(result).toMatchObject({
      type: "harper:result", requestId: "panel:1",
      corrections: [{ startIndex: 0, endIndex: 3, correction: "good" }],
    });
    expect(worker.lint).toHaveBeenCalledWith("bad", { language: "plaintext" });
    expect(rawLint.free).toHaveBeenCalledOnce();
    expect(() => structuredClone(result)).not.toThrow();
  });

  it("skips queued stale requests and ignores a result superseded in flight", async () => {
    const worker = makeWorker();
    const first = deferred();
    worker.lint.mockImplementationOnce(() => first.promise).mockResolvedValueOnce([]);
    const service = createHarperService({ createLinter: async () => worker });
    await service.handle({
      type: "harper:configure", dialect: "american", words: [], ruleOverrides: {},
      configurationRevision: 0,
    });

    const one = service.handle({
      type: "harper:lint", requestId: 1, text: "one", dialect: "american", configurationRevision: 0,
    });
    await Promise.resolve();
    const two = service.handle({
      type: "harper:lint", requestId: 2, text: "two", dialect: "american", configurationRevision: 0,
    });
    first.resolve([makeLint()]);

    expect(await one).toEqual({ type: "harper:stale", requestId: 1 });
    expect(await two).toEqual({ type: "harper:result", requestId: 2, corrections: [] });
  });

  it("does not supersede concurrent editor scopes", async () => {
    const worker = makeWorker();
    const first = deferred();
    worker.lint.mockImplementationOnce(() => first.promise).mockResolvedValueOnce([]);
    const service = createHarperService({ createLinter: async () => worker });
    await service.handle({
      type: "harper:configure", dialect: "american", words: [], ruleOverrides: {},
      configurationRevision: 0,
    });

    const panel = service.handle({
      type: "harper:lint", scopeId: "sidepanel:note-1", requestId: 1,
      text: "bad", dialect: "american", configurationRevision: 0,
    });
    await Promise.resolve();
    const field = service.handle({
      type: "harper:lint", scopeId: "tab-4:frame-0:field-2", requestId: 2,
      text: "wierd", dialect: "american", configurationRevision: 0,
    });
    first.resolve([]);

    expect(await panel).toEqual({ type: "harper:result", requestId: 1, corrections: [] });
    expect(await field).toEqual({ type: "harper:result", requestId: 2, corrections: [] });
  });

  it("rejects stale complete-configuration/dialect requests without linting", async () => {
    const worker = makeWorker();
    const service = createHarperService({ createLinter: async () => worker });
    await service.handle({
      type: "harper:configure", dialect: "american", words: [], ruleOverrides: {},
      configurationRevision: 3,
    });
    const result = await service.handle({
      type: "harper:lint", requestId: 1, text: "bad", dialect: "british", configurationRevision: 2,
    });
    expect(result).toMatchObject({ type: "harper:error", error: { code: "stale_configuration" } });
    expect(worker.lint).not.toHaveBeenCalled();
  });

  it("returns serializable setup and lint failures and disposes cleanly", async () => {
    const setupWorker = makeWorker();
    setupWorker.setup.mockRejectedValue(new Error("WASM unavailable"));
    const failed = createHarperService({ createLinter: async () => setupWorker });
    expect(await failed.handle({
      type: "harper:configure", dialect: "american", words: [], ruleOverrides: {},
      configurationRevision: 0,
    })).toMatchObject({ type: "harper:error", error: { code: "configure_failed", message: "WASM unavailable" } });
    expect(failed.status().state).toBe("error");
    expect(setupWorker.dispose).toHaveBeenCalledOnce();

    const worker = makeWorker();
    worker.lint.mockRejectedValue(new Error("worker died"));
    const service = createHarperService({ createLinter: async () => worker });
    await service.handle({
      type: "harper:configure", dialect: "american", words: [], ruleOverrides: {},
      configurationRevision: 0,
    });
    expect(await service.handle({
      type: "harper:lint", requestId: "x", text: "bad", dialect: "american", configurationRevision: 0,
    })).toMatchObject({ type: "harper:error", error: { code: "lint_failed", message: "worker died" } });
    await service.dispose();
    expect(worker.dispose).toHaveBeenCalledOnce();
    expect(service.status().state).toBe("disposed");
  });
});
