// Settings from environment variables, with an optional .env file next to server.js.
import { existsSync, readFileSync } from "node:fs";

export function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

export function loadConfig(envPath) {
  const file = existsSync(envPath) ? parseEnv(readFileSync(envPath, "utf8")) : {};
  const env = { ...file, ...process.env };
  const apiKey = env.LLM_API_KEY || "";
  return {
    host: env.HOST || "127.0.0.1",
    port: Number(env.PORT) || 3100,
    contentDir: env.CONTENT_DIR || "content",
    llm: {
      baseUrl: (env.LLM_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, ""),
      apiKey,
      model: env.LLM_MODEL || "deepseek-chat",
      maxTokens: Number(env.LLM_MAX_TOKENS) || 800,
    },
    // Test mode: no model is called. On automatically when no API key is set.
    mock: env.LLM_MOCK === "1" || !apiKey,
    limits: {
      perVisitorPerDay: Number(env.LIMIT_PER_VISITOR_DAY) || 60,
      sitePerDay: Number(env.LIMIT_SITE_DAY) || 1500,
    },
  };
}
