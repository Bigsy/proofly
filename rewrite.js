// rewrite.js — the Rewrite dropdown: tone/length presets + saved custom prompts.
//
// Rewriter API (flag-gated; same on-device Gemini Nano model as the Proofreader):
//   Rewriter.availability()                -> "unavailable"|"downloadable"|"downloading"|"available"
//   Rewriter.create({tone?|length?, signal}) -> Rewriter
//   rewriter.rewrite(text, {context?, signal}) -> rewritten string
//     (context carries free-form instructions — used by saved custom prompts)
//
// Everything is wired by initRewrite(deps), called once by the entry
// (sidepanel.js). Dependencies are injected to avoid an import cycle back
// into the entry:
//   els               — the entry's element map (dropdown, prompt form, editor)
//   supersede         — the SHARED supersede slot (lib/supersede.js): a new
//                       rewrite aborts an in-flight proofread and vice versa
//   replaceEditorText — undo-preserving editor write; owns the follow-up
//                       proofread (callers never run a proofread themselves)
//   cancelPendingProofread — clears the entry's debounced auto-proofread;
//                       runRewrite calls it so a just-typed edit's debounce
//                       can't fire mid-rewrite and supersede it
//   setStatus         — status line helper
//   showUndoToast     — undo affordance for big programmatic replacements
//   getInputLangs     — the parsed "expected input languages" options field
//
// Returns { refresh } — re-runs the availability gating. The Download button
// calls it: the Rewriter shares the on-device model, so a completed download
// may have just flipped its availability.

import { availabilityWithFallback } from "./lib/availability.js";

export function initRewrite({ els, supersede, replaceEditorText, setStatus, showUndoToast, getInputLangs, cancelPendingProofread }) {
  // Preset → Rewriter.create() options. Keys match the data-rewrite attributes
  // on the dropdown's preset buttons.
  const REWRITE_PRESETS = {
    "more-formal": { tone: "more-formal" },
    "more-casual": { tone: "more-casual" },
    shorter: { length: "shorter" },
    longer: { length: "longer" },
  };

  // Output language for availability() and create(): the first expected input
  // language. A rewrite shouldn't switch language, and Chrome logs a
  // quality/safety warning on any Rewriter request without one.
  function rewriteLangOpts() {
    const [lang] = getInputLangs();
    return lang ? { outputLanguage: lang } : {};
  }

  // Rewriter is flag-gated (chrome://flags → Rewriter API) and optional: the
  // dropdown stays hidden unless the API is present and at least downloadable —
  // no error states for a missing optional feature. Mirrors the Proofreader
  // gating, including the retry-bare fallback (lib/availability.js).
  //
  // "downloading" gets re-checked on a timer: nothing else re-runs this gate
  // when the download finishes (the Download button only shows for the
  // PROOFREADER's downloadable state), so without the retry a download in
  // progress at load would leave the dropdown hidden until the next page open.
  // The retry stops on every terminal state (available/unavailable/downloadable).
  const DOWNLOADING_RECHECK_MS = 5000;
  let recheckTimer = null;
  let lastAvailability = null;

  async function initRewriter() {
    clearTimeout(recheckTimer); // a manual refresh() must not stack timers
    if (!("Rewriter" in self)) return;
    let avail;
    try {
      avail = await availabilityWithFallback(Rewriter, rewriteLangOpts());
    } catch { return; /* treat as unavailable — stay hidden */ }
    lastAvailability = avail;
    if (avail === "available" || avail === "downloadable") {
      els.rewriteDrop.hidden = false;
      loadCustomPrompts(); // fire and forget — buttons appear when storage answers
    } else if (avail === "downloading") {
      recheckTimer = setTimeout(initRewriter, DOWNLOADING_RECHECK_MS);
    }
  }

  let rewriteBusy = false;  // mirrored by renderCustomPrompts for mid-flight re-renders
  let lastRewriteSeq = 0;   // supersede id of the newest rewrite — it owns the busy state
  function setRewriteBusy(busy) {
    rewriteBusy = busy;
    const sel = "[data-rewrite], [data-custom-prompt], [data-delete-prompt]";
    for (const b of els.rewriteDrop.querySelectorAll(sel)) {
      b.disabled = busy;
    }
  }

  // Rewrite the whole editor text. `spec.create` holds the Rewriter.create()
  // options (a preset's tone/length, or tone "as-is" for custom prompts) and
  // `spec.context` an optional free-form instruction passed to rewrite().
  // Shares the proofread's supersede slot, so a new rewrite, a
  // new proofread, or any editor edit aborts an in-flight one. Fresh instance
  // per call + destroy() after — untested whether Rewriter has the Proofreader
  // reuse bug, but fresh-per-call is the safe default and keeps one mental model.
  async function runRewrite(spec) {
    const text = els.editor.value;
    if (!spec?.create || !text.trim()) return;

    // A just-typed edit may have armed the 700 ms proofread debounce. Left
    // alone it fires mid-rewrite and supersedes us through the shared slot —
    // the rewrite dies silently (no error, no toast, text unchanged). Cancel
    // it: the text is about to be replaced wholesale, and replaceEditorText
    // runs its own immediate proofread afterwards.
    cancelPendingProofread();
    const req = supersede.begin();
    lastRewriteSeq = req.id;
    let rw = null;
    setRewriteBusy(true);
    try {
      setStatus("ok", "Rewriting…");
      const createOpts = { ...spec.create, ...rewriteLangOpts(), signal: req.signal };
      if (lastAvailability === "downloadable") {
        createOpts.monitor = (m) => {
          m.addEventListener("downloadprogress", (e) => {
            const pct = Math.round((e.loaded || 0) * 100);
            setStatus("ok", `Downloading rewrite model… ${pct}%`);
          });
        };
      }
      rw = await Rewriter.create(createOpts);
      lastAvailability = "available";
      const rewriteOpts = { signal: req.signal };
      if (spec.context) rewriteOpts.context = spec.context;
      const rewritten = await rw.rewrite(text, rewriteOpts);
      if (!req.isCurrent()) return; // a newer request superseded this one
      // No preview step — undo is the safety net. replaceEditorText
      // owns the follow-up proofread (immediate, debounce cancelled).
      replaceEditorText(rewritten);
      showUndoToast("Rewrote text");
    } catch (e) {
      if (e.name === "AbortError") return;
      if (req.isCurrent()) setStatus("error", `Rewrite failed: ${e.message || e}`);
    } finally {
      req.release();
      try { rw?.destroy?.(); } catch { /* ignore */ }
      // Only the newest rewrite may clear the busy state — a superseded one
      // settling late must not re-enable the buttons under it. Neither shared
      // guard works here: the shared seq is bumped by the success path itself
      // (replaceEditorText fires `input`) and the slot's controller is taken
      // over when a *proofread* supersedes the rewrite — both would strand the
      // buttons disabled. Hence the rewrite-only sequence.
      if (req.id === lastRewriteSeq) setRewriteBusy(false);
    }
  }

  // ---------- saved custom rewrite prompts ----------
  // Free-form rewrite instructions the user saves (e.g. "more diplomatic",
  // "as a haiku"), rendered as buttons in the same row as the presets. Each
  // runs as Rewriter.create({tone:"as-is"}) + rewrite(text, {context:
  // instruction}) — context carries arbitrary instructions (verified live).
  // Stored in chrome.storage.sync: small strings, syncs across the user's
  // Chromes. Duplicate names overwrite — that's also how you edit a prompt.
  const PROMPTS_KEY = "customPrompts";
  let customPrompts = []; // in-memory mirror of storage; drives the buttons

  const promptStore = () => globalThis.chrome?.storage?.sync ?? null;

  // A usable entry needs a non-empty name + instruction; anything else
  // (malformed/truncated by sync) is skipped rather than breaking the dropdown.
  function validPrompt(p) {
    return !!p && typeof p === "object"
      && typeof p.name === "string" && !!p.name.trim()
      && typeof p.instruction === "string" && !!p.instruction.trim();
  }

  async function loadCustomPrompts() {
    const store = promptStore();
    if (!store) return; // no storage API — leave the list empty
    try {
      const data = await store.get(PROMPTS_KEY);
      const list = data?.[PROMPTS_KEY];
      customPrompts = Array.isArray(list) ? list.filter(validPrompt) : [];
    } catch {
      customPrompts = [];
    }
    renderCustomPrompts();
  }

  async function persistCustomPrompts() {
    try {
      await promptStore()?.set({ [PROMPTS_KEY]: customPrompts });
    } catch { /* sync hiccup — the in-memory list still drives this session */ }
  }

  function renderCustomPrompts() {
    const wrap = els.customPromptList;
    wrap.textContent = "";
    customPrompts.forEach((p, i) => {
      const group = document.createElement("span");
      group.className = "custom-prompt";

      const run = document.createElement("button");
      run.className = "btn btn--sm custom-prompt__run";
      run.dataset.customPrompt = String(i);
      run.textContent = p.name;
      run.title = p.instruction; // the button truncates — hover for the full text

      const del = document.createElement("button");
      del.className = "btn btn--sm custom-prompt__delete";
      del.dataset.deletePrompt = String(i);
      del.textContent = "×";
      del.title = `Delete “${p.name}”`;
      del.setAttribute("aria-label", `Delete “${p.name}”`);

      // A save/delete can re-render mid-rewrite — keep the busy state.
      run.disabled = del.disabled = rewriteBusy;
      group.append(run, del);
      wrap.appendChild(group);
    });
  }

  function showPromptForm() {
    els.promptForm.hidden = false;
    els.newPromptBtn.hidden = true; // the form replaces the button until closed
    els.promptError.hidden = true;
    els.promptName.focus();
  }

  function hidePromptForm() {
    els.promptForm.hidden = true;
    els.newPromptBtn.hidden = false;
    els.promptName.value = "";
    els.promptInstruction.value = "";
    els.promptError.hidden = true;
  }

  function promptFormError(msg) {
    els.promptError.textContent = msg;
    els.promptError.hidden = false;
  }

  // Trim both fields (edge whitespace only — multi-line instructions keep
  // their inner newlines) and reject empties with inline feedback, so a
  // whitespace-only save can't create a phantom dropdown entry.
  async function savePromptForm() {
    const name = els.promptName.value.trim();
    const instruction = els.promptInstruction.value.trim();
    if (!name) return promptFormError("Give the prompt a name.");
    if (!instruction) return promptFormError("Write the rewrite instruction.");

    const existing = customPrompts.findIndex((p) => p.name === name);
    if (existing >= 0) customPrompts[existing] = { name, instruction };
    else customPrompts.push({ name, instruction });

    renderCustomPrompts();
    hidePromptForm();
    await persistCustomPrompts();
  }

  async function deleteCustomPrompt(i) {
    if (!customPrompts[i]) return;
    customPrompts.splice(i, 1);
    renderCustomPrompts();
    await persistCustomPrompts();
  }

  // ---------- wiring ----------
  // Pick a rewrite preset or saved custom prompt → rewrite the whole text.
  // Collapse the dropdown so the result is visible in the editor, not hidden
  // behind the open panel. Delete buttons (×) live in the same panel.
  els.rewriteDrop.addEventListener("click", (e) => {
    const preset = e.target.closest("[data-rewrite]");
    if (preset && !preset.disabled) {
      els.rewriteDrop.open = false;
      runRewrite({ create: REWRITE_PRESETS[preset.dataset.rewrite] });
      return;
    }
    const custom = e.target.closest("[data-custom-prompt]");
    if (custom && !custom.disabled) {
      const p = customPrompts[Number(custom.dataset.customPrompt)];
      if (!p) return;
      els.rewriteDrop.open = false;
      runRewrite({ create: { tone: "as-is" }, context: p.instruction });
      return;
    }
    const del = e.target.closest("[data-delete-prompt]");
    if (del && !del.disabled) deleteCustomPrompt(Number(del.dataset.deletePrompt));
  });

  els.newPromptBtn.addEventListener("click", showPromptForm);
  els.promptSave.addEventListener("click", savePromptForm);
  els.promptCancel.addEventListener("click", hidePromptForm);

  initRewriter(); // fire and forget — gates the dropdown when availability answers
  return { refresh: initRewriter };
}
