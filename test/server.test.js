import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server.js";

let server;
let base;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "unspoken-content-"));
  mkdirSync(join(dir, "courses"));
  mkdirSync(join(dir, "library"));
  writeFileSync(join(dir, "courses", "c1.md"), "---\ntitle: 测试课\norder: 1\n---\n测试正文");
  mkdirSync(join(dir, "courses", "en"));
  writeFileSync(join(dir, "courses", "en", "c1.md"), "---\ntitle: Test lesson\norder: 1\n---\nTest body");
  server = createApp({
    contentDir: dir,
    mock: true,
    llm: {},
    limits: { perVisitorPerDay: 7, sitePerDay: 100 },
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const chat = (body) =>
  fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const okBody = { question: "为什么会内疚？", history: [], sources: [{ title: "花钱与内疚", text: "父母追问。" }] };

test("status reports test mode", async () => {
  assert.deepEqual(await (await fetch(`${base}/api/status`)).json(), { mock: true, model: null });
});

test("courses come from the content folder", async () => {
  const courses = await (await fetch(`${base}/api/courses`)).json();
  assert.equal(courses.length, 1);
  assert.equal(courses[0].title, "测试课");
});

test("serves the app page", async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
});

test("blocks path traversal outside public/", async () => {
  const res = await fetch(`${base}/..%2fserver.js`);
  assert.equal(res.status, 404);
});

test("chat in test mode streams a clearly labelled reply", async () => {
  const res = await chat(okBody);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  const text = await res.text();
  assert.match(text, /测试模式/);
  assert.match(text, /\[DONE\]/);
});

test("crisis language is answered with the crisis signal, not the model", async () => {
  const res = await chat({ ...okBody, question: "我不想活了" });
  assert.deepEqual(await res.json(), { type: "crisis" });
});

test("requests without sources are rejected", async () => {
  const res = await chat({ ...okBody, sources: [] });
  assert.equal(res.status, 400);
});

test("oversized requests are rejected", async () => {
  const res = await chat({ ...okBody, history: [{ role: "user", content: "字".repeat(60000) }] });
  assert.equal(res.status, 413);
});


const assist = (body) =>
  fetch(`${base}/api/assist`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("assist in test mode streams a labelled reply", async () => {
  const res = await assist({ task: "gentle", text: "你们总是不理解我" });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /测试模式/);
});

test("assist rejects unknown tasks and empty text", async () => {
  assert.equal((await assist({ task: "anything", text: "x" })).status, 400);
  assert.equal((await assist({ task: "gentle", text: "  " })).status, 400);
});

test("assist sends crisis language to the safety message, not the model", async () => {
  assert.deepEqual(await (await assist({ task: "gentle", text: "我想自杀" })).json(), { type: "crisis" });
});

test("chat rejects an unknown role", async () => {
  assert.equal((await chat({ ...okBody, role: "admin" })).status, 400);
});

test("courses are served in English when asked", async () => {
  const en = await (await fetch(`${base}/api/courses?lang=en`)).json();
  assert.equal(en[0].title, "Test lesson");
});

test("chat rejects an unknown language", async () => {
  assert.equal((await chat({ ...okBody, lang: "fr" })).status, 400);
});

test("English crisis language is caught by the server", async () => {
  assert.deepEqual(await (await chat({ ...okBody, question: "I want to kill myself" })).json(), { type: "crisis" });
});

test("test-mode reply follows the requested language", async () => {
  assert.match(await (await chat({ ...okBody, lang: "en" })).text(), /Test mode/);
});

test("a malformed URL is a 404, not a server error", async () => {
  assert.equal((await fetch(`${base}/%E0%A4%A`)).status, 404);
});

test("responses carry security headers", async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  const csp = res.headers.get("content-security-policy");
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
});

test("daily visitor limit returns 429", async () => {
  let last;
  for (let i = 0; i < 10; i++) last = await chat(okBody);
  assert.equal(last.status, 429);
});
