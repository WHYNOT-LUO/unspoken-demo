# Unspoken (未言) — demo

Emotional education web demo for parents and students (Mandarin, China).

- **First visit** — disclaimer, then "我是家长 / 我是学生 / 先随便看看". The role picks recommended courses and the tone of AI answers. Changeable on the 课程 page.
- **课程** — courses recommended for the role, progress ("已学完 2 / 7"), suggested questions at the end of each lesson, next lesson. Select text to save it to the notebook or ask about it.
- **问问未言** — ask questions. Answers come only from the chosen material (courses and platform references, or the user's own uploads), with numbered sources the user can open.
- **我的资料** — upload PDF, Word (.docx), TXT or Markdown. Text is extracted in the browser.
- **笔记本** — private notes, with one-click "记笔记" from answers and course passages. Guided templates (情绪记录, 冲突回顾, 写给父母/孩子的一封信…), search, export to Markdown.
- **AI 帮写** (in a note) — 整理成要点 / 换一种温和的说法 / 帮我把感受说清楚, on the selected text or the whole note. Result can be inserted or replace the original.
- **Safety** — crisis language (self-harm, abuse) is never sent to the AI; a fixed help message with hotlines is shown instead. A disclaimer appears on first visit.

## Run

Requires Node.js 18+. No runtime dependencies.

```bash
cd app
node server.js
```

Open http://127.0.0.1:3100.

Without an API key the app runs in **test mode**: everything works, but answers are a labelled placeholder listing the sources found. No AI model is called.

## Connect an AI model

Copy `.env.example` to `.env` and fill in a key. Any OpenAI-compatible endpoint works; for mainland China use a domestic provider:

| Provider | `LLM_BASE_URL` | `LLM_MODEL` |
|---|---|---|
| DeepSeek | `https://api.deepseek.com` | `deepseek-chat` |
| Qwen (Alibaba DashScope) | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |

The key stays on the server and is never sent to the browser. Daily limits per visitor and for the whole site are set in `.env`.

## Share a public link

Double-click `start-public-demo.command` in Finder (or run it in Terminal). It starts the server and a free Cloudflare quick tunnel and prints a link like `https://xxxx.trycloudflare.com` that anyone can open.

- Needs `bin/cloudflared` (not in the repo): download `cloudflared-darwin-arm64.tgz` from https://github.com/cloudflare/cloudflared/releases and unpack it into `bin/`.
- The link works only while that window is open and the Mac is awake, and it changes every time.
- Anyone with the link can use it; the daily limits in `.env` cap AI spend.

## Add content

- Courses: `.md` or `.txt` files in `content/courses/`. See the README there for the format (`title`, `summary`, `order`, `audience: parent|student|all`, `questions: 问题一 | 问题二`, `draft: true`).
- Platform reference material: `content/library/`.

Refresh the page after adding files; no restart needed.

## Draft courses

The 7 lessons in `content/courses/` (`01-…` to `07-…`) are **drafts written by AI** from the client's project notes, so the demo has something to show. They avoid statistics, quotes and medical claims, and each is marked `draft: true`, which shows a "草稿 · 待审核" badge and a notice in the lesson. Before real use, an expert must review or replace them. To remove them, delete the files. To approve one, edit it and delete the `draft: true` line.

## Before showing real users

`public/config/safety.json` holds the crisis message, keyword list, hotline list and disclaimer. **All of it is a draft.** A qualified person must review it. A hotline appears only when `verified` is `true` and `number` is filled in. Only 110 and 120 are enabled now; verify every other number against an official source before enabling it.

## Where data lives

| Data | Location |
|---|---|
| Courses, platform references | `content/` on the server |
| Notes, uploaded documents | The user's own browser (IndexedDB). Never uploaded. Lost if browser data is cleared (users can export). |
| Role, course progress, first-visit flag | The user's own browser (localStorage). |
| Questions and matching passages; text sent to AI 帮写 | Sent to the server, then to the AI model. Not stored by this server. |

## How answers stay grounded

1. The browser finds the most relevant passages (keyword search over Chinese bigrams, `public/js/retrieval.js`).
2. If nothing matches, the app says the material does not cover it, and no model is called.
3. Otherwise, only those passages and the question go to the model, with instructions to answer only from them and cite `[n]` (`lib/prompt.js`).

## Known limits

- Retrieval is keyword-based (Chinese bigrams). Questions phrased with words that never appear in the material may get "资料里没有找到". Embedding search would fix this later.
- No accounts: notes and uploads live in one browser and do not sync between devices.
- Conversation rehearsal and pattern reflection (from the feasibility doc) are not built.

## Tests

```bash
npm test
```

Covers retrieval, crisis detection, content loading, prompt building, rate limits, the server API, and the model proxy (against a fake model server).

## Files

```
server.js              HTTP server: static files, /api/courses, /api/library, /api/chat, /api/assist
lib/                   config, content loading, prompt, rate limits
public/                the web app (no build step)
  js/app.js            UI
  js/retrieval.js      search (shared with tests)
  js/safety.js         crisis detection (shared with server)
  js/templates.js      note templates
  config/safety.json   crisis message, hotlines, keywords, disclaimer — needs human review
  vendor/              marked, DOMPurify, mammoth, pdf.js (copied locally; no CDN)
content/               courses and reference material
scripts/vendor.js      re-copies vendor files after `npm install`
```
