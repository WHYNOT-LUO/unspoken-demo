import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApp } from "./helpers.js";

let app;
let cookie;

before(async () => {
  app = await startApp({ limits: { perVisitorPerDay: 7 } });
  cookie = await app.signUp("server@test.dev");
});
after(() => app.close());

const okBody = { question: "为什么会内疚？", history: [], sources: [{ title: "花钱与内疚", text: "父母追问。" }] };
const chat = (body, c = cookie) => app.call("/api/chat", { method: "POST", cookie: c, body });
const assist = (body) => app.call("/api/assist", { method: "POST", cookie, body });

test("status is public and reports test mode", async () => {
  const status = await (await app.call("/api/status")).json();
  assert.equal(status.mock, true);
  assert.equal(status.model, null);
});

test("courses come from the content folder, in Chinese or English", async () => {
  const zh = await (await app.call("/api/courses", { cookie })).json();
  const en = await (await app.call("/api/courses?lang=en", { cookie })).json();
  assert.equal(zh[0].title, "测试课");
  assert.equal(en[0].title, "Test lesson");
});

test("serves the app page without login", async () => {
  const res = await app.call("/");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
});

test("blocks path traversal outside public/", async () => {
  assert.equal((await app.call("/..%2fserver.js")).status, 404);
  assert.equal((await app.call("/..%2fdata%2funspoken.db")).status, 404);
});

test("a malformed URL is a 404, not a server error", async () => {
  assert.equal((await app.call("/%E0%A4%A")).status, 404);
});

test("unknown API paths and wrong methods", async () => {
  assert.equal((await app.call("/api/nope", { cookie })).status, 404);
  assert.equal((await app.call("/api/notes", { method: "POST", cookie, body: {} })).status, 405);
});

test("responses carry security headers", async () => {
  const res = await app.call("/");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.match(res.headers.get("content-security-policy"), /default-src 'self'/);
  assert.match(res.headers.get("content-security-policy"), /frame-ancestors 'none'/);
});

test("chat in test mode streams a clearly labelled reply", async () => {
  const res = await chat(okBody);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  const text = await res.text();
  assert.match(text, /测试模式/);
  assert.match(text, /\[DONE\]/);
});

test("test-mode reply follows the requested language", async () => {
  assert.match(await (await chat({ ...okBody, lang: "en" })).text(), /Test mode/);
});

test("crisis language is answered with the crisis signal, not the model", async () => {
  assert.deepEqual(await (await chat({ ...okBody, question: "我不想活了" })).json(), { type: "crisis" });
  assert.deepEqual(await (await chat({ ...okBody, question: "I want to kill myself" })).json(), { type: "crisis" });
  assert.deepEqual(await (await assist({ task: "gentle", text: "我想自杀" })).json(), { type: "crisis" });
});

test("a question with no matching material is still answered (from general knowledge)", async () => {
  const res = await chat({ ...okBody, sources: [] });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /一般知识/);
});

test("invalid chat requests are rejected", async () => {
  const nine = Array.from({ length: 9 }, () => ({ title: "t", text: "x" }));
  assert.equal((await chat({ ...okBody, sources: nine })).status, 400);
  assert.equal((await chat({ ...okBody, sources: "none" })).status, 400);
  assert.equal((await chat({ ...okBody, role: "admin" })).status, 400);
  assert.equal((await chat({ ...okBody, lang: "fr" })).status, 400);
  assert.equal((await assist({ task: "anything", text: "x" })).status, 400);
  assert.equal((await assist({ task: "gentle", text: "  " })).status, 400);
});

test("oversized requests are rejected", async () => {
  const res = await chat({ ...okBody, history: [{ role: "user", content: "字".repeat(60000) }] });
  assert.equal(res.status, 413);
});

test("assist in test mode streams a labelled reply", async () => {
  const res = await assist({ task: "gentle", text: "你们总是不理解我" });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /测试模式/);
});

test("the daily AI limit is per account", async () => {
  let last;
  for (let i = 0; i < 10; i++) last = await chat(okBody);
  assert.equal(last.status, 429);
  assert.deepEqual(await last.json(), { error: "limit" });
  const other = await app.signUp("fresh@test.dev");
  assert.equal((await chat(okBody, other)).status, 200);
});
