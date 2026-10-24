import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword, createThrottle, validEmail } from "../lib/auth.js";
import { startApp } from "./helpers.js";

let app;
before(async () => (app = await startApp()));
after(() => app.close());

test("passwords are hashed with a salt and verified", async () => {
  const a = await hashPassword("s3cret-pass");
  const b = await hashPassword("s3cret-pass");
  assert.notEqual(a, b);
  assert.ok(a.startsWith("scrypt$"));
  assert.equal(await verifyPassword("s3cret-pass", a), true);
  assert.equal(await verifyPassword("wrong-pass", a), false);
});

test("email validation", () => {
  assert.equal(validEmail("a@b.co"), true);
  assert.equal(validEmail("not-an-email"), false);
  assert.equal(validEmail("a b@c.co"), false);
});

test("throttle blocks after too many failures and clears", () => {
  const t = createThrottle({ max: 3, windowMs: 1000 });
  for (let i = 0; i < 3; i++) t.fail("k", 100);
  assert.equal(t.blocked("k", 200), true);
  assert.equal(t.blocked("k", 1200), false);
  t.fail("k", 1300);
  t.clear("k");
  assert.equal(t.blocked("k", 1301), false);
});

test("register needs a valid invite", async () => {
  const res = await app.call("/api/auth/register", {
    method: "POST",
    body: { email: "x@test.dev", password: "long enough pw", invite: "WRONG" },
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "invite_invalid" });
});

test("register rejects short passwords and bad emails", async () => {
  const short = await app.call("/api/auth/register", { method: "POST", body: { email: "y@test.dev", password: "short", invite: "TEST-INVITE" } });
  assert.deepEqual(await short.json(), { error: "weak_password" });
  const bad = await app.call("/api/auth/register", { method: "POST", body: { email: "nope", password: "long enough pw", invite: "TEST-INVITE" } });
  assert.deepEqual(await bad.json(), { error: "bad_email" });
});

test("invite codes work in any letter case", async () => {
  const res = await app.call("/api/auth/register", { method: "POST", body: { email: "case@test.dev", password: "long enough pw", invite: "test-invite" } });
  assert.equal(res.status, 201);
});

test("an invite with one use works exactly once", async () => {
  app.db.createInvite("ONCE", 1, "");
  const body = (email) => ({ email, password: "long enough pw", invite: "ONCE" });
  assert.equal((await app.call("/api/auth/register", { method: "POST", body: body("once1@test.dev") })).status, 201);
  const second = await app.call("/api/auth/register", { method: "POST", body: body("once2@test.dev") });
  assert.deepEqual(await second.json(), { error: "invite_invalid" });
});

test("register logs the user in with an HttpOnly session cookie", async () => {
  const res = await app.call("/api/auth/register", {
    method: "POST",
    body: { email: "Reg@Test.dev", password: "long enough pw", invite: "TEST-INVITE", lang: "en" },
  });
  assert.equal(res.status, 201);
  const setCookie = res.headers.get("set-cookie");
  assert.match(setCookie, /unspoken_session=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  const me = await app.call("/api/me", { cookie: app.sessionCookie(res) });
  assert.deepEqual((await me.json()).user.email, "Reg@Test.dev");
});

test("the same email cannot register twice, whatever its case", async () => {
  await app.signUp("dup@test.dev");
  const res = await app.call("/api/auth/register", { method: "POST", body: { email: "DUP@test.dev", password: "long enough pw", invite: "TEST-INVITE" } });
  assert.equal(res.status, 409);
});

test("login works with the right password and fails with a generic error otherwise", async () => {
  await app.signUp("login@test.dev", "the right password");
  const ok = await app.call("/api/auth/login", { method: "POST", body: { email: "LOGIN@test.dev", password: "the right password" } });
  assert.equal(ok.status, 200);
  const wrong = await app.call("/api/auth/login", { method: "POST", body: { email: "login@test.dev", password: "nope nope nope" } });
  const unknown = await app.call("/api/auth/login", { method: "POST", body: { email: "ghost@test.dev", password: "nope nope nope" } });
  assert.equal(wrong.status, 401);
  assert.deepEqual(await wrong.json(), await unknown.json()); // no hint about which emails exist
});

test("repeated wrong passwords are throttled", async () => {
  await app.signUp("brute@test.dev");
  let last;
  for (let i = 0; i < 9; i++) {
    last = await app.call("/api/auth/login", {
      method: "POST",
      body: { email: "brute@test.dev", password: `guess ${i} guess` },
      headers: { "x-forwarded-for": `10.0.0.${i}` },
    });
  }
  assert.equal(last.status, 429);
});

test("logout ends the session", async () => {
  const cookie = await app.signUp("bye@test.dev");
  assert.ok((await (await app.call("/api/me", { cookie })).json()).user);
  await app.call("/api/auth/logout", { method: "POST", cookie });
  assert.equal((await (await app.call("/api/me", { cookie })).json()).user, null);
  assert.equal((await app.call("/api/notes", { cookie })).status, 401);
});

test("protected routes need a session", async () => {
  assert.deepEqual(await (await app.call("/api/me")).json(), { user: null });
  for (const path of ["/api/courses", "/api/notes", "/api/docs", "/api/progress"]) {
    assert.equal((await app.call(path)).status, 401, path);
  }
  const chat = await app.call("/api/chat", { method: "POST", body: { question: "q", sources: [{ title: "t", text: "x" }] } });
  assert.equal(chat.status, 401);
});

test("a forged session cookie is rejected", async () => {
  assert.deepEqual(await (await app.call("/api/me", { cookie: "unspoken_session=not-a-real-token" })).json(), { user: null });
  assert.equal((await app.call("/api/notes", { cookie: "unspoken_session=not-a-real-token" })).status, 401);
});

test("state changes from another website are refused", async () => {
  const cookie = await app.signUp("csrf@test.dev");
  const res = await app.call("/api/notes/n1", {
    method: "PUT",
    cookie,
    headers: { origin: "https://evil.example" },
    body: { title: "t", body: "b", createdAt: 1, updatedAt: 1 },
  });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "forbidden_origin" });
});

test("profile updates role and language", async () => {
  const cookie = await app.signUp("profile@test.dev");
  const res = await app.call("/api/me", { method: "PATCH", cookie, body: { role: "parent", lang: "en" } });
  const { user } = await res.json();
  assert.equal(user.role, "parent");
  assert.equal(user.lang, "en");
  assert.equal((await (await app.call("/api/me", { cookie })).json()).user.role, "parent");
  assert.equal((await app.call("/api/me", { method: "PATCH", cookie, body: { role: "admin" } })).status, 400);
});

test("changing the password needs the current one and signs out other devices", async () => {
  const phone = await app.signUp("pw@test.dev", "first password");
  const laptopRes = await app.call("/api/auth/login", { method: "POST", body: { email: "pw@test.dev", password: "first password" } });
  const laptop = app.sessionCookie(laptopRes);
  const wrong = await app.call("/api/me/password", { method: "POST", cookie: phone, body: { current: "nope nope", next: "second password" } });
  assert.equal(wrong.status, 401);
  const ok = await app.call("/api/me/password", { method: "POST", cookie: phone, body: { current: "first password", next: "second password" } });
  assert.equal(ok.status, 200);
  assert.ok((await (await app.call("/api/me", { cookie: phone })).json()).user);
  assert.equal((await (await app.call("/api/me", { cookie: laptop })).json()).user, null);
  const login = await app.call("/api/auth/login", { method: "POST", body: { email: "pw@test.dev", password: "second password" } });
  assert.equal(login.status, 200);
});

test("deleting the account removes the user and all their data", async () => {
  const cookie = await app.signUp("delete@test.dev", "delete me please");
  await app.call("/api/notes/n1", { method: "PUT", cookie, body: { title: "t", body: "b", createdAt: 1, updatedAt: 1 } });
  const wrong = await app.call("/api/me", { method: "DELETE", cookie, body: { password: "wrong password" } });
  assert.equal(wrong.status, 401);
  const res = await app.call("/api/me", { method: "DELETE", cookie, body: { password: "delete me please" } });
  assert.equal(res.status, 200);
  assert.equal((await (await app.call("/api/me", { cookie })).json()).user, null);
  assert.equal(app.db.userByEmail("delete@test.dev"), undefined);
  const login = await app.call("/api/auth/login", { method: "POST", body: { email: "delete@test.dev", password: "delete me please" } });
  assert.equal(login.status, 401);
});
