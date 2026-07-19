// MockProofreader — a scripted stand-in for Chrome's `Proofreader` global.
//
// Principle: test our logic, not the model. proofread() returns
// fixtures recorded from the real Beta build; the mock keeps a ledger of every
// availability/create/proofread/destroy so tests can assert lifecycle, and two
// tripwires (checked in a shared afterEach — see setup.js) lock down the
// suite's invariants:
//
//   1. No instance reuse — a 2nd proofread() on one instance fails the test.
//      (Zero proofreads is fine: the Download button creates an instance
//      purely to trigger the download and destroys it unused.)
//   2. No leaks — every created instance must be destroy()ed by test end.
//      runProofread() only destroys in its `finally`, so tests using
//      controlled (never-resolving) promises must settle them first;
//      settleAll() is called automatically in the shared afterEach.

// Mocks created during the current test, so setup.js can run the tripwires
// without each test file wiring its own afterEach.
const registry = [];

export function activeMocks() {
  return registry.slice();
}

export function resetMocks() {
  registry.length = 0;
}

// Default proofread result when the scripted queue is empty: a clean pass.
const cleanResult = (text) => ({ correctedInput: text, corrections: [] });

// `availability` option:
//   - string: every call returns it
//   - array:  a sequence; the last value repeats
//   - function(opts): full control — may throw (the app retries without opts)
// `results` option: initial proofread() queue; each entry is a fixture object,
// a function(text) -> fixture, or a controlled token (see enqueueControlled).
export function createMockProofreader({ availability = "available", results = [] } = {}) {
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
      this.proofreadCalls = []; // the text arg of each proofread() call
      this.destroyed = false;
    }

    proofread(text, opts) {
      this.proofreadCalls.push(text);
      const next = queue.length ? queue.shift() : cleanResult;
      const result = next && next.__controlled
        ? next.promise
        : Promise.resolve(
          typeof next === "function" ? next(text) : structuredClone(next),
        );
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

  const Proofreader = {
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
      // The app always passes a monitor; give it an inert event target.
      options?.monitor?.({ addEventListener: () => {} });
      return inst;
    },
  };

  const handle = {
    Proofreader,
    ledger,

    enqueue(...fixtures) {
      queue.push(...fixtures);
    },

    // A proofread() result the test resolves by hand — for sequencing tests
    // where request A must still be in flight when request B lands.
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

    // Resolve any still-pending controlled promises so runProofread's
    // `finally` destroy runs before the leak tripwire looks.
    async settleAll() {
      for (const t of controlled) if (!t.settled) t.resolve(cleanResult(""));
      for (let i = 0; i < 25; i++) await Promise.resolve();
    },

    assertTripwires() {
      ledger.instances.forEach((inst, i) => {
        if (inst.proofreadCalls.length > 1) {
          throw new Error(
            `Tripwire: Proofreader instance #${i} got ${inst.proofreadCalls.length} proofread() calls — ` +
              "instances must be fresh per call (reuse corrupts output on real builds — see README, Notes & caveats).",
          );
        }
        if (!inst.destroyed) {
          throw new Error(
            `Tripwire: Proofreader instance #${i} was never destroy()ed — leaked instance.`,
          );
        }
      });
    },
  };

  registry.push(handle);
  return handle;
}
