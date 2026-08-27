// GitHub's React-based inline PR review editors explicitly set
// spellcheck=false, unlike the older PR summary editor. That disables the
// browser spellchecker but these fields still contain prose, so give only the
// well-known review-thread shapes the ordinary textarea mechanics without
// treating spellcheck=false as a Proofly opt-out.

import {
  applyFormCorrection, createFormSnapshot, isUsableFormField,
} from "./form.js";

const NEW_REVIEW_EDITOR = 'textarea[aria-label="Markdown value"]';
const NEW_REVIEW_CONTAINER = [
  'div[data-marker-navigation-new-thread="true"]',
  "div[data-marker-id]",
  'div[data-testid="review-thread"]',
].join(",");

const LEGACY_REVIEW_EDITOR = [
  'textarea[name="comment[body]"]',
  'textarea[name="pull_request_review_comment[body]"]',
].join(",");

export function isGitHubReviewField(el) {
  if (el?.tagName !== "TEXTAREA") return false;
  if (el.matches?.(NEW_REVIEW_EDITOR) && el.closest?.(NEW_REVIEW_CONTAINER)) return true;
  return !!(el.matches?.(LEGACY_REVIEW_EDITOR) && el.closest?.(".js-inline-comments-container"));
}

export const githubReviewAdapter = Object.freeze({
  id: "github-review",
  match: isGitHubReviewField,
  root: (candidate) => isGitHubReviewField(candidate) ? candidate : null,
  isEligible: isUsableFormField,
  snapshot: createFormSnapshot,
  apply: applyFormCorrection,
});
