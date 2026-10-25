// Free trial (a few short AI uses) and the paid plan.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startApp } from "./helpers.js";

const chatBody = { question: "为什么会内疚？", history: [], sources: [{ title: "花钱与内疚", text: "父母追问。" }] };
const DAY = 86400_000;

// ---- test mode (no model) ----

let app;
before(async () => (app = await startApp({ billing: { freeUses: 3, price: "¥19 / 30 天", contact: "微信 test" } })));
after(() => app.close());

const chat = (cookie, body = chatBody) => app.call("/api/chat", { method: "POST", cookie, body });
const assist = (cookie, text = "我很生气") => app.call("/api/assist", { method: "POST", cookie, body: { task: "gentle", text } });
const me = async (cookie) => (await (await app.call("/api/me", { cookie })).json()).user;

test("a new account starts with 3 free AI uses and no paid plan", async () => {
  const cookie = await app.signUp("new@test.dev");
  assert.deepEqual((await me(cookie)).plan, { paidUntil: null, freeLeft: 3 });
});

test("questions and AI writing help share the free uses; then payment is required", async () => {
  const cookie = await app.signUp("trial@test.dev");
  assert.equal((await chat(cookie)).status, 200);
  assert.equal((await assist(cookie)).status, 200);
  assert.equal((await chat(cookie)).status, 200);
  assert.equal((await me(cookie)).plan.freeLeft, 0);
  const fourth = await chat(cookie);
  assert.equal(fourth.status, 402);
  assert.deepEqual(await fourth.json(), { error: "payment_required" });
  assert.equal((await assist(cookie)).status, 402);
});

test("crisis messages and invalid requests do not use up the trial", async () => {
  const cookie = await app.signUp("fair@test.dev");
  await chat(cookie, { ...chatBody, question: "我不想活了" });
  await chat(cookie, { ...chatBody, sources: [] });
  await assist(cookie, "我想自杀");
  assert.equal((await me(cookie)).plan.freeLeft, 3);
});

test("a paid plan unlocks AI beyond the trial, and expires", async () => {
  const cookie = await app.signUp("paid@test.dev");
  for (let i = 0; i < 3; i++) await chat(cookie);
  assert.equal((await chat(cookie)).status, 402);

  const user = app.db.userByEmail("paid@test.dev");
  const until = Date.now() + 30 * DAY;
  app.db.setPlanUntil(user.id, until);
  assert.equal((await me(cookie)).plan.paidUntil, until);
  for (let i = 0; i < 5; i++) assert.equal((await chat(cookie)).status, 200);

  app.db.setPlanUntil(user.id, Date.now() - 1000); // expired
  assert.equal((await me(cookie)).plan.paidUntil, null);
  assert.equal((await chat(cookie)).status, 402);
});

test("status tells the app the plan details", async () => {
  const status = await (await app.call("/api/status")).json();
  assert.deepEqual(status.plan, { freeUses: 3, days: 30, dailyLimit: 100, price: "¥19 / 30 天", contact: "微信 test", qr: false });
});

test("the payment QR code is served to signed-in users once the file exists", async () => {
  const cookie = await app.signUp("qr@test.dev");
  assert.equal((await app.call("/api/pay/qr")).status, 401);
  assert.equal((await app.call("/api/pay/qr", { cookie })).status, 404);
  const qrPath = join(app.dataDir, "pay-qr.png");
  writeFileSync(qrPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const res = await app.call("/api/pay/qr", { cookie });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.equal((await (await app.call("/api/status")).json()).plan.qr, true);
});

// ---- live mode against a fake model ----

let upstream;
let live;
let received;
let upstreamStatus = 200;

before(async () => {
  upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received = JSON.parse(body);
      if (upstreamStatus !== 200) {
        res.writeHead(upstreamStatus);
        return res.end("{}");
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  live = await startApp({
    mock: false,
    llm: { baseUrl: `http://127.0.0.1:${upstream.address().port}`, apiKey: "k", model: "m", maxTokens: 800 },
    billing: { freeUses: 3, freeMaxTokens: 250 },
  });
});
after(async () => {
  await live.close();
  upstream.close();
});

const liveChat = (cookie) => live.call("/api/chat", { method: "POST", cookie, body: chatBody });

test("free answers are short: smaller token budget and a brevity instruction", async () => {
  const cookie = await live.signUp("short@test.dev");
  upstreamStatus = 200;
  await (await liveChat(cookie)).text();
  assert.equal(received.max_tokens, 250);
  assert.match(received.messages.at(-1).content, /【篇幅】/);
});

test("paid answers use the full token budget without the brevity instruction", async () => {
  const cookie = await live.signUp("long@test.dev");
  live.db.setPlanUntil(live.db.userByEmail("long@test.dev").id, Date.now() + DAY);
  upstreamStatus = 200;
  await (await liveChat(cookie)).text();
  assert.equal(received.max_tokens, 800);
  assert.doesNotMatch(received.messages.at(-1).content, /【篇幅】/);
});

test("a model error gives the free use back", async () => {
  const cookie = await live.signUp("refund@test.dev");
  upstreamStatus = 500;
  assert.equal((await liveChat(cookie)).status, 502);
  const user = (await (await live.call("/api/me", { cookie })).json()).user;
  assert.equal(user.plan.freeLeft, 3);
});
