// Unspoken demo server: static files, course/library content, and a model proxy.
// The API key stays on the server; the browser never sees it.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, extname, resolve, sep, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./lib/config.js";
import { loadDocs } from "./lib/content.js";
import { buildMessages, buildAssistMessages, ASSIST_TASKS, ROLES } from "./lib/prompt.js";
import { createLimiter } from "./lib/ratelimit.js";
import { detectCrisis } from "./public/js/safety.js";

const APP_DIR = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(APP_DIR, "public");
const SAFETY = JSON.parse(readFileSync(join(PUBLIC_DIR, "config/safety.json"), "utf8"));

const MAX_BODY = 100 * 1024;
const MAX_QUESTION = 1000;
const MAX_SOURCES = 8;
const MAX_SOURCE_CHARS = 2000;
const MAX_ASSIST_CHARS = 3000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function sendJson(res, status, data) {
  res.writeHead(status, { "content-type": MIME[".json"], "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const parts = [];
    req.on("data", (c) => {
      size += c.length;
      if (size <= MAX_BODY) return parts.push(c);
      // Reject at once but keep draining a little, so the client still receives the 413.
      reject(Object.assign(new Error("too large"), { status: 413 }));
      if (size > 10 * MAX_BODY) req.destroy();
    });
    req.on("end", () => resolveBody(Buffer.concat(parts).toString("utf8")));
    req.on("error", reject);
  });
}

function validRole(role) {
  return role === undefined || role === "" || Object.hasOwn(ROLES, role);
}

function validateChat(body) {
  const { question, history = [], sources, role } = body || {};
  if (!validRole(role)) return "身份不正确。";
  if (typeof question !== "string" || !question.trim() || question.length > MAX_QUESTION) {
    return "问题不能为空，且不超过 1000 字。";
  }
  if (!Array.isArray(sources) || sources.length === 0 || sources.length > MAX_SOURCES) {
    return "缺少资料。";
  }
  for (const s of sources) {
    if (typeof s?.title !== "string" || typeof s?.text !== "string" || s.text.length > MAX_SOURCE_CHARS) {
      return "资料格式不正确。";
    }
  }
  if (!Array.isArray(history)) return "对话记录格式不正确。";
  return null;
}

function validateAssist(body) {
  const { task, text, role } = body || {};
  if (!Object.hasOwn(ASSIST_TASKS, task)) return "不支持的操作。";
  if (typeof text !== "string" || !text.trim() || text.length > MAX_ASSIST_CHARS) {
    return "文字不能为空，且不超过 3000 字。";
  }
  if (!validRole(role)) return "身份不正确。";
  return null;
}

function sse(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
}

const delta = (text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;

const MOCK_NOTE = "【测试模式：未连接 AI 模型，以下不是真实回答】\n\n";

function mockChatLines({ sources }) {
  return [
    MOCK_NOTE,
    `系统为这个问题找到了 ${sources.length} 段资料：\n\n`,
    ...sources.map((s, i) => `- [${i + 1}] 《${s.title}》\n`),
    "\n连接模型后，AI 会只根据这些资料作答，并标注来源编号。",
  ];
}

function mockAssistLines({ task, text }) {
  return [
    MOCK_NOTE,
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

async function streamModel(res, llm, messages) {
  const controller = new AbortController();
  res.on("close", () => controller.abort());
  let upstream;
  try {
    upstream = await fetch(`${llm.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${llm.apiKey}` },
      body: JSON.stringify({
        model: llm.model,
        messages,
        stream: true,
        temperature: 0.3,
        max_tokens: llm.maxTokens,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    console.error("model request failed:", err.message);
    return sendJson(res, 502, { error: "model", message: "暂时连不上 AI 模型，请稍后再试。" });
  }
  if (!upstream.ok) {
    console.error("model error:", upstream.status, (await upstream.text()).slice(0, 500));
    return sendJson(res, 502, { error: "model", message: "AI 模型返回了错误，请稍后再试。" });
  }
  sse(res);
  try {
    for await (const chunk of upstream.body) res.write(chunk);
  } catch (err) {
    if (!controller.signal.aborted) console.error("model stream broke:", err.message);
  }
  res.end();
}

export function createApp(config) {
  const limiter = createLimiter({ perKey: config.limits.perVisitorPerDay, global: config.limits.sitePerDay });
  const contentDir = isAbsolute(config.contentDir) ? config.contentDir : join(APP_DIR, config.contentDir);

  /**
   * Shared path for every model request: parse, validate, crisis check, rate limit, then stream.
   * @param {(body: any) => string | null} validate
   * @param {(body: any) => string} crisisText the user-written text to screen
   */
  async function handleModelRequest(req, res, { validate, crisisText, messages, mockLines }) {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (err) {
      if (err.status === 413) return sendJson(res, 413, { error: "too_large", message: "内容太长了，请缩短后再试。" });
      return sendJson(res, 400, { error: "bad_request", message: "请求格式不正确。" });
    }
    const problem = validate(body);
    if (problem) return sendJson(res, 400, { error: "bad_request", message: problem });

    // Crisis language never reaches the model. The browser shows the fixed safety message.
    if (detectCrisis(crisisText(body), SAFETY.keywords)) return sendJson(res, 200, { type: "crisis" });

    // Behind Cloudflare, cf-connecting-ip is the real visitor and cannot be set by the visitor.
    const visitor = String(
      req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || req.socket.remoteAddress
    ).split(",")[0].trim();
    if (!limiter.check(visitor).ok) {
      return sendJson(res, 429, { error: "limit", message: "今天的使用次数已经用完了，明天再来吧。" });
    }

    if (config.mock) return streamMock(res, mockLines(body));
    return streamModel(res, config.llm, messages(body));
  }

  const handleChat = (req, res) =>
    handleModelRequest(req, res, {
      validate: validateChat,
      crisisText: (b) => b.question,
      messages: buildMessages,
      mockLines: mockChatLines,
    });

  const handleAssist = (req, res) =>
    handleModelRequest(req, res, {
      validate: validateAssist,
      crisisText: (b) => b.text,
      messages: buildAssistMessages,
      mockLines: mockAssistLines,
    });

  async function serveStatic(pathname, res) {
    const file = resolve(PUBLIC_DIR, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(PUBLIC_DIR + sep)) return sendJson(res, 404, { error: "not_found" });
    try {
      const data = await readFile(file);
      res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
      res.end(data);
    } catch {
      sendJson(res, 404, { error: "not_found" });
    }
  }

  return http.createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, "http://localhost");
      if (req.method === "GET" && pathname === "/api/status") {
        return sendJson(res, 200, { mock: config.mock, model: config.mock ? null : config.llm.model });
      }
      if (req.method === "GET" && pathname === "/api/courses") {
        return sendJson(res, 200, loadDocs(join(contentDir, "courses")));
      }
      if (req.method === "GET" && pathname === "/api/library") {
        return sendJson(res, 200, loadDocs(join(contentDir, "library")));
      }
      if (req.method === "POST" && pathname === "/api/chat") return await handleChat(req, res);
      if (req.method === "POST" && pathname === "/api/assist") return await handleAssist(req, res);
      if (req.method === "GET") return await serveStatic(decodeURIComponent(pathname), res);
      sendJson(res, 405, { error: "method_not_allowed" });
    } catch (err) {
      console.error(err);
      if (!res.headersSent) sendJson(res, 500, { error: "server", message: "服务器出错了。" });
      else res.end();
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = loadConfig(join(APP_DIR, ".env"));
  createApp(config).listen(config.port, config.host, () => {
    console.log(`Unspoken demo: http://${config.host}:${config.port}`);
    console.log(config.mock ? "Mode: TEST (no AI model called; set LLM_API_KEY in .env)" : `Mode: live, model ${config.llm.model}`);
  });
}
