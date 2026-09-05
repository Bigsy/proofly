import { parseRuleOverrides } from "./harper-rules.js";

export const PROOFING_SETTINGS_KEY = "proofingSettings";
export const DEFAULT_PROOFING_SETTINGS = Object.freeze({ dialect: "auto" });
export const DIALECT_OPTIONS = Object.freeze([
  "auto", "american", "british", "australian", "canadian", "indian",
]);

export function parseProofingSettings(value) {
  const dialect = typeof value?.dialect === "string" ? value.dialect.toLowerCase() : "auto";
  const rules = parseRuleOverrides(value?.ruleOverrides);
  return {
    dialect: DIALECT_OPTIONS.includes(dialect) ? dialect : "auto",
    ...(Object.keys(rules).length ? { ruleOverrides: rules } : {}),
  };
}

export function resolveDialect(settings, locale = "") {
  const { dialect } = parseProofingSettings(settings);
  if (dialect !== "auto") return dialect;
  const region = String(locale).replace("_", "-").split("-")[1]?.toUpperCase();
  return ({ GB: "british", AU: "australian", CA: "canadian", IN: "indian" })[region]
    ?? "american";
}
