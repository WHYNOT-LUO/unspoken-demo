// Crisis-language detection. Shared by the browser and the server.
// Deliberately simple and over-sensitive: a false alarm only shows help information.

function normalize(text) {
  return String(text).replace(/[\s\p{P}\p{S}]/gu, "");
}

/** True when `text` contains any crisis keyword, ignoring spaces and punctuation. */
export function detectCrisis(text, keywords) {
  const t = normalize(text);
  return keywords.some((k) => t.includes(normalize(k)));
}

/** Hotlines that a person has verified and that have a number filled in. */
export function visibleHotlines(hotlines) {
  return hotlines.filter((h) => h.verified === true && String(h.number || "").trim());
}
