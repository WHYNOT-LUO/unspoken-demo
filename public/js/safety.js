// Crisis-language detection. Shared by the browser and the server.
// Deliberately simple and over-sensitive: a false alarm only shows help information.

function normalize(text) {
  return String(text).replace(/[\s\p{P}\p{S}]/gu, "");
}

const HAS_CJK = /\p{Script=Han}/u;

// English: lowercase words separated by single spaces, so keywords match whole words only
// ("rape" must not match "grapes").
function words(text) {
  return ` ${String(text).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
}

/**
 * True when `text` contains any crisis keyword.
 * Chinese keywords ignore spaces and punctuation; English keywords match whole words.
 */
export function detectCrisis(text, keywords) {
  const zh = normalize(text);
  const en = words(text);
  return keywords.some((k) => (HAS_CJK.test(k) ? zh.includes(normalize(k)) : en.includes(words(k))));
}

/** Hotlines that a person has verified and that have a number filled in. */
export function visibleHotlines(hotlines) {
  return hotlines.filter((h) => h.verified === true && String(h.number || "").trim());
}
