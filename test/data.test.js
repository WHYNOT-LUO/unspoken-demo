import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApp } from "./helpers.js";

let app;
let alice;
let bob;

before(async () => {
  app = await startApp();
  alice = await app.signUp("alice@test.dev");
  bob = await app.signUp("bob@test.dev");
});
after(() => app.close());

const note = (title, body = "body", t = 1000) => ({ title, body, createdAt: t, updatedAt: t });

test("notes are saved, listed, updated and deleted", async () => {
  assert.equal((await app.call("/api/notes/n1", { method: "PUT", cookie: alice, body: note("First") })).status, 200);
  await app.call("/api/notes/n1", { method: "PUT", cookie: alice, body: note("First, edited", "new body", 2000) });
  const list = await (await app.call("/api/notes", { cookie: alice })).json();
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], { id: "n1", title: "First, edited", body: "new body", createdAt: 1000, updatedAt: 2000 });
  assert.equal((await app.call("/api/notes/n1", { method: "DELETE", cookie: alice })).status, 200);
  assert.deepEqual(await (await app.call("/api/notes", { cookie: alice })).json(), []);
});

test("one user can never see or change another user's notes, even with the same id", async () => {
  await app.call("/api/notes/shared", { method: "PUT", cookie: alice, body: note("Alice's private note") });
  await app.call("/api/notes/shared", { method: "PUT", cookie: bob, body: note("Bob's note") });

  const aliceNotes = await (await app.call("/api/notes", { cookie: alice })).json();
  const bobNotes = await (await app.call("/api/notes", { cookie: bob })).json();
  assert.deepEqual(aliceNotes.map((n) => n.title), ["Alice's private note"]);
  assert.deepEqual(bobNotes.map((n) => n.title), ["Bob's note"]);

  // Bob deleting "shared" removes only his own copy.
  await app.call("/api/notes/shared", { method: "DELETE", cookie: bob });
  assert.equal((await (await app.call("/api/notes", { cookie: alice })).json()).length, 1);
});

test("uploaded materials are stored per user", async () => {
  const doc = { title: "Article", name: "article.pdf", text: "Some extracted text", addedAt: 5 };
  assert.equal((await app.call("/api/docs/d1", { method: "PUT", cookie: alice, body: doc })).status, 200);
  assert.deepEqual(await (await app.call("/api/docs", { cookie: alice })).json(), [{ id: "d1", ...doc }]);
  assert.deepEqual(await (await app.call("/api/docs", { cookie: bob })).json(), []);
  assert.equal((await app.call("/api/docs/d1", { method: "DELETE", cookie: bob })).status, 404);
  assert.equal((await app.call("/api/docs/d1", { method: "DELETE", cookie: alice })).status, 200);
});

test("course progress is stored per user", async () => {
  await app.call("/api/progress/01-what-is-emotional-education", { method: "PUT", cookie: alice });
  await app.call("/api/progress/01-what-is-emotional-education", { method: "PUT", cookie: alice }); // twice is fine
  assert.deepEqual(await (await app.call("/api/progress", { cookie: alice })).json(), ["01-what-is-emotional-education"]);
  assert.deepEqual(await (await app.call("/api/progress", { cookie: bob })).json(), []);
  await app.call("/api/progress/01-what-is-emotional-education", { method: "DELETE", cookie: alice });
  assert.deepEqual(await (await app.call("/api/progress", { cookie: alice })).json(), []);
});

test("invalid ids and bodies are rejected", async () => {
  assert.equal((await app.call("/api/notes/bad%20id", { method: "PUT", cookie: alice, body: note("x") })).status, 404);
  assert.equal((await app.call("/api/notes/n2", { method: "PUT", cookie: alice, body: { title: "x" } })).status, 400);
  assert.equal((await app.call("/api/docs/d2", { method: "PUT", cookie: alice, body: { title: "", text: "x", addedAt: 1 } })).status, 400);
  const tooLong = await app.call("/api/notes/n3", { method: "PUT", cookie: alice, body: note("x", "字".repeat(200_001)) });
  assert.equal(tooLong.status, 400);
});

test("a large upload within limits is accepted", async () => {
  const text = "资料".repeat(140_000); // 280,000 characters, ~840 KB of UTF-8
  const res = await app.call("/api/docs/big", { method: "PUT", cookie: alice, body: { title: "Big", text, addedAt: 1 } });
  assert.equal(res.status, 200);
});
