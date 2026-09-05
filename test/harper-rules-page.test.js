import { afterEach, expect, it, vi } from "vitest";
import { initHarperRulesPage } from "../ui/harper-rules-page.js";

const rules = [
  { name: "AvoidCurses", label: "Avoid Curses", group: "Style", description: "Censor offensive language", defaultEnabled: false },
  { name: "SpellCheck", label: "Spell Check", group: "Spelling", description: "Check spelling", defaultEnabled: true },
  { name: "LongSentences", label: "Long Sentences", group: "Style", defaultEnabled: false, locked: true },
];
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
afterEach(() => { document.body.replaceChildren(); });

async function setup({ failSave = false, failLoad = false } = {}) {
  const els = {};
  for (const [name, tag] of Object.entries({ search: "input", customOnly: "input", list: "div", count: "p", reset: "button", status: "p", retry: "button" })) {
    els[name] = document.createElement(tag);
    document.body.append(els[name]);
  }
  let settings = { dialect: "british", ruleOverrides: { FutureRule: false } };
  const store = {
    loadProofingSettings: async () => settings,
    onProofingSettingsChanged: vi.fn(),
    saveProofingSettings: vi.fn(async (patch) => {
      if (failSave) throw new Error("quota");
      settings = { ...settings, ...patch };
      return settings;
    }),
  };
  const loadRules = vi.fn(async () => {
    if (failLoad && loadRules.mock.calls.length === 1) throw new Error("unavailable");
    return { type: "harper:rules", rules };
  });
  await initHarperRulesPage({ els, store, loadRules });
  return { els, store };
}

it("searches metadata, saves overrides, resets, and protects locked rules", async () => {
  const { els, store } = await setup();
  expect(els.list.querySelector('[data-rule="LongSentences"]').disabled).toBe(true);
  els.search.value = "offensive";
  els.search.dispatchEvent(new Event("input"));
  expect(els.list.querySelectorAll("select")).toHaveLength(1);
  const select = els.list.querySelector("select");
  expect(select.value).toBe("default");
  select.value = "on";
  select.dispatchEvent(new Event("change"));
  await settle();
  expect(store.saveProofingSettings).toHaveBeenLastCalledWith({ ruleOverrides: { FutureRule: false, AvoidCurses: true } });
  expect(els.status.textContent).toContain("Saved");
  els.reset.click();
  await settle();
  expect(store.saveProofingSettings).toHaveBeenLastCalledWith({ ruleOverrides: {} });
  expect(els.list.querySelector("select").value).toBe("default");
});

it("shows save failures and restores the saved selection", async () => {
  const { els } = await setup({ failSave: true });
  const select = els.list.querySelector("select");
  select.value = "on";
  select.dispatchEvent(new Event("change"));
  await settle();
  expect(els.status.textContent).toContain("Could not save");
  expect(els.list.querySelector("select").value).toBe("default");
});

it("retries a failed metadata load", async () => {
  const { els } = await setup({ failLoad: true });
  expect(els.retry.hidden).toBe(false);
  els.retry.click();
  await settle();
  expect(els.retry.hidden).toBe(true);
  expect(els.list.querySelectorAll("select")).toHaveLength(3);
});
