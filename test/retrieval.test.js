import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenize, contentTokens, chunkText, buildIndex, search, isFollowUp } from "../public/js/retrieval.js";

test("tokenize splits Chinese into bigrams and Latin into lowercase words", () => {
  assert.deepEqual(tokenize("情绪教育"), ["情绪", "绪教", "教育"]);
  assert.deepEqual(tokenize("MBTI test"), ["mbti", "test"]);
  assert.deepEqual(tokenize("家长 MBTI"), ["家长", "mbti"]);
});

test("tokenize treats punctuation as a boundary", () => {
  assert.deepEqual(tokenize("父母，孩子"), ["父母", "孩子"]);
});

test("chunkText keeps short text as one chunk", () => {
  assert.deepEqual(chunkText("短文本。"), ["短文本。"]);
});

test("chunkText splits long text into bounded chunks covering all content", () => {
  const para = "这是一段关于情绪表达的内容。".repeat(40); // ~560 chars
  const text = `${para}\n\n${para}`;
  const chunks = chunkText(text, { size: 400, overlap: 60 });
  assert.ok(chunks.length >= 3);
  for (const c of chunks) assert.ok(c.length <= 400, `chunk too long: ${c.length}`);
  assert.ok(text.endsWith(chunks.at(-1).slice(-20)));
});

const docs = [
  { id: "a", title: "花钱与内疚", text: "孩子每次花钱，父母都追问钱去了哪里，孩子会感到内疚。" },
  { id: "b", title: "早恋", text: "为什么很多人不建议过早恋爱？在恋爱中如何保护自己的权利。" },
  { id: "c", title: "集体主义", text: "在集体主义框架下，个人的情绪表达可能被视为对群体的威胁。" },
];

test("search ranks the chunk that matches the question first", () => {
  const index = buildIndex(docs);
  const hits = search(index, "父母追问花钱让孩子内疚怎么办");
  assert.equal(hits[0].docId, "a");
  assert.equal(hits[0].title, "花钱与内疚");
});

test("search returns nothing when the question is unrelated to the materials", () => {
  const index = buildIndex(docs);
  assert.deepEqual(search(index, "今天天气怎么样"), []);
});

test("search ignores filler words like 什么 and 怎么", () => {
  const index = buildIndex([{ id: "x", title: "t", text: "什么怎么为什么可以我们" }]);
  assert.deepEqual(search(index, "为什么我们可以怎么样"), []);
});

test("isFollowUp recognises short follow-up questions only", () => {
  assert.equal(isFollowUp("那具体怎么做？"), true);
  assert.equal(isFollowUp("为什么呢"), true);
  assert.equal(isFollowUp("孩子呢？"), true);
  assert.equal(isFollowUp("今天天气怎么样"), false);
  assert.equal(isFollowUp("那么父母追问孩子花钱的时候孩子应该怎么回应才好"), false);
});

test("search limits results to topK", () => {
  const many = Array.from({ length: 10 }, (_, i) => ({
    id: `d${i}`, title: `t${i}`, text: `情绪表达练习第${i}课`,
  }));
  assert.equal(search(buildIndex(many), "情绪表达", { topK: 3 }).length, 3);
});

test("English tokens drop filler words and reduce simple word endings", () => {
  assert.deepEqual(contentTokens("What are the parents asking?"), ["parent", "ask"]);
  assert.deepEqual(contentTokens("feelings worries"), ["feel", "worry"]);
});

test("English search finds the matching lesson", () => {
  const index = buildIndex([
    { id: "money", title: "Money and guilt", text: "Every time a child spends money, parents ask where it went. The child feels guilty." },
    { id: "dating", title: "Dating early", text: "Why many adults advise against dating too early, and how to protect yourself." },
  ]);
  assert.equal(search(index, "Why do I feel guilty when my parents ask about money?")[0].docId, "money");
  assert.deepEqual(search(index, "What is the weather like today?"), []);
});

test("isFollowUp recognises short English follow-ups", () => {
  assert.equal(isFollowUp("And what about parents?"), true);
  assert.equal(isFollowUp("Why?"), true);
  assert.equal(isFollowUp("How do I explain my feelings to my mother without starting an argument?"), false);
});

test("English documents are split into longer passages than Chinese ones", () => {
  const en = "Healthy relationships feel safe and respectful. ".repeat(30); // ~1400 chars
  const zh = "健康的关系让人感到安全和被尊重。".repeat(60); // ~960 chars
  const index = buildIndex([{ id: "en", title: "en", text: en }, { id: "zh", title: "zh", text: zh }]);
  const longest = (id) => Math.max(...index.chunks.filter((c) => c.docId === id).map((c) => c.text.length));
  assert.ok(longest("en") > 400 && longest("en") <= 900);
  assert.ok(longest("zh") <= 400);
});
