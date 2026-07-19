// page/content/language.js — the expected-input-language gate for the in-page
// feature. Harper is English-focused, so
// a field that declares another language must never reach the engine at all:
// typing French into a French site's textarea would otherwise get confident
// English "corrections".
//
// Policy: a DECLARED unsupported language blocks; an undeclared language is
// assumed supported (most pages don't set `lang`, and treating "unknown" as
// blocked would kill the feature on them — same stance the model itself takes).
// Enforcement lives in two places, both importing from here so the list can't
// fork: detect.js (activation eligibility) and index.js runLint (re-checked
// per lint, so a mid-session `lang` swap stops linting without a refocus).

export const SUPPORTED_INPUT_LANGUAGES = Object.freeze(["en"]);

// BCP 47 primary subtag: "en-GB" → "en", "FR" → "fr". null for non-strings
// and for the empty tag (lang="" means "language unknown" per the HTML spec).
export function primaryLanguageSubtag(tag) {
  if (typeof tag !== "string") return null;
  const primary = tag.trim().toLowerCase().split("-", 1)[0];
  return primary || null;
}

// The language governing a field, per the HTML language-determination rules:
// the nearest ancestor-or-self `lang` attribute, falling back to the document
// element for fields inside shadow roots (closest() stops at the shadow
// boundary). Returns the primary subtag, or null when nothing is declared.
export function declaredFieldLanguage(field) {
  const holder = field?.closest?.("[lang]");
  const raw = holder
    ? holder.getAttribute("lang")
    : field?.ownerDocument?.documentElement?.getAttribute?.("lang");
  return primaryLanguageSubtag(raw);
}

export function isSupportedFieldLanguage(field, supported = SUPPORTED_INPUT_LANGUAGES) {
  const lang = declaredFieldLanguage(field);
  return lang === null || supported.includes(lang);
}
