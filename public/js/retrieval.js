// Keyword retrieval over Chinese and English text (BM25 over character bigrams).
// Shared by the browser and the tests. No dependencies.

// Function words. A bigram made only of these carries no topic.
const STOP_CHARS = new Set(
  "的了是在和与及或也就都很还又才吗呢吧啊呀嘛么什怎为样这那哪谁有没不要会能可以我你他她它们咱自己个些种上下中里把被让给对向从到着过"
);

const CJK = /[㐀-䶿一-鿿]/;

function isStopToken(token) {
  return [...token].every((ch) => STOP_CHARS.has(ch));
}

/** Split text into search tokens: bigrams for Chinese runs, lowercase words for Latin. */
export function tokenize(text) {
  const tokens = [];
  const runs = String(text).toLowerCase().match(/[㐀-䶿一-鿿]+|[a-z0-9]+/g) || [];
  for (const run of runs) {
    if (!CJK.test(run)) {
      tokens.push(run);
    } else if (run.length === 1) {
      tokens.push(run);
    } else {
      for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
    }
  }
  return tokens;
}

function contentTokens(text) {
  return tokenize(text).filter((t) => !isStopToken(t));
}

/** Split text into chunks of at most `size` characters, preferring paragraph boundaries. */
export function chunkText(text, { size = 400, overlap = 60 } = {}) {
  const clean = String(text).replace(/\r\n/g, "\n").trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];

  const paragraphs = clean.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let current = "";
  const flush = () => {
    if (current) chunks.push(current);
    current = "";
  };

  for (const p of paragraphs) {
    if (p.length > size) {
      flush();
      for (let i = 0; i < p.length; i += size - overlap) {
        chunks.push(p.slice(i, i + size));
        if (i + size >= p.length) break;
      }
      continue;
    }
    if (current && current.length + 2 + p.length > size) flush();
    current = current ? `${current}\n\n${p}` : p;
  }
  flush();
  return chunks;
}

/**
 * Build a search index.
 * @param {{id: string, title: string, text: string, kind?: string}[]} docs
 */
export function buildIndex(docs) {
  const chunks = [];
  const df = new Map();
  for (const doc of docs) {
    for (const text of chunkText(doc.text)) {
      const tokens = contentTokens(`${doc.title}\n${text}`);
      const tf = new Map();
      for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
      for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
      chunks.push({ docId: doc.id, title: doc.title, kind: doc.kind, text, tf, len: tokens.length });
    }
  }
  const avgLen = chunks.reduce((s, c) => s + c.len, 0) / (chunks.length || 1);
  return { chunks, df, avgLen };
}

/**
 * True for short questions that only make sense with the previous one ("那具体怎么做？").
 * Only these may borrow the previous question's words for retrieval.
 */
export function isFollowUp(question) {
  const q = String(question).trim().replace(/[？?。！!\s]+$/, "");
  if (q.length > 12) return false;
  return /^(那|那么|这|这个|它|所以|然后|具体|还有|为什么|怎么|如果|可是|但是)/.test(q) || /呢$/.test(q);
}

/**
 * Return the chunks most relevant to `query`, best first.
 * An empty result means the materials do not cover the question.
 */
export function search(index, query, { topK = 5, docIds = null } = {}) {
  const queryTokens = [...new Set(contentTokens(query))];
  if (!queryTokens.length) return [];

  const N = index.chunks.length;
  const k1 = 1.2;
  const b = 0.75;
  const minMatches = Math.min(2, queryTokens.length);
  const results = [];

  for (const chunk of index.chunks) {
    if (docIds && !docIds.includes(chunk.docId)) continue;
    let score = 0;
    let matches = 0;
    for (const t of queryTokens) {
      const f = chunk.tf.get(t);
      if (!f) continue;
      matches++;
      const n = index.df.get(t);
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * chunk.len) / index.avgLen)));
    }
    if (matches >= minMatches && score > 0) {
      results.push({ docId: chunk.docId, title: chunk.title, kind: chunk.kind, text: chunk.text, score });
    }
  }

  return results.sort((x, y) => y.score - x.score).slice(0, topK);
}
