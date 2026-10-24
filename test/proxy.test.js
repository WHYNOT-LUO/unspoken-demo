// Live mode against a fake OpenAI-compatible model server (no real API key needed).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startApp } from "./helpers.js";

let upstream;
let app;
let cookie;
let received;
let upstreamStatus = 200;

before(async () => {
  upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received = { url: req.url, auth: req.headers.authorization, body: JSON.parse(body) };
      if (upstreamStatus !== 200) {
        res.writeHead(upstreamStatus, { "content-type": "application/json" });
        return res.end('{"error":"bad key"}');
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"根据资料"}}]}\n\n');
      res.end('data: {"choices":[{"delta":{"content":" [1]"}}]}\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));

  app = await startApp({
    mock: false,
    llm: { baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: "sk-test", model: "test-model", maxTokens: 100 },
  });
  cookie = await app.signUp("proxy@test.dev");
});

after(async () => {
  await app.close();
  upstream.close();
});

const chat = () =>
  app.call("/api/chat", {
    method: "POST",
    cookie,
    body: { question: "为什么？", history: [], sources: [{ title: "课", text: "内容" }] },
  });

test("status reports the live model", async () => {
  assert.deepEqual(await (await app.call("/api/status")).json(), { mock: false, model: "test-model" });
});

test("proxies to /chat/completions with the server-side key and streams the reply back", async () => {
  upstreamStatus = 200;
  const res = await chat();
  const text = await res.text();
  assert.equal(received.url, "/v1/chat/completions");
  assert.equal(received.auth, "Bearer sk-test");
  assert.equal(received.body.model, "test-model");
  assert.equal(received.body.stream, true);
  assert.equal(received.body.messages[0].role, "system");
  assert.match(received.body.messages.at(-1).content, /《课》/);
  assert.match(text, /根据资料/);
  assert.match(text, /\[DONE\]/);
});

test("a model error becomes a friendly 502 without leaking details", async () => {
  upstreamStatus = 401;
  const res = await chat();
  assert.equal(res.status, 502);
  const data = await res.json();
  assert.equal(data.error, "model");
  assert.doesNotMatch(JSON.stringify(data), /bad key/);
});

test("assist goes to the model with the writing-assistant instructions", async () => {
  upstreamStatus = 200;
  const res = await app.call("/api/assist", {
    method: "POST",
    cookie,
    body: { task: "points", text: "今天和妈妈吵架了", role: "student" },
  });
  await res.text();
  assert.equal(res.status, 200);
  assert.match(received.body.messages[0].content, /写作助手/);
  assert.match(received.body.messages.at(-1).content, /今天和妈妈吵架了/);
});
