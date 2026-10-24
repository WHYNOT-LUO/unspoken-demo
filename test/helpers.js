// Starts the app on a random port with a fresh database and content folder, for tests.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server.js";
import { openDb } from "../lib/db.js";

export async function startApp({ mock = true, llm = {}, limits = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "unspoken-test-"));
  mkdirSync(join(dir, "content", "courses", "en"), { recursive: true });
  mkdirSync(join(dir, "content", "library"), { recursive: true });
  writeFileSync(join(dir, "content", "courses", "c1.md"), "---\ntitle: 测试课\norder: 1\n---\n测试正文");
  writeFileSync(join(dir, "content", "courses", "en", "c1.md"), "---\ntitle: Test lesson\norder: 1\n---\nTest body");

  const db = openDb(join(dir, "data", "unspoken.db"));
  db.createInvite("TEST-INVITE", 100, "tests");

  const server = createApp({
    contentDir: join(dir, "content"),
    dataDir: join(dir, "data"),
    db,
    mock,
    llm,
    limits: { perVisitorPerDay: 100, sitePerDay: 1000, ...limits },
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  /** fetch with an optional session cookie and JSON body. */
  async function call(path, { method = "GET", body, cookie, headers = {} } = {}) {
    return fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  const sessionCookie = (res) => (res.headers.get("set-cookie") || "").split(";")[0];

  /** Registers a user with the shared invite and returns their session cookie. */
  async function signUp(email, password = "correct horse battery") {
    const res = await call("/api/auth/register", { method: "POST", body: { email, password, invite: "TEST-INVITE" } });
    if (res.status !== 201) throw new Error(`signUp failed: ${res.status} ${await res.text()}`);
    return sessionCookie(res);
  }

  return {
    base,
    db,
    call,
    signUp,
    sessionCookie,
    close: () => new Promise((r) => server.close(() => (db.close(), r()))),
  };
}
