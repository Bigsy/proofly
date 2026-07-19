// MockRewriter — a scripted stand-in for Chrome's flag-gated `Rewriter`
// global, mirroring mock-proofreader.js (see its header for the principle:
// test our logic, not the model). rewrite() resolves scripted strings; the
// ledger records every availability/create/rewrite/destroy, and the same two
// tripwires apply (checked in the shared afterEach — see setup.js):
//
//   1. No instance reuse — a 2nd rewrite() on one instance fails the test
//      (untested whether the real Rewriter has the Proofreader reuse bug,
//      but the app promises fresh-per-call; hold it to that).
//   2. No leaks — every created instance must be destroy()ed by test end.

const registry = [];

export function activeMocks() {
  return registry.slice();
}

export function resetMocks() {
  registry.length = 0;
}

// Default rewrite result when the scripted queue is empty: a marked echo, so
// assertions can tell a rewrite happened without scripting every test.
const defaultResult = (text) => `[rewritten] ${text}`;

// `availability` option: string | array (sequence, last repeats) | fn(opts).
// `results` option: initial rewrite() queue; each entry is a string, a
// function(text) -> string, or a controlled token (see enqueueControlled).
export function createMockRewriter({ availability = "available", results = [] } = {}) {
  const ledger = {
    availabilityCalls: [], // the options arg of each availability() call
    instances: [],         // every MockInstance, in creation order
  };
  const queue = [...results];
  const controlled = [];

  let availFn;
  if (typeof availability === "function") {
    availFn = availability;
  } else if (Array.isArray(availability)) {
    let i = 0;
    availFn = () => availability[Math.min(i++, availability.length - 1)];
  } else {
    availFn = () => availability;
  }

  class MockInstance {
    constructor(options) {
      this.options = options;
      this.rewriteCalls = []; // the text arg of each rewrite() call
      this.rewriteOpts = [];  // the options arg of each rewrite() call
      this.destroyed = false;
    }

    rewrite(text, opts) {
      this.rewriteCalls.push(text);
      this.rewriteOpts.push(opts);
      const next = queue.length ? queue.shift() : defaultResult;
      const result = next && next.__controlled
        ? next.promise
        : Promise.resolve(typeof next === "function" ? next(text) : next);
      // Honour AbortSignal like the real API: reject with AbortError on
      // abort, even if the scripted result would (or already did) resolve.
      const signal = opts?.signal;
      if (!signal) return result;
      if (signal.aborted) {
        return Promise.reject(new DOMException("Aborted", "AbortError"));
      }
      return new Promise((resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
        result.then(resolve, reject);
      });
    }

    destroy() {
      this.destroyed = true;
    }
  }

  const Rewriter = {
    async availability(opts) {
      ledger.availabilityCalls.push(opts);
      return availFn(opts); // a throw here rejects, like the real API
    },
    async create(options) {
      if (options?.signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      const inst = new MockInstance(options);
      ledger.instances.push(inst);
      return inst;
    },
  };

  const handle = {
    Rewriter,
    ledger,

    enqueue(...entries) {
      queue.push(...entries);
    },

    // A rewrite() result the test resolves by hand — for in-flight
    // abort/supersede tests.
    enqueueControlled() {
      let resolve, reject;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const token = {
        __controlled: true,
        promise,
        settled: false,
        resolve(value) {
          this.settled = true;
          resolve(value);
        },
        reject(err) {
          this.settled = true;
          reject(err);
        },
      };
      controlled.push(token);
      queue.push(token);
      return token;
    },

    // Resolve any still-pending controlled promises so runRewrite's
    // `finally` destroy runs before the leak tripwire looks.
    async settleAll() {
      for (const t of controlled) if (!t.settled) t.resolve("[settled]");
      for (let i = 0; i < 25; i++) await Promise.resolve();
    },

    assertTripwires() {
      ledger.instances.forEach((inst, i) => {
        if (inst.rewriteCalls.length > 1) {
          throw new Error(
            `Tripwire: Rewriter instance #${i} got ${inst.rewriteCalls.length} rewrite() calls — ` +
              "instances must be fresh per call (see runRewrite in sidepanel.js).",
          );
        }
        if (!inst.destroyed) {
          throw new Error(
            `Tripwire: Rewriter instance #${i} was never destroy()ed — leaked instance.`,
          );
        }
      });
    },
  };

  registry.push(handle);
  return handle;
}
