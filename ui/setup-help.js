// ui/setup-help.js — DOM-built setup guidance for optional Chrome rewriting.
// Deps-injected like the rest of ui/:
// no chrome.* here — the entry passes `openUrl` (chrome.tabs.create) in,
// because Chrome blocks page-initiated navigation to chrome:// URLs, so a
// plain href can't open a flags page. Everything is built with createElement/
// append — no innerHTML, so nothing here can ever interpolate markup.

export function chromeMajorVersion(ua = navigator.userAgent) {
  return Number(/Chrome\/(\d+)/.exec(ua)?.[1] ?? 0);
}

// A chrome:// link that opens via openUrl: Chrome blocks page-initiated
// navigation to its internal URLs, but extension pages may create a tab.
function flagLink(url, label, openUrl, className = "") {
  const a = document.createElement("a");
  a.href = "#";
  if (className) a.className = className;
  a.textContent = label;
  a.addEventListener("click", (e) => {
    e.preventDefault();
    openUrl(url);
  });
  return a;
}

// Harper proofreading is packaged and requires no Chrome flag or model.
export function renderLibraryApiSetup(container, { openUrl }) {
  const title = document.createElement("strong");
  title.textContent = "Chrome AI setup";

  const links = document.createElement("span");
  links.className = "library__api-links";
  links.append(
    flagLink(
      "chrome://flags/#rewriter-api-for-gemini-nano",
      "Enable Rewriter API",
      openUrl,
      "library__api-link",
    ),
  );

  const hint = document.createElement("span");
  hint.className = "library__api-hint";
  hint.textContent = "Optional: enable the flag, then relaunch Chrome. Proofreading works without it.";

  container.replaceChildren(title, links, hint);
}
