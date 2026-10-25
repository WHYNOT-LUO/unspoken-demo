import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDocs } from "../lib/content.js";
import { buildIndex, search } from "../public/js/retrieval.js";
import { STRINGS } from "../public/js/i18n.js";

const LIB = join(fileURLToPath(new URL("..", import.meta.url)), "content", "library");
const zh = loadDocs(LIB);
const en = loadDocs(join(LIB, "en"));
const COURSES = join(LIB, "..", "courses");

test("every reference document has an English version with the same id and collection", () => {
  assert.deepEqual(
    en.map((d) => [d.id, d.group]),
    zh.map((d) => [d.id, d.group])
  );
});

test("every reference collection has a name and a source/licence note in both languages", () => {
  for (const group of new Set(zh.map((d) => d.group).filter(Boolean))) {
    for (const lang of ["zh", "en"]) {
      assert.ok(STRINGS[lang][`lib.group.${group}`], `${lang} lib.group.${group}`);
      assert.ok(STRINGS[lang][`lib.credit.${group}`], `${lang} lib.credit.${group}`);
    }
  }
});

test("reference documents carry no foreign helpline numbers or web links", () => {
  // Only the human-checked hotlines in config/safety.json may be shown.
  for (const d of [...zh, ...en]) {
    assert.doesNotMatch(d.text, /\b(988|911|741741)\b|1-800|https?:\/\/|www\./, d.id);
  }
});

// Search over the real lessons and library, as the app does with "Answer from: everything".
function realIndex(lang) {
  const courses = loadDocs(lang === "en" ? join(COURSES, "en") : COURSES);
  return buildIndex([
    ...courses.map((d) => ({ id: `course:${d.id}`, title: d.title, text: d.text })),
    ...(lang === "en" ? en : zh).map((d) => ({ id: `library:${d.id}`, title: d.title, text: d.text })),
  ]);
}

test("off-topic questions find nothing in the real material", () => {
  const index = { zh: realIndex("zh"), en: realIndex("en") };
  for (const q of ["今天天气怎么样", "今天吃什么", "我想买手机", "怎么学好数学"]) assert.deepEqual(search(index.zh, q), [], q);
  for (const q of ["What is the weather like today?", "How do I cook pasta?", "What's the capital of France?"]) {
    assert.deepEqual(search(index.en, q), [], q);
  }
});

test("everyday questions find the right part of the real material", () => {
  const zhIndex = realIndex("zh");
  const enIndex = realIndex("en");
  const top = (index, q) => search(index, q)[0]?.docId;
  assert.equal(top(zhIndex, "什么是依恋"), "library:openstax-9-3-stages-of-development");
  assert.equal(top(zhIndex, "孩子被同学霸凌怎么办"), "library:openstax-12-6-aggression");
  assert.equal(top(zhIndex, "什么是心流"), "library:openstax-14-5-the-pursuit-of-happiness");
  assert.ok(search(zhIndex, "孩子早恋了怎么办").some((h) => h.docId === "course:06-why-slow-down-on-dating"));
  assert.equal(top(enIndex, "What is attachment?"), "library:openstax-9-3-stages-of-development");
  assert.equal(top(enIndex, "My kid is being bullied"), "library:openstax-12-6-aggression");
});
