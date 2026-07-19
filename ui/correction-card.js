// ui/correction-card.js — the one correction card, extracted from ui/render.js
// so the side panel's list/popup and the in-page popup (page/content/) render
// the same card without copy-paste divergence. DOM-agnostic in the deps sense:
// no element-id lookups, no module state — callers pass the text, the
// correction, and (optionally) an Apply handler.

import { harperKindMetadata } from "../lib/harper-types.js";

export function isApplicableCorrection(c) {
  if (Array.isArray(c?.suggestions)) {
    return c.suggestions.some((suggestion) => typeof suggestion?.replacement === "string");
  }
  return typeof c?.correction === "string";
}

// Build one correction card as an <li class="citem">. `onApply` present →
// a footer Apply button wired to it; `onAddToDictionary` present → a
// secondary "Add to dictionary" button beside it (callers pass it only for
// suppressible corrections — eligibility is decided upstream, in
// lib/dictionary.js, so this card stays dictionary-dumb). Neither → no
// footer (the popups add their own action rows).
export function buildCorrectionCard(text, c, {
  onApply,
  onAddToDictionary,
  onSelectSuggestion,
  onChooseSuggestion,
  showTypes = true,
  showExplanation = true,
  showAdviceExplanation = true,
} = {}) {
  const start = Number(c.startIndex);
  const end = Number(c.endIndex);
  const correction = c.correction ?? "";
  const applicable = isApplicableCorrection(c);
  const orig = Number.isFinite(start) && Number.isFinite(end) && end > start
    ? text.slice(start, end) : "";

  // Pure insertions have an empty original span. Rendering that as "∅ → ," reads
  // like a bug, so show the adjacent word with and without the inserted text,
  // e.g. "France → France," (or, when inserting before a word, "word → ,word").
  //
  // NOTE: the same /\S+$/, /^\S+/ adjacent-word anchoring lives in
  // displaySpan (lib/corrections.js) — keep the two in lockstep (both prefer
  // the word BEFORE the caret). They intentionally diverge only at the edges:
  // displaySpan returns null (no squiggle) for unanchorable/out-of-range
  // spans, whereas the card stays lenient and still renders a "∅" row, so
  // they can't simply share one helper without changing tested behaviour.
  let fromText = orig;
  let anchorBefore = "";
  let anchorAfter = "";
  if (!orig && Number.isFinite(start)) {
    anchorBefore = /\S+$/.exec(text.slice(0, start))?.[0] ?? "";
    anchorAfter = /^\S+/.exec(text.slice(start))?.[0] ?? "";
    if (anchorBefore) fromText = anchorBefore;
    else if (anchorAfter) fromText = anchorAfter;
  }

  // A whitespace-only diff renders as two identical-looking chips ("Line" →
  // " Line" — the inserted space is invisible, and edge whitespace collapses
  // anyway). When neither side of the change has visible characters, draw
  // the whitespace itself: ␣ (space), ⇥ (tab), ⏎ (newline).
  const drawWhitespace = (s) => s
    .replace(/ /g, "␣")
    .replace(/\t/g, "⇥")
    .replace(/\r?\n/g, "⏎");
  function displayReplacement(replacement) {
    let displayed = replacement;
    if (anchorBefore) displayed = anchorBefore + replacement;
    else if (anchorAfter) displayed = replacement + anchorAfter;
    if (!orig.trim() && !replacement.trim()) displayed = drawWhitespace(displayed);
    return displayed || "∅";
  }
  if (!orig.trim() && !correction.trim()) fromText = drawWhitespace(fromText);

  const li = document.createElement("li");
  li.className = "citem";

  const head = document.createElement("div");
  head.className = "citem__head";
  let to = null;

  if (applicable) {
    const from = document.createElement("span");
    from.className = "chip chip--from";
    from.textContent = fromText || "∅";

    const arrow = document.createElement("span");
    arrow.className = "arrow";
    arrow.textContent = "→";

    to = document.createElement(onChooseSuggestion ? "button" : "span");
    to.className = "chip chip--to";
    to.textContent = displayReplacement(correction); // a pure deletion: "word → ∅", not a blank pill
    if (onChooseSuggestion) {
      to.type = "button";
      to.classList.add("citem__choice");
      to.setAttribute("aria-label", `Apply ${correction || "deletion"}`);
      to.addEventListener("click", () => onChooseSuggestion(correction));
    }

    head.append(from, arrow, to);
  } else {
    li.classList.add("citem--informational");
    const excerpt = orig.replace(/\s+/g, " ").trim();
    if (excerpt) {
      const context = document.createElement("span");
      context.className = "citem__excerpt";
      context.textContent = excerpt.length > 120 ? `${excerpt.slice(0, 117)}…` : excerpt;
      head.appendChild(context);
    }
  }
  if (head.childNodes.length) li.appendChild(head);

  const suggestions = Array.isArray(c.suggestions)
    ? c.suggestions.filter((suggestion) => typeof suggestion?.replacement === "string")
    : [];
  if (suggestions.length > 1) {
    const choices = document.createElement("div");
    choices.className = "citem__suggestions";
    const prompt = document.createElement("div");
    prompt.className = "citem__suggestions-label";
    prompt.textContent = "Choose a suggestion";
    choices.appendChild(prompt);

    for (const suggestion of suggestions) {
      const choice = document.createElement("button");
      choice.type = "button";
      choice.className = "citem__suggestion";
      choice.textContent = suggestion.replacement || "Delete";
      choice.setAttribute("aria-label", `${onChooseSuggestion ? "Apply" : "Use"} ${suggestion.replacement || "deletion"}`);
      choice.addEventListener("click", () => {
        c.correction = suggestion.replacement;
        to.textContent = displayReplacement(suggestion.replacement);
        onSelectSuggestion?.(suggestion.replacement);
        onChooseSuggestion?.(suggestion.replacement);
      });
      choices.appendChild(choice);
    }
    li.appendChild(choices);
  }

  const types = Array.isArray(c.types) && c.types.length
    ? c.types
    : (!applicable ? [null] : []);
  if ((showTypes || !applicable) && types.length) {
    const badges = document.createElement("div");
    badges.className = "badges";
    for (const t of types) {
      const metadata = harperKindMetadata(t);
      const b = document.createElement("span");
      b.className = `badge badge--${metadata.key}`;
      b.style.setProperty("--harper-kind-color", metadata.color);
      b.textContent = metadata.label;
      badges.appendChild(b);
    }
    li.appendChild(badges);
  }

  const explanation = typeof c.explanation === "string" && c.explanation.trim()
    ? c.explanation
    : (!applicable ? "Review this passage." : "");
  if ((showExplanation || (!applicable && showAdviceExplanation)) && explanation) {
    const ex = document.createElement("p");
    ex.className = "explain";
    ex.textContent = explanation;
    ex.title = explanation; // row layout truncates — hover for the full text
    li.appendChild(ex);
  }

  if ((onApply && applicable) || onAddToDictionary) {
    const foot = document.createElement("div");
    foot.className = "citem__foot";
    if (onApply && applicable) {
      const apply = document.createElement("button");
      apply.className = "btn btn--primary btn--sm citem__apply";
      apply.textContent = "Apply";
      apply.addEventListener("click", onApply);
      foot.appendChild(apply);
    }
    if (onAddToDictionary) {
      const add = document.createElement("button");
      add.className = "btn btn--sm citem__dict";
      add.textContent = "Add to dictionary";
      add.addEventListener("click", onAddToDictionary);
      foot.appendChild(add);
    }
    li.appendChild(foot);
  }

  return li;
}
