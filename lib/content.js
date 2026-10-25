// Loads course and library documents (.md / .txt) from a folder.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, extname, basename } from "node:path";

const AUDIENCES = ["parent", "student", "all"];

/** Split optional `---` front matter (simple `key: value` lines) from the body. */
export function parseFrontMatter(text) {
  const m = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: String(text) };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: m[2] };
}

/**
 * Documents for a language: `dir/en/` for English when it has any, otherwise `dir/` (Chinese).
 */
export function loadLocalized(dir, lang) {
  if (lang === "en") {
    const en = loadDocs(join(dir, "en"));
    if (en.length) return en;
  }
  return loadDocs(dir);
}

/** Read every .md/.txt file in `dir` (except README.md), sorted by `order` then title. */
export function loadDocs(dir) {
  if (!existsSync(dir)) return [];
  const docs = [];
  for (const file of readdirSync(dir)) {
    const ext = extname(file).toLowerCase();
    if (![".md", ".txt"].includes(ext) || file.toLowerCase() === "readme.md") continue;
    const id = basename(file, extname(file));
    const { meta, body } = parseFrontMatter(readFileSync(join(dir, file), "utf8"));
    docs.push({
      id,
      title: meta.title || id,
      summary: meta.summary || "",
      order: Number(meta.order) || 999,
      audience: AUDIENCES.includes(meta.audience) ? meta.audience : "all",
      questions: (meta.questions || "").split("|").map((q) => q.trim()).filter(Boolean),
      draft: meta.draft === "true",
      group: meta.group || "", // reference collection, e.g. "openstax" (shown together in the library)
      url: /^https:\/\//.test(meta.url || "") ? meta.url : "", // where the original can be read
      text: body.trim(),
    });
  }
  return docs.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title, "zh"));
}
