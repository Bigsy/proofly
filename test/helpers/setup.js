// Shared per-test teardown: settle pending controlled promises, run the
// mock tripwires (instance reuse / leaks — see mock-proofreader.js and
// mock-rewriter.js), then clean the environment for the next test.

import { afterEach, vi } from "vitest";
import * as proofreader from "./mock-proofreader.js";
import * as rewriter from "./mock-rewriter.js";

afterEach(async () => {
  const mocks = [...proofreader.activeMocks(), ...rewriter.activeMocks()];
  try {
    for (const mock of mocks) await mock.settleAll();
    for (const mock of mocks) mock.assertTripwires();
  } finally {
    proofreader.resetMocks();
    rewriter.resetMocks();
    vi.clearAllTimers();
    vi.useRealTimers();
    delete globalThis.Proofreader;
    delete globalThis.Rewriter;
    delete globalThis.chrome; // the storage stub page.js installs
  }
});
