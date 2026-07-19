// ui/dictionary-page.js with stub deps — the options page's behaviour without
// chrome or the wiring entry: render/sort, search, bulk paste dedupe + report,
// remove, the two-step Clear all, quota errors, and live re-render on external
// change. The real options.html markup is the
// DOM (same ?raw trick as helpers/page.js), so element ids/classes can't
// drift from what options.js wires.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { initDictionaryPage } from "../ui/dictionary-page.js";
import optionsSource from "../options/options.html?raw";

const innerHtml = optionsSource
  .replace(/<script type="module" src="options\.js"><\/script>/, "")
  .match(/<html[^>]*>([\s\S]*)<\/html>/)[1];

const $ = (id) => document.getElementById(id);

// In-memory stand-in for lib/dictionary-store.js with the same contract:
// sorted/deduped lists back from every write, ONE "set" recorded per bulk op,
// and a change-callback hook tests fire to simulate another context writing.
function makeStubStore(initial = []) {
  const sort = (list) => [...new Set(list)].sort((a, b) => a.localeCompare(b));
  let list = sort(initial);
  let failNextWrite = null;
  const changeCallbacks = [];
  const writes = [];

  const write = async (next) => {
    if (failNextWrite) {
      const e = failNextWrite;
      failNextWrite = null;
      throw e;
    }
    list = next;
    writes.push([...next]);
    return list;
  };

  return {
    loadDictionary: vi.fn(async () => [...list]),
    addWords: vi.fn(async (words) => write(sort([...list, ...words]))),
    removeWord: vi.fn(async (word) => write(list.filter((w) => w !== word))),
    clearDictionary: vi.fn(async () => write([])),
    onDictionaryChanged: vi.fn((cb) => {
      changeCallbacks.push(cb);
      return () => {};
    }),
    // test seams
    writes,
    failWith(err) { failNextWrite = err; },
    fireChange(next) {
      list = sort(next);
      for (const cb of changeCallbacks) cb([...list]);
    },
  };
}

async function loadDictionaryPage(initial = []) {
  document.documentElement.innerHTML = innerHtml;
  const store = makeStubStore(initial);
  const page = initDictionaryPage({
    els: {
      search: $("dictSearch"),
      bulkInput: $("bulkInput"),
      bulkBtn: $("bulkBtn"),
      bulkReport: $("bulkReport"),
      list: $("wordList"),
      empty: $("dictEmpty"),
      meter: $("quotaMeter"),
      clearBtn: $("clearBtn"),
    },
    store,
  });
  await page.ready;
  return store;
}

const listedWords = () =>
  [...$("wordList").querySelectorAll(".word__text")].map((el) => el.textContent);

const settle = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };

beforeEach(() => {
  document.documentElement.innerHTML = "";
});

describe("rendering", () => {
  it("renders the loaded list sorted, with the meter and an enabled Clear all", async () => {
    await loadDictionaryPage(["zebra", "Acme", "alpha"]);
    expect(listedWords()).toEqual(["Acme", "alpha", "zebra"]);
    expect($("dictEmpty").hidden).toBe(true);
    expect($("quotaMeter").textContent).toMatch(/^3 words · ~0\.\d KB of 8 KB sync quota$/);
    expect($("clearBtn").disabled).toBe(false);
  });

  it("renders the empty state with Clear all disabled", async () => {
    await loadDictionaryPage([]);
    expect(listedWords()).toEqual([]);
    expect($("dictEmpty").hidden).toBe(false);
    expect($("dictEmpty").textContent).toMatch(/No words yet/);
    expect($("quotaMeter").textContent).toMatch(/^0 words/);
    expect($("clearBtn").disabled).toBe(true);
  });
});

describe("search", () => {
  it("filters the list client-side, case-insensitively", async () => {
    await loadDictionaryPage(["Acme", "doxx", "Gemini"]);
    $("dictSearch").value = "ac";
    $("dictSearch").dispatchEvent(new Event("input", { bubbles: true }));
    expect(listedWords()).toEqual(["Acme"]);

    $("dictSearch").value = "nothing-matches";
    $("dictSearch").dispatchEvent(new Event("input", { bubbles: true }));
    expect(listedWords()).toEqual([]);
    expect($("dictEmpty").textContent).toBe("No words match your search.");
  });
});

describe("bulk add", () => {
  async function paste(value) {
    $("bulkInput").value = value;
    $("bulkBtn").click();
    await settle();
  }

  it("splits on any whitespace, dedupes against existing AND within the paste — one write", async () => {
    const store = await loadDictionaryPage(["existing"]);
    await paste("alpha beta\nexisting\n  beta \t gamma\n" + "x".repeat(65));
    // alpha, beta, gamma added; "existing", the repeat beta, the long token skipped.
    expect(store.addWords).toHaveBeenCalledTimes(1);
    expect(store.addWords).toHaveBeenCalledWith(["alpha", "beta", "gamma"]);
    expect(store.writes).toHaveLength(1);
    expect($("bulkReport").textContent)
      .toBe("Added 3, skipped 3 (already present or invalid).");
    expect(listedWords()).toEqual(["alpha", "beta", "existing", "gamma"]);
    expect($("bulkInput").value).toBe("");
  });

  it("reports a clean add without the skip clause", async () => {
    await loadDictionaryPage([]);
    await paste("one two");
    expect($("bulkReport").textContent).toBe("Added 2.");
  });

  it("adds a single word through the same Add all flow", async () => {
    const store = await loadDictionaryPage(["beta"]);
    await paste("  Alpha  ");
    expect(store.addWords).toHaveBeenCalledWith(["Alpha"]);
    expect(listedWords()).toEqual(["Alpha", "beta"]);
    expect($("bulkInput").value).toBe("");
    expect($("bulkReport").textContent).toBe("Added 1.");
  });

  it("all-skipped pastes don't write at all", async () => {
    const store = await loadDictionaryPage(["a", "b"]);
    await paste("a b");
    expect(store.addWords).not.toHaveBeenCalled();
    expect($("bulkReport").textContent).toBe("Added 0, skipped 2 (already present or invalid).");
  });

  it("an empty paste asks for input", async () => {
    await loadDictionaryPage([]);
    await paste("   \n  ");
    expect($("bulkReport").textContent).toBe("Paste some words first.");
  });

  it("surfaces a quota rejection naming the limit", async () => {
    const store = await loadDictionaryPage([]);
    store.failWith(new Error("QUOTA_BYTES_PER_ITEM exceeded"));
    await paste("alpha beta");
    expect($("bulkReport").textContent).toMatch(/sync storage limit/);
    expect($("bulkReport").classList.contains("error")).toBe(true);
  });
});

describe("remove and Clear all", () => {
  it("a chip's × removes that word (one write)", async () => {
    const store = await loadDictionaryPage(["alpha", "beta"]);
    $("wordList").querySelector('.word__remove[aria-label*="alpha"]').click();
    await settle();
    expect(store.removeWord).toHaveBeenCalledWith("alpha");
    expect(listedWords()).toEqual(["beta"]);
  });

  it("Clear all takes two clicks: arm, then clear", async () => {
    const store = await loadDictionaryPage(["alpha", "beta"]);
    $("clearBtn").click();
    await settle();
    expect($("clearBtn").textContent).toBe("Confirm clear all");
    expect(store.clearDictionary).not.toHaveBeenCalled();
    expect(listedWords()).toEqual(["alpha", "beta"]); // still intact

    $("clearBtn").click();
    await settle();
    expect(store.clearDictionary).toHaveBeenCalledTimes(1);
    expect(listedWords()).toEqual([]);
    expect($("clearBtn").textContent).toBe("Clear all"); // disarmed again
    expect($("clearBtn").disabled).toBe(true);
  });

  it("any re-render disarms a pending Clear all", async () => {
    await loadDictionaryPage(["alpha"]);
    $("clearBtn").click();
    expect($("clearBtn").textContent).toBe("Confirm clear all");

    $("dictSearch").value = "a";
    $("dictSearch").dispatchEvent(new Event("input", { bubbles: true }));
    expect($("clearBtn").textContent).toBe("Clear all");
  });
});

describe("live updates", () => {
  it("re-renders when the dictionary changes in another context", async () => {
    const store = await loadDictionaryPage(["alpha"]);
    store.fireChange(["alpha", "Acme", "zeta"]);
    expect(listedWords()).toEqual(["Acme", "alpha", "zeta"]);
    expect($("quotaMeter").textContent).toMatch(/^3 words/);
  });
});
