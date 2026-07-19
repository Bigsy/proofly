// P3 — saved custom rewrite prompts: loading/validating
// from chrome.storage.sync, the create/{context} plumbing (tone "as-is" +
// rewrite(text, {context: instruction})), form CRUD with inline validation
// (duplicate names overwrite — that's also the edit mechanism), and the
// shared busy/replace/toast behaviour with the presets.

import { describe, expect, it } from "vitest";
import { createMockProofreader } from "./helpers/mock-proofreader.js";
import { createMockRewriter } from "./helpers/mock-rewriter.js";
import { $, loadPage, settle, tick } from "./helpers/page.js";

const TEXT = "We need to talk about the thing.";
const PROMPTS = [
  { name: "Diplomatic", instruction: "Rewrite this more diplomatically." },
  { name: "Haiku", instruction: "Rewrite as a haiku." },
];

const sync = () => globalThis.chrome.storage.sync;
const customBtns = () => [...$("customPromptList").querySelectorAll("[data-custom-prompt]")];
const deleteBtns = () => [...$("customPromptList").querySelectorAll("[data-delete-prompt]")];
const presetBtns = () => [...$("rewriteDrop").querySelectorAll("[data-rewrite]")];
const customBtn = (name) => customBtns().find((b) => b.textContent === name);

async function storedPrompts() {
  const data = await sync().get("customPrompts");
  return data.customPrompts;
}

// Open the inline form, fill it, save. Values are set directly (jsdom);
// trimming/validation is the app's job.
async function savePrompt(name, instruction) {
  if ($("promptForm").hidden) $("newPromptBtn").click();
  $("promptName").value = name;
  $("promptInstruction").value = instruction;
  $("promptSave").click();
  await settle();
}

describe("loading saved prompts from chrome.storage.sync", () => {
  it("renders one button per stored prompt, in storage order", async () => {
    await loadPage({
      text: TEXT,
      mock: createMockProofreader(),
      rewriter: createMockRewriter(),
      storage: { customPrompts: PROMPTS },
    });
    expect(customBtns().map((b) => b.textContent)).toEqual(["Diplomatic", "Haiku"]);
    // Hover reveals the full instruction (the button itself truncates).
    expect(customBtn("Haiku").title).toBe("Rewrite as a haiku.");
    expect(deleteBtns()).toHaveLength(2);
  });

  it("renders the no-customs layout when storage is empty", async () => {
    await loadPage({ text: TEXT, mock: createMockProofreader(), rewriter: createMockRewriter() });
    expect(customBtns()).toHaveLength(0);
    expect($("newPromptBtn").hidden).toBe(false);
    expect($("promptForm").hidden).toBe(true);
  });

  it("skips malformed stored values without breaking the dropdown", async () => {
    await loadPage({
      text: TEXT,
      mock: createMockProofreader(),
      rewriter: createMockRewriter(),
      storage: {
        customPrompts: [
          "garbage",
          null,
          42,
          { name: "   ", instruction: "whitespace name" },
          { name: "No instruction" },
          { name: "Valid", instruction: "Keep me." },
          { instruction: "no name" },
        ],
      },
    });
    expect(customBtns().map((b) => b.textContent)).toEqual(["Valid"]);
  });

  it("does not touch storage while the dropdown is hidden (Rewriter unavailable)", async () => {
    const rewriter = createMockRewriter({ availability: "unavailable" });
    await loadPage({
      text: TEXT,
      mock: createMockProofreader(),
      rewriter,
      storage: { customPrompts: PROMPTS },
    });
    expect($("rewriteDrop").hidden).toBe(true);
    // init() always reads the custom dictionary; the PROMPTS read is what the
    // availability gate must withhold.
    expect(sync().get).not.toHaveBeenCalledWith("customPrompts");
  });
});

describe("running a custom prompt", () => {
  it("creates with tone 'as-is' and passes the instruction as rewrite context", async () => {
    const rewriter = createMockRewriter();
    await loadPage({
      text: TEXT,
      mock: createMockProofreader(),
      rewriter,
      storage: { customPrompts: PROMPTS },
    });

    customBtn("Haiku").click();
    await settle();

    const [inst] = rewriter.ledger.instances;
    expect(inst.options.tone).toBe("as-is");
    // Exactly the tone + signal + output language — no stray options.
    expect(Object.keys(inst.options).sort())
      .toEqual(["outputLanguage", "signal", "tone"]);
    expect(inst.options.outputLanguage).toBe("en"); // from the inputLangs field
    expect(inst.rewriteCalls).toEqual([TEXT]);
    expect(inst.rewriteOpts[0].context).toBe("Rewrite as a haiku.");
    expect(Object.keys(inst.rewriteOpts[0]).sort()).toEqual(["context", "signal"]);
  });

  it("replaces via the undo-preserving write, shows the toast, undo restores", async () => {
    const rewriter = createMockRewriter({ results: ["Cherry blossoms fall."] });
    await loadPage({
      text: TEXT,
      mock: createMockProofreader(),
      rewriter,
      storage: { customPrompts: PROMPTS },
    });
    $("rewriteDrop").open = true;

    customBtn("Haiku").click();
    await settle();

    expect($("editor").value).toBe("Cherry blossoms fall.");
    expect($("rewriteDrop").open).toBe(false); // collapsed so the result is visible
    expect($("toast").hidden).toBe(false);
    expect($("toastText").textContent).toBe("Rewrote text");

    $("toastUndo").click();
    expect($("editor").value).toBe(TEXT);
    await tick(700); // let the undo's debounced re-proofread land
  });

  it("disables presets, customs and deletes while in flight — including mid-flight re-renders", async () => {
    const rewriter = createMockRewriter();
    await loadPage({
      text: TEXT,
      mock: createMockProofreader(),
      rewriter,
      storage: { customPrompts: PROMPTS },
    });

    const token = rewriter.enqueueControlled();
    customBtn("Diplomatic").click();
    await settle();
    const all = () => [...presetBtns(), ...customBtns(), ...deleteBtns()];
    expect(all().every((b) => b.disabled)).toBe(true);

    // Saving a prompt mid-rewrite re-renders the custom buttons — the fresh
    // ones must come back disabled, not clickable.
    await savePrompt("Mid-flight", "Saved during a rewrite.");
    expect(customBtn("Mid-flight").disabled).toBe(true);

    token.resolve("Done.");
    await settle();
    expect(all().every((b) => !b.disabled)).toBe(true);
  });
});

describe("creating prompts (inline form)", () => {
  it("New custom prompt… swaps to the form; saving renders the button and persists", async () => {
    await loadPage({ text: TEXT, mock: createMockProofreader(), rewriter: createMockRewriter() });

    $("newPromptBtn").click();
    expect($("promptForm").hidden).toBe(false);
    expect($("newPromptBtn").hidden).toBe(true);

    await savePrompt("Pirate", "Rewrite like a pirate.");
    expect(customBtns().map((b) => b.textContent)).toEqual(["Pirate"]);
    expect($("promptForm").hidden).toBe(true);
    expect($("newPromptBtn").hidden).toBe(false);
    expect(await storedPrompts()).toEqual([
      { name: "Pirate", instruction: "Rewrite like a pirate." },
    ]);

    // The form cleared — reopening starts blank.
    $("newPromptBtn").click();
    expect($("promptName").value).toBe("");
    expect($("promptInstruction").value).toBe("");
  });

  it.each([
    ["whitespace-only name", "   ", "Do the thing.", "Give the prompt a name."],
    ["whitespace-only instruction", "Name", "  \n  ", "Write the rewrite instruction."],
  ])("rejects a %s with inline feedback — no phantom entry, no write", async (_label, name, instruction, message) => {
    await loadPage({ text: TEXT, mock: createMockProofreader(), rewriter: createMockRewriter() });

    await savePrompt(name, instruction);
    expect($("promptError").hidden).toBe(false);
    expect($("promptError").textContent).toBe(message);
    expect($("promptForm").hidden).toBe(false); // stays open for the fix-up
    expect(customBtns()).toHaveLength(0);
    expect(sync().set).not.toHaveBeenCalled();
  });

  it("a duplicate name overwrites the saved prompt (that's how you edit one)", async () => {
    await loadPage({
      text: TEXT,
      mock: createMockProofreader(),
      rewriter: createMockRewriter(),
      storage: { customPrompts: [{ name: "Diplomatic", instruction: "old wording" }] },
    });

    await savePrompt("Diplomatic", "new wording");
    expect(customBtns().map((b) => b.textContent)).toEqual(["Diplomatic"]);
    expect(await storedPrompts()).toEqual([
      { name: "Diplomatic", instruction: "new wording" },
    ]);
  });

  it("trims edge whitespace but keeps inner newlines; unicode round-trips through storage", async () => {
    await loadPage({ text: TEXT, mock: createMockProofreader(), rewriter: createMockRewriter() });

    await savePrompt("  俳句 🌸  ", "  Line one.\nLine two ✨  ");
    const stored = await storedPrompts();
    expect(stored).toEqual([
      { name: "俳句 🌸", instruction: "Line one.\nLine two ✨" },
    ]);

    // Reload the page against what was persisted — the prompt comes back and
    // its full multi-line instruction reaches the rewrite as context.
    const rewriter = createMockRewriter();
    await loadPage({
      text: TEXT,
      mock: createMockProofreader(),
      rewriter,
      storage: { customPrompts: stored },
    });
    customBtn("俳句 🌸").click();
    await settle();
    expect(rewriter.ledger.instances[0].rewriteOpts[0].context)
      .toBe("Line one.\nLine two ✨");
  });

  it("cancel closes and clears the form without writing", async () => {
    await loadPage({ text: TEXT, mock: createMockProofreader(), rewriter: createMockRewriter() });

    await savePrompt("   ", "half-typed"); // leaves an inline error showing
    expect($("promptError").hidden).toBe(false);

    $("promptCancel").click();
    expect($("promptForm").hidden).toBe(true);
    expect($("newPromptBtn").hidden).toBe(false);
    expect(sync().set).not.toHaveBeenCalled();

    $("newPromptBtn").click(); // reopening starts blank, error gone
    expect($("promptName").value).toBe("");
    expect($("promptInstruction").value).toBe("");
    expect($("promptError").hidden).toBe(true);
  });
});

describe("deleting prompts", () => {
  it("removes the prompt from storage AND the open dropdown", async () => {
    await loadPage({
      text: TEXT,
      mock: createMockProofreader(),
      rewriter: createMockRewriter(),
      storage: { customPrompts: PROMPTS },
    });
    $("rewriteDrop").open = true;

    deleteBtns()[0].click(); // × next to "Diplomatic"
    await settle();

    expect(customBtns().map((b) => b.textContent)).toEqual(["Haiku"]);
    expect($("rewriteDrop").open).toBe(true); // deleting doesn't collapse the panel
    expect(await storedPrompts()).toEqual([
      { name: "Haiku", instruction: "Rewrite as a haiku." },
    ]);
  });

  it("deleting the last prompt restores the no-customs layout", async () => {
    await loadPage({
      text: TEXT,
      mock: createMockProofreader(),
      rewriter: createMockRewriter(),
      storage: { customPrompts: [PROMPTS[0]] },
    });

    deleteBtns()[0].click();
    await settle();

    expect(customBtns()).toHaveLength(0);
    expect($("customPromptList").childNodes).toHaveLength(0);
    expect($("newPromptBtn").hidden).toBe(false);
    expect(await storedPrompts()).toEqual([]);
  });
});
