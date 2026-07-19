// page/content/highlights.js — the in-page underline renderer + suggestion
// popup, hosted in a shadow DOM so page CSS can't bleed in (and ours can't
// leak out).
//
// Phase 1 renders ONLY the mirror-measured overlay: a
// <textarea>/<input>'s value lives in an internal anonymous tree that
// document.createRange() cannot address, so the CSS Highlight API can never
// reach it — the overlay is the renderer for these fields, not a fallback.
// The technique (Harper's TextFieldRange, also Grammarly/LanguageTool): build
// an invisible mirror <div> copying the field's text-layout styles, put the
// value in a text node, and use a real Range over the MIRROR purely to call
// getClientRects() — measurement only, never visible.
//
// Phase 2 adds the CSS Highlight API path (for contenteditable) — it must use
// native `text-decoration: underline wavy`, so the SVG below is hand-matched
// to native wavy at 1px thickness ("slightly wavy"). Both renderers
// import squiggleBackground from here so the two geometry paths can't drift.

import { usableSpans } from "../../lib/corrections.js";
import { harperKindMetadata } from "../../lib/harper-types.js";
import { buildCorrectionCard } from "../../ui/correction-card.js";
import { ICON_PATHS, svgIcon } from "../../ui/icons.js";

// One wave period as a repeating background tile. Amplitude/stroke tuned to
// read like native `underline wavy` at 1px text-decoration-thickness —
// deliberately subtler than the side panel's 2px squiggle.
const SQUIGGLE_TILE_W = 8;
const SQUIGGLE_TILE_H = 3;
export function squiggleBackground(color) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SQUIGGLE_TILE_W}" height="${SQUIGGLE_TILE_H}" ` +
    `viewBox="0 0 ${SQUIGGLE_TILE_W} ${SQUIGGLE_TILE_H}">` +
    `<path d="M0 1.5 Q 2 -0.5 4 1.5 T 8 1.5" fill="none" stroke="${color}" stroke-width="1"/>` +
    "</svg>";
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

export const HOST_ID = "proofly-highlight-host";

// Keep the overlay inside the field's modal/top-layer owner when there is
// one. Sites such as GitHub dismiss dialogs from a capture-phase outside-
// pointer handler. If our shadow host lives under <html>, an interaction with
// the Proofly popup is retargeted to that host and looks outside the dialog,
// so the page removes the editor before the correction's click can apply.
const INTERACTION_BOUNDARY_SELECTOR = [
  "dialog",
  '[role="dialog"]',
  '[role="alertdialog"]',
  "[popover]",
].join(", ");

function composedParent(node) {
  return node?.parentElement ?? node?.getRootNode?.()?.host ?? null;
}

function interactionBoundary(field, doc) {
  for (let node = composedParent(field); node; node = composedParent(node)) {
    if (node.matches?.(INTERACTION_BOUNDARY_SELECTOR)) return node;
  }
  return doc.documentElement;
}

// Text-layout styles the mirror must copy for its line breaks (and therefore
// its Range rects) to match the field's rendering exactly. Border widths come
// through as used values (0 when the style is none); the mirror sets its own
// transparent solid border so they apply.
const MIRROR_STYLE_PROPS = [
  "font-family", "font-size", "font-style", "font-weight", "font-variant",
  "font-stretch", "font-kerning", "font-feature-settings", "font-variation-settings",
  "letter-spacing", "word-spacing", "text-transform", "text-indent", "text-rendering",
  "line-height", "tab-size", "overflow-wrap", "word-break", "box-sizing",
  "padding-top", "padding-right", "padding-bottom", "padding-left",
  "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
  "direction", "text-align",
];

// Everything our own UI needs, scoped to the shadow root. `all: initial` on
// the host blocks page-inherited styles; the palette mirrors sidepanel.css.
const SHADOW_CSS = `
  :host {
    all: initial;
    position: fixed;
    top: 0; left: 0;
    width: 0; height: 0;
    z-index: 2147483647;
    pointer-events: none;
  }
  .probe { position: fixed; top: 0; left: 0; width: 0; height: 0; visibility: hidden; }
  .mirror {
    position: fixed;
    visibility: hidden;
    pointer-events: none;
    border-style: solid;
    border-color: transparent;
    margin: 0;
    overflow: hidden;
  }
  .squiggle-box {
    position: fixed;
    pointer-events: none;
    background-repeat: repeat-x;
    background-position: left bottom;
    background-size: ${SQUIGGLE_TILE_W}px ${SQUIGGLE_TILE_H}px;
  }
  .tint-box { position: fixed; pointer-events: none; border-radius: 2px; }

  .popup {
    --panel: #171a23; --panel-2: #1e222e; --border: #2a2f3d; --text: #e6e8ee;
    --muted: #8b91a3; --accent: #6366f1;
    --from: #3b1d22; --from-text: #fca5a5; --to: #11301f; --to-text: #86efac;
    position: fixed;
    pointer-events: auto;
    max-width: 250px;
    padding: 10px;
    border-radius: 10px;
    background: var(--panel);
    border: 1px solid var(--border);
    box-shadow: 0 10px 34px rgba(0, 0, 0, 0.4);
    color: var(--text);
    font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  @media (prefers-color-scheme: light) {
    .popup {
      --panel: #ffffff; --panel-2: #f0f2f7; --border: #e2e5ee; --text: #1c2030;
      --muted: #6b7280;
      --from: #fdecec; --from-text: #b42318; --to: #e7f7ee; --to-text: #027a48;
    }
  }
  .popup[hidden] { display: none; }
  .citem__head {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    padding-right: 30px;
  }
  .popup--has-dictionary .citem__head { padding-right: 62px; }
  .chip { padding: 2px 8px; border-radius: 7px; font-weight: 600; font-size: 13px; }
  .chip--from { background: var(--from); color: var(--from-text); text-decoration: line-through; }
  .chip--to { background: var(--to); color: var(--to-text); }
  .arrow { color: var(--muted); }
  .citem__excerpt { color: var(--text); font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
  .badges { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .badge {
    color: var(--harper-kind-color, var(--muted));
    font-size: 10px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.04em; padding: 2px 7px; border-radius: 999px;
    background: var(--panel-2); border: 1px solid;
    border-color: color-mix(in srgb, var(--harper-kind-color, var(--muted)) 33%, transparent);
  }
  .explain { margin: 8px 0 0; color: var(--muted); font-size: 13px; }
  .citem__suggestions { display: flex; flex-wrap: wrap; gap: 5px; margin: 8px 0 0; padding: 0; border: 0; }
  .citem__suggestions-label { width: 100%; color: var(--muted); font-size: 11px; }
  .citem__suggestion { appearance: none; display: inline-flex; align-items: center; padding: 3px 7px; background: transparent; color: inherit; font: inherit; border: 1px solid var(--border); border-radius: 7px; cursor: pointer; font-size: 12px; }
  .citem__suggestion:hover { border-color: var(--accent); background: var(--panel-2); }
  .citem__suggestion:focus-visible, .citem__choice:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .citem__choice { appearance: none; border: 0; font: inherit; cursor: pointer; }
  /* Keep secondary actions in the top-right action rail. Reserving room in
     the first content row above prevents the correction chips from sitting
     underneath it, while removing an otherwise dedicated footer row. */
  .popup__actions {
    position: absolute; top: 8px; right: 8px;
    display: flex; justify-content: flex-end; gap: 6px;
  }
  .popup__actions .btn {
    display: inline-flex; align-items: center; justify-content: center;
    padding: 5px; border-radius: 7px; color: var(--muted);
  }
  .popup__actions .btn svg { width: 14px; height: 14px; display: block; }
  .popup__actions .btn:hover { border-color: var(--accent); color: var(--text); }
  .btn {
    appearance: none; border: 1px solid var(--border); background: var(--panel-2);
    color: var(--text); border-radius: 8px; cursor: pointer;
    font: inherit; font-size: 12px; padding: 4px 11px;
  }
  .btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .btn--primary { background: var(--accent); border-color: transparent; color: #fff; }
`;

const primaryType = (c) =>
  Array.isArray(c?.types) && c.types.length ? c.types[0] : null;

const squiggleColor = (c) => harperKindMetadata(primaryType(c)).color;

export function createOverlayRenderer({ doc = document } = {}) {
  let host = null;
  let shadow = null;
  let probe = null;     // fixed (0,0) probe — see containingBlockOffset()
  let mirror = null;
  let mirrorText = null;
  let boxLayer = null;  // squiggle + tint boxes live here
  let popupEl = null;

  let last = null;      // { field, text, corrections } of the latest render
  let activeIndex = -1; // correction tinted while its popup is open

  function mountForField(field) {
    const parent = interactionBoundary(field, doc);
    if (host?.parentNode !== parent) parent.appendChild(host);
  }

  function ensureHost() {
    if (host) return;
    host = doc.createElement("div");
    host.id = HOST_ID;
    shadow = host.attachShadow({ mode: "open" });

    const style = doc.createElement("style");
    style.textContent = SHADOW_CSS;
    shadow.appendChild(style);

    probe = doc.createElement("div");
    probe.className = "probe";
    shadow.appendChild(probe);

    mirror = doc.createElement("div");
    mirror.className = "mirror";
    mirrorText = doc.createTextNode("");
    mirror.appendChild(mirrorText);
    shadow.appendChild(mirror);

    boxLayer = doc.createElement("div");
    shadow.appendChild(boxLayer);

    popupEl = doc.createElement("div");
    popupEl.className = "popup";
    popupEl.hidden = true;
    // Announce as a dialog: the buttons are natively focusable, Escape (the
    // doc keydown below) dismisses, and index.js's focusout handler treats
    // focus moving into this host as staying "in the field", so a keyboard
    // user can Tab to the buttons without tearing the popup down.
    popupEl.setAttribute("role", "dialog");
    popupEl.setAttribute("aria-label", "Proofly suggestion");
    // Keep the field focused while interacting with the popup, and contain
    // pointer/mouse events so page-level delegated handlers cannot treat our
    // shadow UI as their own outside click. Capture-phase outside handlers are
    // handled by mountForField(): their composed target is then inside the
    // owning dialog before the event reaches this target.
    const containPopupInteraction = (e) => {
      if (e.type === "pointerdown" || e.type === "mousedown") e.preventDefault();
      e.stopPropagation();
    };
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      popupEl.addEventListener(type, containPopupInteraction);
    }
    shadow.appendChild(popupEl);

    doc.documentElement.appendChild(host);

    // Close on outside interaction / Escape. composedPath() because at the
    // document level the target of a shadow-DOM click is just the host.
    doc.addEventListener("mousedown", onDocMousedown, true);
    doc.addEventListener("keydown", onDocKeydown, true);
  }

  function onDocMousedown(e) {
    if (!popupEl.hidden && !e.composedPath().includes(popupEl)) hidePopup();
  }
  function onDocKeydown(e) {
    if (e.key === "Escape") hidePopup();
  }

  // `position: fixed` is only viewport-relative until an ancestor has a
  // transform/filter/contain/will-change — then it's relative to that
  // containing block. Rather than enumerating those
  // properties up the tree (Harper's isContainingBlock), measure where our
  // fixed (0,0) probe actually landed and subtract.
  function containingBlockOffset() {
    const r = probe.getBoundingClientRect();
    return { x: r.left, y: r.top };
  }

  // Copy the field's text-layout styles onto the mirror and position it
  // exactly over the field, so the mirror Range's getClientRects() are
  // directly comparable to the field's on-screen text (minus its scroll).
  function syncMirror(field, text, fieldRect, off) {
    const cs = doc.defaultView.getComputedStyle(field);
    for (const prop of MIRROR_STYLE_PROPS) {
      mirror.style.setProperty(prop, cs.getPropertyValue(prop));
    }
    const isInput = field.tagName === "INPUT";
    // Inputs never wrap; textareas wrap like pre-wrap (trust the computed
    // value so odd page styling stays mirrored).
    mirror.style.whiteSpace = isInput ? "pre" : (cs.getPropertyValue("white-space") || "pre-wrap");
    mirror.style.boxSizing = "border-box";
    // clientWidth excludes any scrollbar, so wrapping matches even when the
    // textarea is scrolling; add borders back since the mirror is border-box.
    const bl = parseFloat(cs.getPropertyValue("border-left-width")) || 0;
    const br = parseFloat(cs.getPropertyValue("border-right-width")) || 0;
    mirror.style.width = `${field.clientWidth + bl + br}px`;
    mirror.style.left = `${fieldRect.left - off.x}px`;
    mirror.style.top = `${fieldRect.top - off.y}px`;
    mirrorText.nodeValue = text;
  }

  // The field's visible text area (padding box), for clipping boxes that have
  // scrolled out of view.
  function fieldViewport(field, fieldRect) {
    const left = fieldRect.left + field.clientLeft;
    const top = fieldRect.top + field.clientTop;
    return { left, top, right: left + field.clientWidth, bottom: top + field.clientHeight };
  }

  function clearBoxes() {
    boxLayer.textContent = "";
  }

  function render(field, text, corrections) {
    ensureHost();
    mountForField(field);
    last = { mode: "mirror", field, text, corrections };
    clearBoxes();
    if (!text || !corrections.length) return;

    const off = containingBlockOffset();
    const fieldRect = field.getBoundingClientRect();
    syncMirror(field, text, fieldRect, off);

    const view = fieldViewport(field, fieldRect);
    const range = doc.createRange();

    // Single-line <input>s vertically centre their text; the mirror's flows
    // from the top. Measure the mirror's first line to compute the delta.
    let centerDelta = 0;
    if (field.tagName === "INPUT" && text.length) {
      range.setStart(mirrorText, 0);
      range.setEnd(mirrorText, text.length);
      const lineRect = range.getBoundingClientRect();
      if (lineRect.height > 0) {
        centerDelta = Math.max(0, (field.clientHeight - lineRect.height) / 2);
      }
    }

    for (const span of usableSpans(text, corrections)) {
      const c = corrections[span.i];
      range.setStart(mirrorText, span.start);
      range.setEnd(mirrorText, span.end);
      for (const rect of range.getClientRects()) {
        if (rect.width <= 0) continue;
        // Mirror coords → on-screen coords: the mirror doesn't scroll, the
        // field's content does.
        const left = rect.left - field.scrollLeft;
        const top = rect.top - field.scrollTop + centerDelta;
        const right = left + rect.width;
        const bottom = top + rect.height;
        // Clip to the field's visible text area; drop what's scrolled away.
        const cl = Math.max(left, view.left);
        const cr = Math.min(right, view.right);
        if (cr <= cl || bottom < view.top || top > view.bottom) continue;

        const box = doc.createElement("div");
        box.className = "squiggle-box";
        box.dataset.correction = String(span.i);
        box.style.left = `${cl - off.x}px`;
        box.style.top = `${bottom - SQUIGGLE_TILE_H - off.y}px`;
        box.style.width = `${cr - cl}px`;
        box.style.height = `${SQUIGGLE_TILE_H}px`;
        box.style.backgroundImage = squiggleBackground(squiggleColor(c));
        boxLayer.appendChild(box);

        // Squiggle-only at rest; tint just the active correction (the one
        // whose popup is open) — we're drawing in someone else's page
        // (no always-on background wash).
        if (span.i === activeIndex) {
          const tint = doc.createElement("div");
          tint.className = "tint-box";
          tint.dataset.correction = String(span.i);
          tint.style.left = `${cl - off.x}px`;
          tint.style.top = `${Math.max(top, view.top) - off.y}px`;
          tint.style.width = `${cr - cl}px`;
          tint.style.height = `${Math.min(bottom, view.bottom) - Math.max(top, view.top)}px`;
          tint.style.background = `${squiggleColor(c)}22`;
          boxLayer.appendChild(tint);
        }
      }
    }
  }

  function renderSnapshot(field, snapshot, corrections) {
    ensureHost();
    mountForField(field);
    last = { mode: "snapshot", field, snapshot, corrections };
    clearBoxes();
    if (!snapshot?.text || !corrections.length) return;

    const off = containingBlockOffset();
    for (const span of usableSpans(snapshot.text, corrections)) {
      const c = corrections[span.i];
      const range = snapshot.rangeForSpan(span.start, span.end);
      if (!range) continue;
      for (const rect of range.getClientRects()) {
        if (rect.width <= 0) continue;

        const box = doc.createElement("div");
        box.className = "squiggle-box";
        box.dataset.correction = String(span.i);
        box.style.left = `${rect.left - off.x}px`;
        box.style.top = `${rect.bottom - SQUIGGLE_TILE_H - off.y}px`;
        box.style.width = `${rect.width}px`;
        box.style.height = `${SQUIGGLE_TILE_H}px`;
        box.style.backgroundImage = squiggleBackground(squiggleColor(c));
        boxLayer.appendChild(box);

        if (span.i === activeIndex) {
          const tint = doc.createElement("div");
          tint.className = "tint-box";
          tint.dataset.correction = String(span.i);
          tint.style.left = `${rect.left - off.x}px`;
          tint.style.top = `${rect.top - off.y}px`;
          tint.style.width = `${rect.width}px`;
          tint.style.height = `${rect.height}px`;
          tint.style.background = `${squiggleColor(c)}22`;
          boxLayer.appendChild(tint);
        }
      }
    }
  }

  // Geometry-only refresh (scroll/resize/poll) — same inputs, new positions.
  function rerender() {
    if (!last) return;
    if (last.mode === "snapshot") renderSnapshot(last.field, last.snapshot, last.corrections);
    else render(last.field, last.text, last.corrections);
  }

  function clear() {
    last = null;
    activeIndex = -1;
    if (boxLayer) clearBoxes();
  }

  function showPopup(text, c, i, clientX, clientY, {
    onApply,
    onAddToDictionary,
    onSelectSuggestion,
    onDismiss,
  } = {}) {
    ensureHost();
    mountForField(last?.field);
    activeIndex = i;
    rerender(); // draw the active tint

    popupEl.textContent = "";
    popupEl.classList.toggle("popup--has-dictionary", !!onAddToDictionary);
    // Ordinary fixes stay compact. buildCorrectionCard always shows the kind
    // and explanation for advice because those are its only useful content.
    const card = buildCorrectionCard(text, c, {
      showTypes: false,
      showExplanation: false,
      onSelectSuggestion: (replacement) => onSelectSuggestion?.(i, replacement),
      onChooseSuggestion: (replacement) => {
        onSelectSuggestion?.(i, replacement);
        if (!popupEl.hidden && activeIndex === i) onApply?.(i);
      },
    });
    while (card.firstChild) popupEl.appendChild(card.firstChild);

    const actions = doc.createElement("div");
    actions.className = "popup__actions";
    // Passed only for suppressible corrections — index.js decides eligibility;
    // this renderer stays dumb about dictionary logic.
    if (onAddToDictionary) {
      const add = doc.createElement("button");
      add.type = "button";
      add.className = "btn popup__dict";
      add.title = "Add to dictionary";
      add.setAttribute("aria-label", "Add to dictionary");
      add.appendChild(svgIcon(doc, ICON_PATHS.bookPlus));
      add.addEventListener("click", () => {
        if (!popupEl.hidden && activeIndex === i) onAddToDictionary(i);
      });
      actions.append(add);
    }
    const dismiss = doc.createElement("button");
    dismiss.type = "button";
    dismiss.className = "btn popup__dismiss";
    dismiss.title = "Dismiss for now";
    dismiss.setAttribute("aria-label", "Dismiss for now");
    dismiss.appendChild(svgIcon(doc, ICON_PATHS.x));
    dismiss.addEventListener("click", () => {
      if (!popupEl.hidden && activeIndex === i && onDismiss) onDismiss(i);
      else hidePopup();
    });
    actions.append(dismiss);
    popupEl.appendChild(actions);

    // Show first (so we can measure), then clamp into the viewport.
    const off = containingBlockOffset();
    popupEl.hidden = false;
    const pad = 8;
    const win = doc.defaultView;
    const rect = popupEl.getBoundingClientRect();
    let left = clientX;
    let top = clientY + 14;
    if (left + rect.width + pad > win.innerWidth) left = win.innerWidth - rect.width - pad;
    if (top + rect.height + pad > win.innerHeight) top = clientY - rect.height - 10;
    popupEl.style.left = `${Math.max(pad, left) - off.x}px`;
    popupEl.style.top = `${Math.max(pad, top) - off.y}px`;
  }

  function hidePopup() {
    if (!popupEl || popupEl.hidden) return;
    popupEl.hidden = true;
    activeIndex = -1;
    rerender(); // drop the tint
  }

  function destroy() {
    if (!host) return;
    doc.removeEventListener("mousedown", onDocMousedown, true);
    doc.removeEventListener("keydown", onDocKeydown, true);
    host.remove();
    host = shadow = probe = mirror = mirrorText = boxLayer = popupEl = null;
    last = null;
    activeIndex = -1;
  }

  return {
    render,
    renderSnapshot,
    rerender,
    clear,
    showPopup,
    hidePopup,
    isPopupOpen: () => !!popupEl && !popupEl.hidden,
    destroy,
    // test seams
    getHost: () => host,
    getShadowRoot: () => shadow,
  };
}
