// ui/icons.js — the small shared Lucide/Feather icon set used by correction
// popups. Licence notices are in THIRD_PARTY_NOTICES.md.
// Built with createElementNS rather than innerHTML so the same helper is safe
// inside content scripts on pages that enforce Trusted Types.

export const ICON_PATHS = {
  bookPlus: [
    "M12 7v6",
    "M9 10h6",
    "M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20",
  ],
  x: ["M18 6 6 18", "m6 6 12 12"],
};

export function svgIcon(doc, paths) {
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}
