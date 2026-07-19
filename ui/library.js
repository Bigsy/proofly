// ui/library.js — the notes library view: grouped cards, a per-card "…" menu
// (Export / Delete with a two-step inline confirm), a search box, and the
// empty state.
//
// Wired by initLibrary(deps), mirroring ui/render.js / initRewrite — deps are
// injected to avoid an import cycle back into the entry (sidepanel.js):
//   els          — element map (docList, docSearch, docEmpty, newDocBtn)
//   onOpen(id)   — open a note in the editor
//   onNew()      — start a new blank doc
//   onDelete(id) — delete a note (the entry then re-renders the library)
//   onExport(id) — download a note as .txt
//
// render(index) is the seam: the entry loads the index from the store and hands
// it here; the library never touches storage itself. The index is already
// sorted (updatedAt desc, id desc) by listIndex, and the search reads it as-is,
// so what a search sees is always the on-disk state (Back flushes the save).

import { compareByRecency, formatRelative, groupByRecency, matchesQuery } from "../lib/notes.js";

export function initLibrary({ els, onOpen, onNew, onDelete, onExport }) {
  let currentIndex = []; // last index handed to render()
  let query = "";        // current search text
  let menuId = null;     // id of the card whose "…" menu is open (or null)
  let menuEl = null;     // the open menu element

  // Re-render the list from `currentIndex`, applying the live search filter.
  // While searching, grouping is bypassed (a flat, recency-sorted list).
  function draw() {
    closeMenu();
    const list = els.docList;
    list.textContent = "";

    const matches = currentIndex.filter((e) => matchesQuery(e, query));
    const searching = !!query.trim();

    if (!matches.length) {
      els.docEmpty.hidden = false;
      els.docEmpty.textContent = searching
        ? "No notes match your search."
        : "No notes yet — start a new one.";
      return;
    }
    els.docEmpty.hidden = true;

    const groups = searching
      ? [{ label: null, notes: [...matches].sort(compareByRecency) }]
      : groupByRecency(matches, Date.now());

    for (const group of groups) {
      if (group.label) {
        const heading = document.createElement("div");
        heading.className = "group-heading";
        heading.setAttribute("role", "heading");
        heading.setAttribute("aria-level", "2");
        heading.textContent = group.label;
        list.appendChild(heading);
      }
      for (const entry of group.notes) list.appendChild(buildCard(entry));
    }
  }

  function buildCard(entry) {
    const card = document.createElement("div");
    card.className = "doc-card";
    card.dataset.id = entry.id;
    card.addEventListener("click", () => onOpen(entry.id));
    // Keyboard path: the card can't be a real <button> (the "…" menu button
    // nests inside it, and interactive-in-interactive is invalid), so it gets
    // the button role + tabindex and handles Enter/Space itself.
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.addEventListener("keydown", (e) => {
      if (e.target !== card) return; // the "…" button handles its own keys
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault(); // Space must open the note, not scroll the list
      onOpen(entry.id);
    });

    const menuBtn = document.createElement("button");
    menuBtn.className = "btn btn--icon doc-card__menu-btn";
    menuBtn.type = "button";
    menuBtn.textContent = "⋯";
    menuBtn.setAttribute("aria-label", "Note actions");
    menuBtn.setAttribute("aria-haspopup", "menu");
    menuBtn.setAttribute("aria-expanded", "false");
    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation(); // don't open the note
      toggleMenu(entry.id, card);
      menuBtn.setAttribute("aria-expanded", String(menuId === entry.id));
    });
    card.appendChild(menuBtn);

    const title = document.createElement("div");
    title.className = "doc-card__title";
    title.textContent = entry.title || "Untitled note";
    card.appendChild(title);

    if (entry.snippet) {
      const snippet = document.createElement("div");
      snippet.className = "doc-card__snippet";
      snippet.textContent = entry.snippet;
      card.appendChild(snippet);
    }

    const meta = document.createElement("div");
    meta.className = "doc-card__meta";
    meta.textContent = formatRelative(entry.updatedAt, Date.now());
    card.appendChild(meta);

    return card;
  }

  // ---------- the "…" menu (Export / Delete) ----------
  function closeMenu() {
    if (menuEl) menuEl.remove();
    menuEl = null;
    menuId = null;
  }

  function toggleMenu(id, card) {
    if (menuId === id) { closeMenu(); return; }
    closeMenu();
    menuId = id;
    menuEl = buildMenu(id);
    card.appendChild(menuEl);
  }

  function buildMenu(id) {
    const menu = document.createElement("div");
    menu.className = "doc-menu";
    menu.setAttribute("role", "menu");
    // Clicks inside the menu must not bubble to the card (which would open it).
    menu.addEventListener("click", (e) => e.stopPropagation());

    const exportBtn = document.createElement("button");
    exportBtn.type = "button";
    exportBtn.className = "doc-menu__export";
    exportBtn.setAttribute("role", "menuitem");
    exportBtn.textContent = "Export";
    exportBtn.addEventListener("click", () => { closeMenu(); onExport(id); });

    // Two-step inline confirm: first click arms, second click deletes. No
    // native window.confirm — matches the codebase's in-DOM affordances and is
    // testable without stubbing a global.
    const del = document.createElement("button");
    del.type = "button";
    del.className = "doc-menu__delete";
    del.setAttribute("role", "menuitem");
    del.textContent = "Delete";
    let armed = false;
    del.addEventListener("click", () => {
      if (!armed) {
        armed = true;
        del.textContent = "Confirm delete";
        del.classList.add("doc-menu__delete--confirm");
        return;
      }
      closeMenu();
      onDelete(id);
    });

    menu.append(exportBtn, del);
    return menu;
  }

  // ---------- wiring ----------
  els.docSearch.addEventListener("input", () => {
    query = els.docSearch.value;
    draw();
  });
  els.newDocBtn.addEventListener("click", onNew);

  // Dismiss the open menu on outside click / Escape (mirrors the suggestion
  // popup in ui/render.js).
  document.addEventListener("mousedown", (e) => {
    if (!menuEl) return;
    if (menuEl.contains(e.target) || e.target.closest?.(".doc-card__menu-btn")) return;
    closeMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMenu();
  });

  return {
    render(index) {
      currentIndex = Array.isArray(index) ? index : [];
      draw();
    },
  };
}
