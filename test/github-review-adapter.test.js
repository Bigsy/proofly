import { describe, expect, it, vi } from "vitest";
import { adapterForField } from "../page/content/adapters/index.js";
import { assertAdapter } from "../page/content/adapters/contracts.js";
import { isEligibleFormField } from "../page/content/adapters/form.js";
import {
  githubReviewAdapter, isGitHubReviewField,
} from "../page/content/adapters/github-review.js";

function newReviewField(containerAttribute = "data-marker-id") {
  const container = document.createElement("div");
  const value = containerAttribute === "data-marker-navigation-new-thread" ? "true"
    : containerAttribute === "data-testid" ? "review-thread"
      : "thread-1";
  container.setAttribute(containerAttribute, value);
  const field = document.createElement("textarea");
  field.setAttribute("aria-label", "Markdown value");
  field.setAttribute("spellcheck", "false");
  field.value = "This coment needs proofreading.";
  container.appendChild(field);
  document.body.appendChild(container);
  return field;
}

describe("GitHub review adapter", () => {
  it("claims new thread, existing thread, and review-thread textarea shapes", () => {
    expect(assertAdapter(githubReviewAdapter)).toBe(githubReviewAdapter);
    for (const marker of ["data-marker-navigation-new-thread", "data-marker-id", "data-testid"]) {
      const field = newReviewField(marker);
      expect(isEligibleFormField(field), marker).toBe(false);
      expect(isGitHubReviewField(field), marker).toBe(true);
      expect(adapterForField(field), marker).toBe(githubReviewAdapter);
      field.parentElement.remove();
    }
  });

  it("claims legacy inline review fields", () => {
    for (const name of ["comment[body]", "pull_request_review_comment[body]"]) {
      const container = document.createElement("div");
      container.className = "js-inline-comments-container";
      const field = document.createElement("textarea");
      field.name = name;
      field.setAttribute("spellcheck", "false");
      container.appendChild(field);
      document.body.appendChild(container);
      expect(adapterForField(field), name).toBe(githubReviewAdapter);
      container.remove();
    }
  });

  it("does not broaden unrelated Markdown or spellcheck=false textareas", () => {
    const markdown = document.createElement("textarea");
    markdown.setAttribute("aria-label", "Markdown value");
    markdown.setAttribute("spellcheck", "false");
    document.body.appendChild(markdown);
    expect(isGitHubReviewField(markdown)).toBe(false);
    expect(adapterForField(markdown)).toBe(null);

    const thread = document.createElement("div");
    thread.dataset.markerId = "thread-1";
    const ordinary = document.createElement("textarea");
    ordinary.setAttribute("spellcheck", "false");
    thread.appendChild(ordinary);
    document.body.appendChild(thread);
    expect(isGitHubReviewField(ordinary)).toBe(false);
    expect(adapterForField(ordinary)).toBe(null);
  });

  it("retains textarea safety gates and shared writeback semantics", () => {
    for (const makeIneligible of [
      (field) => { field.disabled = true; },
      (field) => { field.readOnly = true; },
      (field) => field.setAttribute("aria-readonly", "true"),
      (field) => field.setAttribute("aria-hidden", "true"),
    ]) {
      const field = newReviewField();
      makeIneligible(field);
      expect(adapterForField(field)).toBe(null);
      field.parentElement.remove();
    }

    const field = newReviewField();
    const seen = vi.fn();
    field.addEventListener("input", seen);
    const snapshot = githubReviewAdapter.snapshot(field);
    expect(githubReviewAdapter.apply(field, snapshot, {
      startIndex: 5,
      endIndex: 11,
      correction: "comment",
    })).toEqual({ applied: true, newCaret: 12 });
    expect(field.value).toBe("This comment needs proofreading.");
    expect(seen).toHaveBeenCalledTimes(1);
  });
});
