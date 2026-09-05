// Convert Harper's WASM-backed lint objects into Proofly's plain correction
// model. This adapter frees the span and suggestion wrappers it obtains. The
// caller still owns each lint and must free it in its own `finally` block.

const REPLACE = new Set([0, "replace"]);
const REMOVE = new Set([1, "remove"]);
const INSERT_AFTER = new Set([2, "insertafter", "insert_after", "insert-after"]);

function call(value, name) {
  try {
    return typeof value?.[name] === "function" ? value[name]() : value?.[name];
  } catch {
    return undefined;
  }
}

function isCodePointBoundary(text, offset) {
  if (offset <= 0 || offset >= text.length) return true;
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return !(before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF);
}

function readSpan(text, lint) {
  const span = call(lint, "span");
  try {
    const start = Number(span?.start);
    const end = Number(span?.end);
    if (!Number.isInteger(start) || !Number.isInteger(end)
      || start < 0 || end < start || end > text.length
      || !isCodePointBoundary(text, start) || !isCodePointBoundary(text, end)) {
      return null;
    }
    return { start, end };
  } finally {
    call(span, "free");
  }
}

function normalizeKind(kind) {
  return typeof kind === "string" ? kind.replace(/[\s_-]/g, "").toLowerCase() : kind;
}

function readSuggestion(suggestion, span) {
  const kind = normalizeKind(call(suggestion, "kind"));
  let start = span.start;
  let end = span.end;
  let replacement;

  if (REPLACE.has(kind)) {
    replacement = call(suggestion, "get_replacement_text");
  } else if (REMOVE.has(kind)) {
    replacement = "";
  } else if (INSERT_AFTER.has(kind)) {
    start = span.end;
    end = span.end;
    replacement = call(suggestion, "get_replacement_text");
  } else {
    return null;
  }

  return typeof replacement === "string" ? { start, end, replacement } : null;
}

function readType(lint) {
  const kind = call(lint, "lint_kind");
  return typeof kind === "string" && kind.trim() ? kind.trim().toLowerCase() : "miscellaneous";
}

function readMessage(lint) {
  const message = call(lint, "message");
  return typeof message === "string" ? message : "";
}

// One Harper lint normally has suggestions of one kind. If it contains mixed
// replacement and insertion spans, split those into separate canonical issues:
// alternatives on one issue must always splice the same source span.
export function normalizeHarperLints(text, lints, rule = null) {
  if (typeof text !== "string" || !Array.isArray(lints)) return [];
  const issues = [];

  lints.forEach((lint, lintIndex) => {
    const span = readSpan(text, lint);
    if (!span) return;

    const rawSuggestions = call(lint, "suggestions");
    const suggestions = [];
    if (Array.isArray(rawSuggestions)) {
      for (const item of rawSuggestions) {
        try {
          const copied = readSuggestion(item, span);
          if (copied) suggestions.push(copied);
        } finally {
          call(item, "free");
        }
      }
    }
    const groups = new Map();
    for (const suggestion of suggestions) {
      const key = `${suggestion.start}:${suggestion.end}`;
      if (!groups.has(key)) groups.set(key, []);
      const replacements = groups.get(key);
      if (!replacements.includes(suggestion.replacement)) replacements.push(suggestion.replacement);
    }

    const common = { types: [readType(lint)], explanation: readMessage(lint), ...(rule ? { rule } : {}) };
    if (groups.size === 0) {
      issues.push({
        startIndex: span.start,
        endIndex: span.end,
        correction: null,
        suggestions: [],
        ...common,
        _order: lintIndex,
      });
      return;
    }

    let groupIndex = 0;
    for (const [key, replacements] of groups) {
      const [startIndex, endIndex] = key.split(":").map(Number);
      issues.push({
        startIndex,
        endIndex,
        correction: replacements[0],
        suggestions: replacements.map((replacement) => ({ replacement })),
        ...common,
        _order: lintIndex + groupIndex / 1000,
      });
      groupIndex += 1;
    }
  });

  return issues
    .sort((a, b) => a.startIndex - b.startIndex || a.endIndex - b.endIndex || a._order - b._order)
    .map(({ _order, ...issue }) => issue);
}

// organizedLints retains Harper's normal deduplication while naming each rule.
export function normalizeOrganizedHarperLints(text, groups) {
  return Object.entries(groups).flatMap(([rule, lints]) => normalizeHarperLints(text, lints, rule))
    .sort((a, b) => a.startIndex - b.startIndex || a.endIndex - b.endIndex);
}
