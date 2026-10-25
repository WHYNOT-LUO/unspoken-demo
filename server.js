// Unspoken server: static app, accounts, per-user data, course content, and the AI model proxy.
// The API key stays on the server; the browser never sees it.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, resolve, sep, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./lib/config.js";
import { loadLocalized } from "./lib/content.js";
import { buildMessages, buildAssistMessages, ASSIST_TASKS, ROLES, LANGS } from "./lib/prompt.js";
import { createLimiter } from "./lib/ratelimit.js";
import { openDb } from "./lib/db.js";
import {
  SESSION_COOKIE,
  SESSION_DAYS,
  hashPassword,
  verifyPassword,
  newSessionToken,
  hashToken,
  validEmail,
  validPassword,
  createThrottle,
} from "./lib/auth.js";
import { detectCrisis } from "./public/js/safety.js";

const APP_DIR = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(APP_DIR, "public");
const SAFETY = JSON.parse(readFileSync(join(PUBLIC_DIR, "config/safety.json"), "utf8"));

const KB = 1024;
const MAX_QUESTION = 1000;
const MAX_SOURCES = 8;
const MAX_SOURCE_CHARS = 2000;
const MAX_ASSIST_CHARS = 3000;
const LIMITS = {
  noteTitle: 200,
  noteBody: 200_000,
  notesPerUser: 2000,
  docTitle: 200,
  docText: 300_000,
  docsPerUser: 50,
};
const ID = /^[\w-]{1,64}$/;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".bcmap": "application/octet-stream",
};

// Defence in depth on top of DOMPurify: only same-origin scripts, styles, workers and requests.
const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function sendJson(res, status, data) {
  res.writeHead(status, { "content-type": MIME[".json"], "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}

function readBody(req, maxBytes) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const parts = [];
    req.on("data", (c) => {
      size += c.length;
      if (size <= maxBytes) return parts.push(c);
      // Reject at once but keep draining a little, so the client still receives the 413.
      reject(new HttpError(413, "too_large"));
      if (size > 10 * maxBytes) req.destroy();
    });
    req.on("end", () => resolveBody(Buffer.concat(parts).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJson(req, maxBytes = 100 * KB) {
  const text = await readBody(req, maxBytes);
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new HttpError(400, "bad_request");
  }
}

function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* ignore malformed cookies */
    }
  }
  return out;
}

/** The visitor's address; behind Cloudflare, cf-connecting-ip is set by Cloudflare and cannot be forged. */
function clientAddress(req) {
  return String(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || req.socket.remoteAddress)
    .split(",")[0]
    .trim();
}

const isString = (v, max) => typeof v === "string" && v.length <= max;
const isTime = (v) => Number.isSafeInteger(v) && v > 0;
const validRole = (role) => role === undefined || role === "" || Object.hasOwn(ROLES, role);
const validLang = (lang) => lang === undefined || lang === "" || LANGS.includes(lang);

function validateChat(body) {
  const { question, history = [], sources, role, lang } = body;
  if (!validRole(role) || !validLang(lang)) return false;
  if (typeof question !== "string" || !question.trim() || question.length > MAX_QUESTION) return false;
  if (!Array.isArray(sources) || sources.length === 0 || sources.length > MAX_SOURCES) return false;
  if (!sources.every((s) => isString(s?.title, 500) && isString(s?.text, MAX_SOURCE_CHARS))) return false;
  return Array.isArray(history);
}

function validateAssist(body) {
  const { task, text, role, lang } = body;
  if (!validRole(role) || !validLang(lang)) return false;
  if (!Object.hasOwn(ASSIST_TASKS, task)) return false;
  return typeof text === "string" && text.trim() !== "" && text.length <= MAX_ASSIST_CHARS;
}

// ---------- model streaming ----------

function sse(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
}

const delta = (text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;

function mockChatLines({ sources, lang }) {
  if (lang === "en") {
    return [
      "[Test mode: no AI model connected. This is not a real answer.]\n\n",
      `Found ${sources.length} passage(s) for this question:\n\n`,
      ...sources.map((s, i) => `- [${i + 1}] “${s.title}”\n`),
      "\nOnce a model is connected, the AI answers only from these passages and cites them by number.",
    ];
  }
  return [
    "【测试模式：未连接 AI 模型，以下不是真实回答】\n\n",
    `系统为这个问题找到了 ${sources.length} 段资料：\n\n`,
    ...sources.map((s, i) => `- [${i + 1}] 《${s.title}》\n`),
    "\n连接模型后，AI 会只根据这些资料作答，并标注来源编号。",
  ];
}

function mockAssistLines({ task, text, lang }) {
  if (lang === "en") {
    return [
      "[Test mode: no AI model connected. This is not a real result.]\n\n",
      `Received ${text.length} characters for the task “${task}”.\n\n`,
      "Once a model is connected, the AI's rewritten text appears here.",
    ];
  }
  return [
    "【测试模式：未连接 AI 模型，以下不是真实回答】\n\n",
    `收到 ${text.length} 字，任务是“${ASSIST_TASKS[task].label}”。\n\n`,
    "连接模型后，这里会显示 AI 处理后的文字。",
  ];
}

async function streamMock(res, lines) {
  sse(res);
  for (const line of lines) {
    res.write(delta(line));
    await new Promise((r) => setTimeout(r, 40));
  }
  res.end("data: [DONE]\n\n");
}

/** Streams the model's reply. `onFail` runs if the model cannot be reached or returns an error. */
async function streamModel(res, llm, messages, { maxTokens = llm.maxTokens, onFail = () => {} } = {}) {
  const controller = new AbortController();
  res.on("close", () => controller.abort());
  let upstream;
  try {
    upstream = await fetch(`${llm.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${llm.apiKey}` },
      body: JSON.stringify({ model: llm.model, messages, stream: true, temperature: 0.3, max_tokens: maxTokens }),
      signal: controller.signal,
    });
  } catch (err) {
    console.error("model request failed:", err.message);
    onFail();
    return sendJson(res, 502, { error: "model" });
  }
  if (!upstream.ok) {
    console.error("model error:", upstream.status, (await upstream.text()).slice(0, 500));
    onFail();
    return sendJson(res, 502, { error: "model" });
  }
  sse(res);
  try {
    for await (const chunk of upstream.body) res.write(chunk);
  } catch (err) {
    if (!controller.signal.aborted) console.error("model stream broke:", err.message);
  }
  res.end();
}

// ---------- app ----------

export function createApp(config) {
  const dataDir = isAbsolute(config.dataDir) ? config.dataDir : join(APP_DIR, config.dataDir);
  const db = config.db || openDb(join(dataDir, "unspoken.db"));
  const contentDir = isAbsolute(config.contentDir) ? config.contentDir : join(APP_DIR, config.contentDir);
  const aiLimiter = createLimiter({ perKey: config.limits.perVisitorPerDay, global: config.limits.sitePerDay });
  const loginThrottle = createThrottle();

  // ----- sessions -----

  function currentUser(req) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) return null;
    const tokenHash = hashToken(token);
    const user = db.sessionUser(tokenHash);
    return user ? { ...user, tokenHash } : null;
  }

  function cookie(req, value, maxAgeSeconds) {
    const secure = config.secureCookies || req.headers["x-forwarded-proto"] === "https";
    return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
  }

  function startSession(req, res, userId) {
    const token = newSessionToken();
    db.insertSession(hashToken(token), userId, Date.now() + SESSION_DAYS * 86400_000);
    res.setHeader("set-cookie", cookie(req, token, SESSION_DAYS * 86400));
  }

  const billing = config.billing || { freeUses: Infinity, freeMaxTokens: config.llm?.maxTokens, planDays: 30, price: "", contact: "" };
  const qrFile = join(dataDir, "pay-qr.png");
  const isPaid = (u) => u.plan_until > Date.now();

  const publicUser = (u) => ({
    email: u.email,
    role: u.role,
    lang: u.lang,
    createdAt: u.created_at,
    plan: {
      paidUntil: isPaid(u) ? u.plan_until : null,
      freeLeft: Math.max(0, billing.freeUses - u.free_ai_used),
    },
  });

  const publicStatus = () => ({
    mock: config.mock,
    model: config.mock ? null : config.llm.model,
    plan: {
      freeUses: billing.freeUses,
      days: billing.planDays,
      dailyLimit: config.limits.perVisitorPerDay,
      price: billing.price,
      contact: billing.contact,
      qr: existsSync(qrFile),
    },
  });

  // ----- auth routes -----

  async function register(req, res) {
    const { email, password, invite, lang } = await readJson(req);
    if (!validEmail(email)) throw new HttpError(400, "bad_email");
    if (!validPassword(password)) throw new HttpError(400, "weak_password");
    if (!isString(invite, 100) || !invite.trim()) throw new HttpError(400, "invite_invalid");
    const passwordHash = await hashPassword(password);
    const result = db.registerWithInvite({
      email: email.trim(),
      passwordHash,
      lang: validLang(lang) ? lang || "" : "",
      invite: invite.trim().toUpperCase(), // codes are created in upper case; accept any case
    });
    if (result.error) throw new HttpError(result.error === "email_taken" ? 409 : 400, result.error);
    startSession(req, res, result.userId);
    sendJson(res, 201, { user: publicUser(db.userById(result.userId)) });
  }

  async function login(req, res) {
    const { email, password } = await readJson(req);
    if (typeof email !== "string" || typeof password !== "string") throw new HttpError(400, "bad_request");
    const emailKey = `email:${email.trim().toLowerCase()}`;
    const ipKey = `ip:${clientAddress(req)}`;
    if (loginThrottle.blocked(emailKey) || loginThrottle.blocked(ipKey)) throw new HttpError(429, "too_many_attempts");
    const user = db.userByEmail(email.trim());
    // Hash even for unknown emails so the response time does not reveal which emails exist.
    const ok = user ? await verifyPassword(password, user.password_hash) : (await hashPassword(password), false);
    if (!ok) {
      loginThrottle.fail(emailKey);
      loginThrottle.fail(ipKey);
      throw new HttpError(401, "bad_credentials");
    }
    loginThrottle.clear(emailKey);
    startSession(req, res, user.id);
    sendJson(res, 200, { user: publicUser(user) });
  }

  function logout(req, res, user) {
    if (user) db.deleteSession(user.tokenHash);
    res.setHeader("set-cookie", cookie(req, "", 0));
    sendJson(res, 200, { ok: true });
  }

  async function updateMe(req, res, user) {
    const { role = user.role, lang = user.lang } = await readJson(req);
    if (!validRole(role) || !validLang(lang)) throw new HttpError(400, "bad_request");
    db.updateProfile(user.id, { role, lang });
    sendJson(res, 200, { user: publicUser(db.userById(user.id)) });
  }

  async function changePassword(req, res, user) {
    const { current, next } = await readJson(req);
    if (typeof current !== "string" || !(await verifyPassword(current, user.password_hash))) {
      throw new HttpError(401, "bad_credentials");
    }
    if (!validPassword(next)) throw new HttpError(400, "weak_password");
    db.updatePassword(user.id, await hashPassword(next));
    db.deleteOtherSessions(user.id, user.tokenHash); // sign out every other device
    sendJson(res, 200, { ok: true });
  }

  async function deleteMe(req, res, user) {
    const { password } = await readJson(req);
    if (typeof password !== "string" || !(await verifyPassword(password, user.password_hash))) {
      throw new HttpError(401, "bad_credentials");
    }
    db.deleteUser(user.id); // notes, uploads, progress and sessions go with it
    res.setHeader("set-cookie", cookie(req, "", 0));
    sendJson(res, 200, { ok: true });
  }

  // ----- user data routes -----

  const noteOut = (n) => ({ id: n.id, title: n.title, body: n.body, createdAt: n.created_at, updatedAt: n.updated_at });
  const docOut = (d) => ({ id: d.id, title: d.title, name: d.name, text: d.text, addedAt: d.added_at });

  async function putNote(req, res, user, id) {
    const n = await readJson(req, 1024 * KB);
    if (!isString(n.title, LIMITS.noteTitle) || !isString(n.body, LIMITS.noteBody)) throw new HttpError(400, "bad_request");
    if (!isTime(n.createdAt) || !isTime(n.updatedAt)) throw new HttpError(400, "bad_request");
    const isNew = !db.noteExists(user.id, id);
    if (isNew && db.countNotes(user.id) >= LIMITS.notesPerUser) throw new HttpError(409, "too_many_items");
    db.upsertNote(user.id, { id, title: n.title, body: n.body, createdAt: n.createdAt, updatedAt: n.updatedAt });
    sendJson(res, 200, { ok: true });
  }

  async function putDoc(req, res, user, id) {
    const d = await readJson(req, 2048 * KB);
    if (!isString(d.title, LIMITS.docTitle) || !d.title || !isString(d.name ?? "", 255)) throw new HttpError(400, "bad_request");
    if (!isString(d.text, LIMITS.docText) || !d.text || !isTime(d.addedAt)) throw new HttpError(400, "bad_request");
    const isNew = !db.docExists(user.id, id);
    if (isNew && db.countDocs(user.id) >= LIMITS.docsPerUser) throw new HttpError(409, "too_many_items");
    db.upsertDoc(user.id, { id, title: d.title, name: d.name ?? "", text: d.text, addedAt: d.addedAt });
    sendJson(res, 200, { ok: true });
  }

  // ----- AI routes -----

  async function handleModelRequest(req, res, user, { validate, crisisText, messages, mockLines }) {
    const body = await readJson(req);
    if (!validate(body)) throw new HttpError(400, "bad_request");
    // Crisis language never reaches the model. The browser shows the fixed safety message.
    if (detectCrisis(crisisText(body), SAFETY.keywords)) return sendJson(res, 200, { type: "crisis" });

    // Free trial: a few uses with short answers, then a paid plan is needed.
    const paid = isPaid(user);
    if (!paid && user.free_ai_used >= billing.freeUses) throw new HttpError(402, "payment_required");
    if (!aiLimiter.check(`user:${user.id}`).ok) throw new HttpError(429, "limit");
    if (!paid && !db.useFreeAi(user.id, billing.freeUses)) throw new HttpError(402, "payment_required");
    const refund = paid ? () => {} : () => db.refundFreeAi(user.id); // a failed model call does not use up the trial

    if (config.mock) return streamMock(res, mockLines(body));
    return streamModel(res, config.llm, messages({ ...body, brief: !paid }), {
      maxTokens: paid ? config.llm.maxTokens : billing.freeMaxTokens,
      onFail: refund,
    });
  }

  async function payQr(req, res) {
    if (!existsSync(qrFile)) throw new HttpError(404, "not_found");
    res.writeHead(200, { "content-type": "image/png", "cache-control": "no-cache" });
    res.end(await readFile(qrFile));
  }

  // ----- routing -----

  const langOf = (url) => (url.searchParams.get("lang") === "en" ? "en" : "zh");

  /** [method, path, handler, needs login]. A path ending in /:id captures one id segment. */
  const routes = [
    ["GET", "/api/status", (req, res) => sendJson(res, 200, publicStatus()), false],
    ["GET", "/api/pay/qr", payQr, true],
    ["POST", "/api/auth/register", register, false],
    ["POST", "/api/auth/login", login, false],
    ["POST", "/api/auth/logout", logout, false],
    // Public so the app can ask "who am I?" without an error when nobody is logged in.
    ["GET", "/api/me", (req, res, user) => sendJson(res, 200, { user: user ? publicUser(user) : null }), false],
    ["PATCH", "/api/me", updateMe, true],
    ["POST", "/api/me/password", changePassword, true],
    ["DELETE", "/api/me", deleteMe, true],
    ["GET", "/api/courses", (req, res, user, id, url) => sendJson(res, 200, loadLocalized(join(contentDir, "courses"), langOf(url))), true],
    ["GET", "/api/library", (req, res, user, id, url) => sendJson(res, 200, loadLocalized(join(contentDir, "library"), langOf(url))), true],
    ["GET", "/api/notes", (req, res, user) => sendJson(res, 200, db.listNotes(user.id).map(noteOut)), true],
    ["PUT", "/api/notes/:id", putNote, true],
    ["DELETE", "/api/notes/:id", (req, res, user, id) => sendJson(res, db.deleteNote(user.id, id) ? 200 : 404, {}), true],
    ["GET", "/api/docs", (req, res, user) => sendJson(res, 200, db.listDocs(user.id).map(docOut)), true],
    ["PUT", "/api/docs/:id", putDoc, true],
    ["DELETE", "/api/docs/:id", (req, res, user, id) => sendJson(res, db.deleteDoc(user.id, id) ? 200 : 404, {}), true],
    ["GET", "/api/progress", (req, res, user) => sendJson(res, 200, db.listProgress(user.id)), true],
    ["PUT", "/api/progress/:id", (req, res, user, id) => (db.addProgress(user.id, id), sendJson(res, 200, { ok: true })), true],
    ["DELETE", "/api/progress/:id", (req, res, user, id) => (db.removeProgress(user.id, id), sendJson(res, 200, { ok: true })), true],
    ["POST", "/api/chat", (req, res, user) =>
      handleModelRequest(req, res, user, { validate: validateChat, crisisText: (b) => b.question, messages: buildMessages, mockLines: mockChatLines }), true],
    ["POST", "/api/assist", (req, res, user) =>
      handleModelRequest(req, res, user, { validate: validateAssist, crisisText: (b) => b.text, messages: buildAssistMessages, mockLines: mockAssistLines }), true],
  ];

  function matchRoute(method, pathname) {
    let pathMatched = false;
    for (const [m, pattern, handler, auth] of routes) {
      let id;
      if (pattern.endsWith("/:id")) {
        const base = pattern.slice(0, -4);
        if (!pathname.startsWith(`${base}/`)) continue;
        try {
          id = decodeURIComponent(pathname.slice(base.length + 1));
        } catch {
          continue;
        }
        if (!ID.test(id)) continue;
      } else if (pathname !== pattern) continue;
      pathMatched = true;
      if (m === method) return { handler, auth, id };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }

  /** Browsers send Origin with cross-site requests; refuse state changes coming from any other site. */
  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  async function serveStatic(pathname, res) {
    const file = resolve(PUBLIC_DIR, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(PUBLIC_DIR + sep)) return sendJson(res, 404, { error: "not_found" });
    try {
      const data = await readFile(file);
      const headers = { "content-type": MIME[extname(file)] || "application/octet-stream" };
      // The page and the service worker must always be checked for updates.
      if (pathname === "/" || pathname.endsWith(".html") || pathname === "/sw.js") headers["cache-control"] = "no-cache";
      res.writeHead(200, headers);
      res.end(data);
    } catch {
      sendJson(res, 404, { error: "not_found" });
    }
  }

  const server = http.createServer(async (req, res) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname.startsWith("/api/")) {
        const route = matchRoute(req.method, url.pathname);
        if (!route) throw new HttpError(404, "not_found");
        if (route.methodNotAllowed) throw new HttpError(405, "method_not_allowed");
        if (req.method !== "GET" && !sameOrigin(req)) throw new HttpError(403, "forbidden_origin");
        const user = currentUser(req);
        if (route.auth && !user) throw new HttpError(401, "unauthorized");
        return await route.handler(req, res, user, route.id, url);
      }
      if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "method_not_allowed");
      let path;
      try {
        path = decodeURIComponent(url.pathname);
      } catch {
        throw new HttpError(404, "not_found");
      }
      return await serveStatic(path, res);
    } catch (err) {
      if (!(err instanceof HttpError)) console.error(err);
      const status = err instanceof HttpError ? err.status : 500;
      if (!res.headersSent) sendJson(res, status, { error: err instanceof HttpError ? err.code : "server" });
      else res.end();
    }
  });

  // Expired sessions are cleaned up hourly.
  const purge = setInterval(() => db.purgeExpiredSessions(), 3600_000);
  purge.unref();
  server.on("close", () => {
    clearInterval(purge);
    if (!config.db) db.close();
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = loadConfig(join(APP_DIR, ".env"));
  createApp(config).listen(config.port, config.host, () => {
    console.log(`Unspoken: http://${config.host}:${config.port}`);
    console.log(config.mock ? "Mode: TEST (no AI model called; set LLM_API_KEY in .env)" : `Mode: live, model ${config.llm.model}`);
  });
}
