// In-browser stand-in for the server, used only by the GitHub Pages demo (see scripts/build-demo.js).
// It answers the app's api/... requests itself: no account, no AI model, and everything the visitor
// writes stays in their own browser. The real app never loads this file.
import { detectCrisis } from "./safety.js";

const BASE = new URL("./", document.baseURI);
const API_PATH = new URL("api/", BASE).pathname;
const realFetch = window.fetch.bind(window);
const encoder = new TextEncoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- storage (separate from the real app's browser storage) ----------

const PROFILE = "unspoken.demo.profile";
const PROGRESS = "unspoken.demo.progress";

const readJson = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
};
const writeJson = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private browsing: keep going without saving */
  }
};

function profile() {
  const p = readJson(PROFILE, null);
  if (p) return p;
  const fresh = { role: "", lang: "", createdAt: Date.now() };
  writeJson(PROFILE, fresh);
  return fresh;
}

let dbPromise;
const memory = { notes: new Map(), docs: new Map() };
function db() {
  dbPromise ??= new Promise((resolve) => {
    const req = indexedDB.open("unspoken-demo", 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore("notes", { keyPath: "id" });
      req.result.createObjectStore("docs", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null); // fall back to memory
  });
  return dbPromise;
}
async function tx(store, mode, fn) {
  const d = await db();
  if (!d) return fn(null);
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}
const listAll = async (store) => (await tx(store, "readonly", (s) => (s ? s.getAll() : null))) ?? [...memory[store].values()];
const putOne = (store, value) => tx(store, "readwrite", (s) => (s ? s.put(value) : void memory[store].set(value.id, value)));
const deleteOne = (store, id) => tx(store, "readwrite", (s) => (s ? s.delete(id) : void memory[store].delete(id)));
const clearAll = async () => {
  await tx("notes", "readwrite", (s) => (s ? s.clear() : void memory.notes.clear()));
  await tx("docs", "readwrite", (s) => (s ? s.clear() : void memory.docs.clear()));
  localStorage.removeItem(PROFILE);
  localStorage.removeItem(PROGRESS);
};

// ---------- responses ----------

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

function stream(lines) {
  const delta = (text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
  const body = new ReadableStream({
    async start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(delta(line)));
        await sleep(60);
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

let safetyKeywords;
async function isCrisis(text) {
  safetyKeywords ??= (await (await realFetch(new URL("config/safety.json", BASE))).json()).keywords;
  return detectCrisis(text, safetyKeywords);
}

function chatLines({ sources, lang }) {
  if (!sources.length) {
    return lang === "en"
      ? ["**Demo:** no AI is called here.\n\n", "Nothing in the material matched this question. In the real app, the AI answers from general psychology knowledge here, clearly labelled as not coming from the course materials."]
      : ["**演示版：**这里不会调用 AI。\n\n", "课程资料里没有找到相关内容。在正式版里，AI 会在这里用一般心理学知识回答，并明确标出这部分不来自课程资料。"];
  }
  if (lang === "en") {
    return [
      "**Demo:** no AI is called here, so this is sample text.\n\n",
      `For your question, Unspoken found ${sources.length} passage(s) in the material:\n\n`,
      ...sources.map((s, i) => `- [${i + 1}] “${s.title}”\n`),
      "\nIn the real app, the AI answers from these passages first and cites them by number, like [1]; anything beyond them is labelled as general knowledge. Open the sources below to read them.",
    ];
  }
  return [
    "**演示版：**这里不会调用 AI，下面是示例文字。\n\n",
    `未言为你的问题在资料里找到了 ${sources.length} 段内容：\n\n`,
    ...sources.map((s, i) => `- [${i + 1}] 《${s.title}》\n`),
    "\n在正式版里，AI 优先根据这些内容回答，并像 [1] 这样标注来源；资料以外的补充会标明是一般知识。可以点开下面的资料看原文。",
  ];
}

function assistLines({ text, lang }) {
  const excerpt = text.length > 120 ? `${text.slice(0, 120)}…` : text;
  return lang === "en"
    ? ["**Demo:** no AI is called here.\n\n", "In the real app, the AI rewrites your text here. Your text was:\n\n", `> ${excerpt.replace(/\n/g, "\n> ")}`]
    : ["**演示版：**这里不会调用 AI。\n\n", "在正式版里，AI 会在这里改写你的文字。你写的是：\n\n", `> ${excerpt.replace(/\n/g, "\n> ")}`];
}

// ---------- routes ----------

async function handle(method, path, body, url) {
  const lang = url.searchParams.get("lang") === "en" ? "en" : "zh";
  const [resource, id] = path.split("/").map(decodeURIComponent);

  if (path === "status") return json({ mock: true, model: null, demo: true });
  if (path === "me" && method === "GET") return json({ user: { email: "demo", ...profile(), demo: true } });
  if (path === "me" && method === "PATCH") {
    const p = { ...profile(), ...(body.role !== undefined && { role: body.role }), ...(body.lang !== undefined && { lang: body.lang }) };
    writeJson(PROFILE, p);
    return json({ user: { email: "demo", ...p, demo: true } });
  }
  if (path === "me" && method === "DELETE") {
    await clearAll();
    return json({ ok: true });
  }
  if (path.startsWith("auth/")) return json({ user: { email: "demo", ...profile(), demo: true } });

  if (path === "courses" || path === "library") {
    const res = await realFetch(new URL(`demo-data/${path}-${lang}.json`, BASE));
    return json(await res.json());
  }

  if (resource === "notes" || resource === "docs") {
    if (method === "GET" && !id) {
      const key = resource === "notes" ? "updatedAt" : "addedAt";
      return json((await listAll(resource)).sort((a, b) => b[key] - a[key]));
    }
    if (method === "PUT" && id) {
      await putOne(resource, { ...body, id });
      return json({ ok: true });
    }
    if (method === "DELETE" && id) {
      await deleteOne(resource, id);
      return json({ ok: true });
    }
  }

  if (resource === "progress") {
    const done = new Set(readJson(PROGRESS, []));
    if (method === "PUT" && id) done.add(id);
    if (method === "DELETE" && id) done.delete(id);
    if (id) writeJson(PROGRESS, [...done]);
    return json(id ? { ok: true } : [...done]);
  }

  if (path === "chat" && method === "POST") {
    if (await isCrisis(body.question)) return json({ type: "crisis" });
    return stream(chatLines(body));
  }
  if (path === "assist" && method === "POST") {
    if (await isCrisis(body.text)) return json({ type: "crisis" });
    return stream(assistLines(body));
  }
  return json({ error: "not_found" }, 404);
}

window.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url, document.baseURI);
  if (url.origin !== location.origin || !url.pathname.startsWith(API_PATH)) return realFetch(input, init);
  const body = init.body ? JSON.parse(init.body) : {};
  return handle((init.method || "GET").toUpperCase(), url.pathname.slice(API_PATH.length), body, url);
};
