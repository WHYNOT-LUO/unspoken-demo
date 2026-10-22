import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { STRINGS, t, setLang, detectLang } from "../public/js/i18n.js";
import { TEMPLATES } from "../public/js/templates.js";

test("both languages have exactly the same keys", () => {
  assert.deepEqual(Object.keys(STRINGS.en).sort(), Object.keys(STRINGS.zh).sort());
});

test("every key used by the app and page exists", () => {
  const sources = ["../public/js/app.js", "../public/index.html"].map((p) => readFileSync(new URL(p, import.meta.url), "utf8"));
  const used = new Set();
  for (const src of sources) {
    for (const m of src.matchAll(/\bt\("([\w.]+)"/g)) used.add(m[1]);
    for (const m of src.matchAll(/data-i18n(?:-[a-z]+)?="([\w.]+)"/g)) used.add(m[1]);
  }
  const missing = [...used].filter((k) => !(k in STRINGS.zh));
  assert.deepEqual(missing, []);
});

test("placeholders match between languages", () => {
  const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const key of Object.keys(STRINGS.zh)) {
    assert.deepEqual(vars(STRINGS.en[key]), vars(STRINGS.zh[key]), key);
  }
});

test("t fills placeholders in the current language", () => {
  setLang("en");
  assert.equal(t("courses.progress", { done: 2, total: 7 }), "Completed 2 / 7");
  setLang("zh");
  assert.equal(t("courses.progress", { done: 2, total: 7 }), "已学完 2 / 7");
});

test("detectLang prefers the saved choice, then the browser language", () => {
  assert.equal(detectLang("en", ["zh-CN"]), "en");
  assert.equal(detectLang(null, ["zh-CN"]), "zh");
  assert.equal(detectLang(null, ["en-US"]), "en");
  assert.equal(detectLang(null, []), "zh");
});

test("every template has both languages", () => {
  for (const tpl of TEMPLATES) {
    for (const lang of ["zh", "en"]) assert.ok(tpl[lang].title && tpl[lang].body, `${tpl.id} ${lang}`);
  }
});
