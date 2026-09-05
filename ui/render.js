// ui/render.js — DOM building for proofread results: the backdrop squiggles,
// the correction cards, and the suggestion popup.
//
// Wired by initRender(deps), called once by the entry (sidepanel.js):
//   els        — the entry's element map (highlights, correctionsList, popup, …)
//   onApply(i) — apply correction i to the editor (the entry's applyCorrection,
//                injected to avoid an import cycle back into the entry)
//   onAddToDictionary(i) — suppress correction i's word via the custom
//                dictionary (optional, same injection rationale)
//   getCandidate(c) — the dictionary candidate word for a correction, or null
//                when it isn't suppressible (optional; the entry binds
//                lib/dictionary.js's eligibility to the current text, so this
//                module stays dictionary-dumb)
//   syncScroll — keeps the backdrop aligned with the editor's scroll position
//
// The result state (current text/corrections/corrected) stays in the entry —
// renderResult there is the seam between proofreading and rendering — so
// every function here takes the text + corrections it should draw.

import { usableSpans } from "../lib/corrections.js";
import { harperKindMetadata } from "../lib/harper-types.js";
import { buildCorrectionCard } from "./correction-card.js";
import { ICON_PATHS, svgIcon } from "./icons.js";

export function initRender({
  els, onApply, onDisableRule, onAddToDictionary, onSelectSuggestion, onDismiss, getCandidate, syncScroll,
}) {
  // Draw the wavy underlines: a transparent mirror of the text with the
  // erroneous spans wrapped in <span class="squiggle">, sitting behind the textarea.
  function renderBackdrop(text, corrections) {
    const wrap = els.highlights;
    wrap.textContent = "";

    let cursor = 0;
    for (const c of usableSpans(text, corrections)) {
      if (c.start > cursor) wrap.appendChild(document.createTextNode(text.slice(cursor, c.start)));
      const span = document.createElement("span");
      // Colour the squiggle by correction type (matching the list-chip badge
      // colours); untyped corrections use the shared neutral fallback.
      const types = corrections[c.i]?.types;
      const primary = Array.isArray(types) && types.length ? types[0] : null;
      if (primary) {
        const metadata = harperKindMetadata(primary);
        span.className = `squiggle squiggle--${metadata.key}`;
        span.style.setProperty("--harper-kind-color", metadata.color);
      } else {
        span.className = "squiggle";
        span.style.setProperty("--harper-kind-color", harperKindMetadata(null).color);
      }
      span.textContent = text.slice(c.start, c.end);
      wrap.appendChild(span);
      cursor = c.end;
    }
    if (cursor < text.length) wrap.appendChild(document.createTextNode(text.slice(cursor)));
    syncScroll();
  }

  function clearBackdrop() {
    els.highlights.textContent = "";
  }

  function renderCorrections(text, corrections) {
    const list = els.correctionsList;
    list.textContent = "";
    if (!corrections.length) { list.hidden = true; return; }
    list.hidden = false;

    corrections.forEach((c, i) => {
      // The card itself lives in ui/correction-card.js (shared with the
      // in-page popup — see page/content/).
      const word = getCandidate?.(c) ?? null;
      const li = buildCorrectionCard(text, c, {
        onDisableRule,
        onApply: () => onApply(i),
        onSelectSuggestion: (replacement) => onSelectSuggestion?.(i, replacement),
        onAddToDictionary: word && onAddToDictionary ? () => onAddToDictionary(i) : undefined,
      });
      li.id = `citem-${i}`;
      // List cards flatten to one line; the popup keeps the stacked layout.
      li.classList.add("citem--row");
      list.appendChild(li);
    });
  }

  function showPopup(text, c, i, clientX, clientY) {
    if (!c) return;

    els.popup.textContent = "";
    const card = buildCorrectionCard(text, c, {
      onDisableRule,
      showExplanation: false,
      showAdviceExplanation: false,
      onSelectSuggestion: (replacement) => onSelectSuggestion?.(i, replacement),
      onChooseSuggestion: (replacement) => {
        onSelectSuggestion?.(i, replacement);
        onApply(i);
      },
    });
    // Unwrap the <li> contents into the popup div.
    while (card.firstChild) els.popup.appendChild(card.firstChild);

    const actions = document.createElement("div");
    actions.className = "popup__actions";
    // Suppressible (spelling-or-untyped, single word) → offer the dictionary.
    const word = getCandidate?.(c) ?? null;
    if (word && onAddToDictionary) {
      const add = document.createElement("button");
      add.type = "button";
      add.className = "btn popup__dict";
      add.title = `Add “${word}” to dictionary`;
      add.setAttribute("aria-label", `Add “${word}” to dictionary`);
      add.appendChild(svgIcon(document, ICON_PATHS.bookPlus));
      add.addEventListener("click", () => onAddToDictionary(i));
      actions.append(add);
    }
    els.popup.classList.toggle("popup--has-dictionary", !!(word && onAddToDictionary));
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "btn popup__dismiss";
    dismiss.title = "Dismiss for now";
    dismiss.setAttribute("aria-label", "Dismiss for now");
    dismiss.appendChild(svgIcon(document, ICON_PATHS.x));
    dismiss.addEventListener("click", () => {
      if (onDismiss) onDismiss(i);
      else hidePopup();
    });
    actions.append(dismiss);
    els.popup.appendChild(actions);

    // Show first (so we can measure), then clamp into the viewport.
    els.popup.hidden = false;
    const pad = 8;
    const rect = els.popup.getBoundingClientRect();
    let left = clientX;
    let top = clientY + 14;
    if (left + rect.width + pad > window.innerWidth) left = window.innerWidth - rect.width - pad;
    if (top + rect.height + pad > window.innerHeight) top = clientY - rect.height - 10;
    els.popup.style.left = `${Math.max(pad, left)}px`;
    els.popup.style.top = `${Math.max(pad, top)}px`;

    flashItem(i);
  }

  function hidePopup() {
    els.popup.hidden = true;
  }

  function flashItem(i) {
    const el = document.getElementById(`citem-${i}`);
    if (!el) return;
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    el.classList.remove("flash");
    void el.offsetWidth; // restart the animation
    el.classList.add("flash");
  }

  // Close the popup on outside click or Escape without changing the result.
  document.addEventListener("mousedown", (e) => {
    if (!els.popup.hidden && !els.popup.contains(e.target) && e.target !== els.editor) {
      hidePopup();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hidePopup();
  });

  return { renderBackdrop, clearBackdrop, renderCorrections, showPopup, hidePopup };
}
