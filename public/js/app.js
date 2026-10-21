import { marked } from "/vendor/marked.esm.js";
import DOMPurify from "/vendor/purify.es.mjs";
import { buildIndex, search, isFollowUp } from "/js/retrieval.js";
import { detectCrisis, visibleHotlines } from "/js/safety.js";
import * as store from "/js/store.js";
import { fileToText, ACCEPT } from "/js/parse.js";
import { TEMPLATES } from "/js/templates.js";

// ---------- helpers ----------

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const uid = () => globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2);
const isPhone = () => matchMedia("(max-width: 860px)").matches;

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});
const md = (text) => DOMPurify.sanitize(marked.parse(String(text), { breaks: true, gfm: true }));

const fmtDate = (ms) =>
  new Date(ms).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

const KIND_LABEL = { course: "课程", library: "参考资料", upload: "我的资料" };

const NO_HIT =
  "资料里没有找到和这个问题相关的内容。可以换个说法再问，或者到「我的资料」上传相关资料后，把“回答依据”切换过去。";

let toastTimer;
function toast(text, kind = "") {
  const el = $("#toast");
  el.textContent = text;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3200);
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function storageSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode: ignore */ }
}

// ---------- state ----------

const state = {
  status: { mock: true },
  safety: { keywords: [], hotlines: [], message: "", disclaimer: "" },
  courses: [],
  library: [],
  uploads: [],
  notes: [],
  index: buildIndex([]),
  view: "courses",
  courseId: null,
  noteId: null,
  notePreview: false,
  scope: "courses",
  messages: [],
  busy: false,
  openDocId: null,
  loadingFiles: [],
  role: "",
  done: new Set(),
  noteQuery: "",
};

function rebuildIndex() {
  state.index = buildIndex([
    ...state.courses.map((d) => ({ id: `course:${d.id}`, title: d.title, text: d.text, kind: "course" })),
    ...state.library.map((d) => ({ id: `library:${d.id}`, title: d.title, text: d.text, kind: "library" })),
    ...state.uploads.map((d) => ({ id: `upload:${d.id}`, title: d.title, text: d.text, kind: "upload" })),
  ]);
}

// ---------- navigation ----------

function setView(view) {
  state.view = view;
  document.body.dataset.view = view;
  for (const b of document.querySelectorAll("[data-nav]")) b.classList.toggle("active", b.dataset.nav === view);
  hideSelToolbar();
  if (view === "chat") scrollMessages(true);
}

// ---------- role & progress (kept in this browser) ----------

const ROLE_LABEL = { parent: "家长", student: "学生" };
const AUDIENCE_LABEL = { parent: "适合家长", student: "适合学生", all: "家长和学生" };

function setRole(role) {
  state.role = ROLE_LABEL[role] ? role : "";
  storageSet("unspoken.role", state.role);
  renderCourses();
}

function loadDone() {
  try {
    return new Set(JSON.parse(storageGet("unspoken.done") || "[]"));
  } catch {
    return new Set();
  }
}

function toggleDone(id) {
  if (state.done.has(id)) state.done.delete(id);
  else state.done.add(id);
  storageSet("unspoken.done", JSON.stringify([...state.done]));
}

const forRole = (c) => !state.role || c.audience === "all" || c.audience === state.role;

// ---------- courses ----------

function courseCard(c) {
  const done = state.done.has(c.id);
  return `
    <button class="course-card" data-course="${esc(c.id)}">
      <span class="card-top">
        <span class="num">第 ${state.courses.indexOf(c) + 1} 课</span>
        ${done ? '<span class="done-tag">✓ 已学完</span>' : ""}
      </span>
      <h2>${esc(c.title)}</h2>
      ${c.summary ? `<p>${esc(c.summary)}</p>` : ""}
      <span class="tags">
        <span class="tag">${AUDIENCE_LABEL[c.audience] || AUDIENCE_LABEL.all}</span>
        ${c.draft ? '<span class="tag draft">草稿 · 待审核</span>' : ""}
      </span>
    </button>`;
}

let shownCourseId = null;

function renderCourses() {
  const el = $("#view-courses");
  const course = state.courses.find((c) => c.id === state.courseId);

  if (course) {
    const body = course.text.replace(new RegExp(`^#\\s*${course.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\n`), "");
    const next = state.courses.slice(state.courses.indexOf(course) + 1).find(forRole);
    const done = state.done.has(course.id);
    const chips = course.questions
      .map((q) => `<button class="chip" data-ask="${esc(q)}">${esc(q)}</button>`)
      .join("");
    el.innerHTML = `
      <button class="back" data-act="all">‹ 全部课程</button>
      <article class="reader" id="reader" data-title="${esc(course.title)}">
        ${course.draft ? '<p class="draft-note">这是一节草稿课程：内容由 AI 根据项目资料起草，正式使用前需要专业人士审核。</p>' : ""}
        <span class="tag">${AUDIENCE_LABEL[course.audience] || AUDIENCE_LABEL.all}</span>
        <h1>${esc(course.title)}</h1>
        ${course.summary ? `<p class="lede">${esc(course.summary)}</p>` : ""}
        <div class="prose">${md(body)}</div>
        ${chips ? `<div class="ask-box"><h3>读完以后，可以问问未言</h3><div class="chips">${chips}</div></div>` : ""}
        <div class="reader-foot">
          <button class="${done ? "ghost" : "primary"}" data-act="done">${done ? "✓ 已学完" : "标记为已学完"}</button>
          ${next ? `<button class="ghost" data-course="${esc(next.id)}">下一课：${esc(next.title)} ›</button>` : ""}
        </div>
      </article>
      <p class="reader-tip">提示：选中一段文字，可以把它记到笔记本，或者直接问问未言。</p>`;
    if (shownCourseId !== course.id) el.parentElement.scrollTop = 0;
    shownCourseId = course.id;
    return;
  }
  shownCourseId = null;

  if (!state.courses.length) {
    el.innerHTML = `
      <div class="view-head"><h1>课程</h1></div>
      <div class="empty">
        <h2>课程内容正在准备中</h2>
        <p>课程文件放进 <code>content/courses/</code> 文件夹（.md 或 .txt）后，刷新页面就会出现在这里。</p>
      </div>`;
    return;
  }

  const doneCount = state.courses.filter((c) => state.done.has(c.id)).length;
  const mine = state.courses.filter(forRole);
  const others = state.courses.filter((c) => !forRole(c));
  const roleButtons = [["parent", "家长"], ["student", "学生"], ["", "都看看"]]
    .map(([r, label]) => `<button class="${state.role === r ? "on" : ""}" data-role="${r}">${label}</button>`)
    .join("");

  el.innerHTML = `
    <div class="view-head"><h1>课程</h1><span class="progress">已学完 ${doneCount} / ${state.courses.length}</span></div>
    <p class="hint">先读一读课程。读到不明白的地方，可以随时在“问问未言”里提问。</p>
    <div class="role-switch" role="group" aria-label="我的身份"><span>我是</span><span class="tabs">${roleButtons}</span></div>
    ${state.role ? `<h2 class="section-title">推荐给${ROLE_LABEL[state.role]}</h2>` : ""}
    <div class="course-grid">${mine.map(courseCard).join("")}</div>
    ${others.length ? `<h2 class="section-title">其他课程</h2><div class="course-grid">${others.map(courseCard).join("")}</div>` : ""}`;
}

function askAbout(question) {
  state.scope = "courses";
  renderScope();
  if (isPhone()) setView("chat");
  ask(question);
}

$("#view-courses").addEventListener("click", (e) => {
  const target = e.target.closest("[data-course], [data-act], [data-role], [data-ask]");
  if (!target) return;
  if (target.dataset.course) {
    state.courseId = target.dataset.course;
    renderCourses();
  } else if (target.dataset.ask) {
    askAbout(target.dataset.ask);
  } else if (target.dataset.role !== undefined) {
    setRole(target.dataset.role);
  } else if (target.dataset.act === "all") {
    state.courseId = null;
    renderCourses();
  } else if (target.dataset.act === "done") {
    toggleDone(state.courseId);
    renderCourses();
  }
});

// ---------- selection toolbar (course reader) ----------

let selection = null;

function hideSelToolbar() {
  $("#selToolbar").hidden = true;
  selection = null;
}

function updateSelToolbar() {
  const reader = $("#reader");
  const sel = getSelection();
  if (!reader || state.view !== "courses" || !sel || sel.isCollapsed || !sel.rangeCount) return hideSelToolbar();
  const range = sel.getRangeAt(0);
  if (!reader.contains(range.commonAncestorContainer)) return hideSelToolbar();
  const text = sel.toString().trim();
  if (text.length < 2) return hideSelToolbar();

  selection = { text: text.slice(0, 1500), title: reader.dataset.title };
  const bar = $("#selToolbar");
  bar.hidden = false;
  const rect = range.getBoundingClientRect();
  const below = matchMedia("(pointer: coarse)").matches || rect.top < 70;
  const top = below ? rect.bottom + 10 : rect.top - bar.offsetHeight - 10;
  const left = Math.min(Math.max(8, rect.left + rect.width / 2 - bar.offsetWidth / 2), innerWidth - bar.offsetWidth - 8);
  bar.style.top = `${Math.max(8, top)}px`;
  bar.style.left = `${left}px`;
}

document.addEventListener("selectionchange", debounce(updateSelToolbar, 150));
$(".main").addEventListener("scroll", hideSelToolbar, { passive: true });
$("#selToolbar").addEventListener("mousedown", (e) => e.preventDefault());
$("#selToolbar").addEventListener("click", (e) => {
  const act = e.target.closest("[data-sel]")?.dataset.sel;
  if (!act || !selection) return;
  const { text, title } = selection;
  getSelection().removeAllRanges();
  hideSelToolbar();
  if (act === "note") {
    openSaveDialog({ title, body: `> ${text.replace(/\n/g, "\n> ")}`, source: `课程《${title}》` });
  } else {
    state.scope = "courses";
    renderScope();
    if (isPhone()) setView("chat");
    const q = $("#question");
    q.value = `关于课程《${title}》里的这段话：“${text}”\n`;
    q.focus();
    q.setSelectionRange(q.value.length, q.value.length);
    autosize(q);
  }
});

// ---------- save-to-notebook dialog ----------

function openSaveDialog({ title, body, source }) {
  const dlg = $("#dialog");
  const options = state.notes.map((n) => `<option value="${esc(n.id)}">${esc(n.title || "未命名笔记")}</option>`).join("");
  dlg.innerHTML = `
    <form method="dialog" class="dlg">
      <h2>记到笔记本</h2>
      <label>保存到
        <select name="saveTo">
          <option value="new">新建一条笔记</option>
          ${options}
        </select>
      </label>
      <label class="new-title">笔记标题
        <input name="newTitle" maxlength="80" value="${esc(title.slice(0, 40))}">
      </label>
      <div class="preview prose">${md(body)}</div>
      <p class="meta">来源：${esc(source)}</p>
      <menu>
        <button value="cancel" class="ghost">取消</button>
        <button value="ok" class="primary">保存</button>
      </menu>
    </form>`;
  const form = $("form", dlg);
  const { saveTo, newTitle } = form.elements;
  saveTo.addEventListener("change", () => ($(".new-title", dlg).hidden = saveTo.value !== "new"));
  dlg.onclose = async () => {
    if (dlg.returnValue !== "ok") return;
    const entry = `${body}\n\n*来源：${source} · ${fmtDate(Date.now())}*`;
    const now = Date.now();
    let note;
    if (saveTo.value === "new") {
      note = { id: uid(), title: newTitle.value.trim() || "未命名笔记", body: entry, createdAt: now, updatedAt: now };
      state.notes.unshift(note);
    } else {
      note = state.notes.find((n) => n.id === saveTo.value);
      note.body = note.body ? `${note.body}\n\n---\n\n${entry}` : entry;
      note.updatedAt = now;
      state.notes = [note, ...state.notes.filter((n) => n !== note)];
    }
    await store.put("notes", note);
    renderNotes();
    toast(`已记到笔记《${note.title}》`);
  };
  dlg.returnValue = "";
  dlg.showModal();
}

// ---------- library (uploads) ----------

function docItem(doc, { removable }) {
  const open = state.openDocId === doc.key;
  return `
    <li class="doc" data-doc="${esc(doc.key)}">
      <div class="doc-row">
        <span class="doc-title">${esc(doc.title)}</span>
        <span class="doc-meta">${doc.text.length.toLocaleString()} 字${doc.addedAt ? ` · ${fmtDate(doc.addedAt)}` : ""}</span>
        <span class="doc-actions">
          <button class="ghost small" data-act="toggle">${open ? "收起" : "查看"}</button>
          ${removable ? `<button class="primary small" data-act="ask">用它提问</button><button class="danger-btn small" data-act="delete">删除</button>` : ""}
        </span>
      </div>
      ${open ? `<div class="doc-preview">${esc(doc.text.slice(0, 4000))}${doc.text.length > 4000 ? "\n……" : ""}</div>` : ""}
    </li>`;
}

function renderLibrary() {
  const el = $("#view-library");
  const uploads = state.uploads.map((d) => docItem({ ...d, key: `upload:${d.id}` }, { removable: true })).join("");
  const loading = state.loadingFiles.map((n) => `<li class="doc loading">正在读取「${esc(n)}」…</li>`).join("");
  const platform = state.library.map((d) => docItem({ ...d, key: `library:${d.id}` }, { removable: false })).join("");

  el.innerHTML = `
    <div class="view-head"><h1>我的资料</h1></div>
    <p class="hint">上传你找到的文章或资料，然后在“问问未言”里把“回答依据”切换到它，未言就只根据这些资料回答。<br>
      资料只保存在你这台设备的浏览器里；提问时，和问题相关的几段内容会发送给 AI 模型来生成回答。</p>
    <label class="dropzone" id="dropzone">
      <strong>上传资料</strong>
      点击选择，或把文件拖到这里 · 支持 PDF、Word（.docx）、TXT、Markdown，单个不超过 15MB
      <input type="file" id="fileInput" accept="${ACCEPT}" multiple>
    </label>
    ${
      uploads || loading
        ? `<ul class="doc-list">${loading}${uploads}</ul>`
        : `<div class="empty"><p>还没有上传资料。</p></div>`
    }
    ${platform ? `<h2 class="section-title">平台参考资料（由未言提供）</h2><ul class="doc-list">${platform}</ul>` : ""}`;
}

async function addFiles(files) {
  const list = [...files];
  if (!list.length) return;
  state.loadingFiles.push(...list.map((f) => f.name));
  renderLibrary();
  for (const file of list) {
    try {
      const text = await fileToText(file);
      const doc = {
        id: uid(),
        title: file.name.replace(/\.[^.]+$/, ""),
        name: file.name,
        text: text.slice(0, 300000),
        addedAt: Date.now(),
      };
      await store.put("docs", doc);
      state.uploads.unshift(doc);
      toast(`已添加「${doc.title}」`);
    } catch (err) {
      toast(`「${file.name}」无法读取：${err.message}`, "error");
    } finally {
      state.loadingFiles.splice(state.loadingFiles.indexOf(file.name), 1);
      rebuildIndex();
      renderLibrary();
      renderScope();
    }
  }
}

const libraryEl = $("#view-library");
libraryEl.addEventListener("change", (e) => {
  if (e.target.id === "fileInput") addFiles(e.target.files);
});
libraryEl.addEventListener("dragover", (e) => {
  const zone = e.target.closest("#dropzone");
  if (!zone) return;
  e.preventDefault();
  zone.classList.add("over");
});
libraryEl.addEventListener("dragleave", (e) => e.target.closest("#dropzone")?.classList.remove("over"));
libraryEl.addEventListener("drop", (e) => {
  const zone = e.target.closest("#dropzone");
  if (!zone) return;
  e.preventDefault();
  zone.classList.remove("over");
  addFiles(e.dataTransfer.files);
});
libraryEl.addEventListener("click", async (e) => {
  const act = e.target.closest("[data-act]")?.dataset.act;
  const key = e.target.closest("[data-doc]")?.dataset.doc;
  if (!act || !key) return;
  const id = key.split(":").slice(1).join(":");
  if (act === "toggle") {
    state.openDocId = state.openDocId === key ? null : key;
    renderLibrary();
  } else if (act === "ask") {
    state.scope = `upload:${id}`;
    renderScope();
    setView("chat");
    if (!isPhone()) $("#question").focus();
  } else if (act === "delete") {
    const doc = state.uploads.find((d) => d.id === id);
    if (!confirm(`删除资料「${doc.title}」？删除后无法恢复。`)) return;
    await store.remove("docs", id);
    state.uploads = state.uploads.filter((d) => d.id !== id);
    if (state.scope === key) state.scope = state.uploads.length ? "uploads" : "courses";
    rebuildIndex();
    renderLibrary();
    renderScope();
  }
});

// ---------- notebook ----------

function filteredNotes() {
  const q = state.noteQuery.trim().toLowerCase();
  if (!q) return state.notes;
  return state.notes.filter((n) => `${n.title}\n${n.body}`.toLowerCase().includes(q));
}

function noteListHtml() {
  const notes = filteredNotes();
  if (!notes.length && state.noteQuery) return '<li class="hint">没有找到相关笔记。</li>';
  return notes
    .map(
      (n) => `
      <li><button class="note-item ${n.id === state.noteId ? "active" : ""}" data-note="${esc(n.id)}">
        <b>${esc(n.title || "未命名笔记")}</b><small>${fmtDate(n.updatedAt)}</small>
      </button></li>`
    )
    .join("");
}

const ASSIST_MENU = [
  ["points", "整理成要点"],
  ["gentle", "换一种温和的说法"],
  ["feelings", "帮我把感受说清楚"],
];

function renderNotes() {
  const el = $("#view-notes");
  const note = state.notes.find((n) => n.id === state.noteId);

  const editor = note
    ? `
      <button class="back" data-act="list">‹ 全部笔记</button>
      <input class="note-title" id="noteTitle" maxlength="80" value="${esc(note.title)}" placeholder="笔记标题" aria-label="笔记标题">
      <div class="note-tools">
        <span class="tabs">
          <button data-act="edit" class="${state.notePreview ? "" : "on"}">编辑</button>
          <button data-act="preview" class="${state.notePreview ? "on" : ""}">预览</button>
        </span>
        <details class="assist">
          <summary class="ghost small">AI 帮写</summary>
          <div class="assist-menu">
            <p>先选中一段文字；不选就处理整条笔记。</p>
            ${ASSIST_MENU.map(([task, label]) => `<button data-assist="${task}">${label}</button>`).join("")}
          </div>
        </details>
        <span class="save-state" id="saveState">已保存</span>
        <button class="ghost small" data-act="export">导出</button>
        <button class="danger-btn small" data-act="delete">删除</button>
      </div>
      ${
        state.notePreview
          ? `<div class="note-preview prose">${note.body ? md(note.body) : '<p class="hint">这条笔记还是空的。</p>'}</div>`
          : `<textarea class="note-body" id="noteBody" placeholder="写下你的理解、感受，或者想问的问题…（支持 Markdown）" aria-label="笔记内容">${esc(note.body)}</textarea>`
      }`
    : `<p class="note-placeholder">${state.notes.length ? "选择一条笔记" : "还没有笔记。<br>可以新建一条，或者在课程和问答里点“记笔记”。"}</p>`;

  el.innerHTML = `
    <div class="notes" data-mode="${note ? "edit" : "list"}">
      <div class="notes-list">
        <div class="view-head"><h1>笔记本</h1><button class="primary small" data-act="new">新建笔记</button></div>
        <p class="hint">笔记只保存在你这台设备的浏览器里，不会上传。清除浏览器数据会删除笔记，可以先导出备份。</p>
        ${
          state.notes.length
            ? `<div class="notes-search">
                <input type="search" id="noteSearch" placeholder="搜索笔记" value="${esc(state.noteQuery)}" aria-label="搜索笔记">
                <button class="ghost small" data-act="export-all">导出全部</button>
              </div>`
            : ""
        }
        <ul id="noteList">${noteListHtml()}</ul>
      </div>
      <div class="note-editor">${editor}</div>
    </div>`;
}

const saveNote = debounce(async (note) => {
  await store.put("notes", note);
  const s = $("#saveState");
  if (s) s.textContent = "已保存";
}, 400);

function touchNote() {
  const note = state.notes.find((n) => n.id === state.noteId);
  if (!note) return;
  note.title = $("#noteTitle")?.value ?? note.title;
  if ($("#noteBody")) note.body = $("#noteBody").value;
  note.updatedAt = Date.now();
  const s = $("#saveState");
  if (s) s.textContent = "正在保存…";
  const item = $(`[data-note="${CSS.escape(note.id)}"] b`);
  if (item) item.textContent = note.title || "未命名笔记";
  saveNote(note);
}

async function createNote({ title = "", body = "" } = {}) {
  const now = Date.now();
  const note = { id: uid(), title, body, createdAt: now, updatedAt: now };
  state.notes.unshift(note);
  state.noteId = note.id;
  state.notePreview = false;
  state.noteQuery = "";
  await store.put("notes", note);
  renderNotes();
  $(title ? "#noteBody" : "#noteTitle")?.focus();
}

function openTemplateDialog() {
  const templates = TEMPLATES.filter((t) => t.audience === "all" || !state.role || t.audience === state.role);
  const dlg = $("#dialog");
  dlg.innerHTML = `
    <form method="dialog" class="dlg">
      <h2>新建笔记</h2>
      <p class="meta">可以从空白开始，也可以选一个引导模板。</p>
      <div class="tpl-grid">
        <button class="tpl" value="blank"><b>空白笔记</b><small>自由书写</small></button>
        ${templates.map((t) => `<button class="tpl" value="${esc(t.id)}"><b>${esc(t.title)}</b><small>${esc(t.desc)}</small></button>`).join("")}
      </div>
      <menu><button value="cancel" class="ghost">取消</button></menu>
    </form>`;
  dlg.onclose = () => {
    const choice = dlg.returnValue;
    if (choice === "blank") createNote();
    const tpl = TEMPLATES.find((t) => t.id === choice);
    if (tpl) createNote({ title: tpl.title, body: tpl.body });
  };
  dlg.returnValue = "";
  dlg.showModal();
}

function downloadText(filename, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  a.download = `${filename.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60) || "笔记"}.md`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const noteMarkdown = (n) => `# ${n.title || "未命名笔记"}\n\n${n.body}\n`;

// ---------- AI writing help (notebook) ----------

function openAssistDialog(task, note) {
  const textarea = $("#noteBody");
  let start = 0;
  let end = note.body.length;
  if (textarea && textarea.selectionEnd > textarea.selectionStart) {
    start = textarea.selectionStart;
    end = textarea.selectionEnd;
  }
  const text = note.body.slice(start, end).trim();
  if (!text) return toast("先在笔记里写一点内容，再用 AI 帮写");
  if (text.length > 3000) return toast("一次最多处理 3000 字，请先选中一部分", "error");

  const label = ASSIST_MENU.find(([t]) => t === task)[1];
  const dlg = $("#dialog");
  dlg.innerHTML = `
    <form method="dialog" class="dlg">
      <h2>AI 帮写：${esc(label)}</h2>
      <details class="src"><summary>原文（${text.length} 字）</summary><blockquote>${esc(text)}</blockquote></details>
      <div class="preview prose assist-result" id="assistResult"><span class="typing"></span></div>
      <p class="meta">AI 只改写你写下的内容，可能不完全准确，请自己看一遍再使用。</p>
      <menu>
        <button value="cancel" class="ghost">取消</button>
        <button value="insert" class="ghost" id="assistInsert" disabled>插入到原文后面</button>
        <button value="replace" class="primary" id="assistReplace" disabled>替换原文</button>
      </menu>
    </form>`;
  let result = "";
  const controller = new AbortController();
  dlg.onclose = async () => {
    controller.abort();
    const action = dlg.returnValue;
    if (!result || (action !== "insert" && action !== "replace")) return;
    note.body =
      action === "replace"
        ? note.body.slice(0, start) + result + note.body.slice(end)
        : `${note.body.slice(0, end)}\n\n${result}\n${note.body.slice(end)}`;
    note.updatedAt = Date.now();
    await store.put("notes", note);
    state.notePreview = false;
    renderNotes();
    toast(action === "replace" ? "已替换" : "已插入");
  };
  dlg.returnValue = "";
  dlg.showModal();

  const out = $("#assistResult");
  const finish = (html) => {
    out.innerHTML = html;
    const ready = Boolean(result);
    $("#assistInsert").disabled = !ready;
    $("#assistReplace").disabled = !ready;
  };

  fetch("/api/assist", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task, text, role: state.role }),
    signal: controller.signal,
  })
    .then(async (res) => {
      if ((res.headers.get("content-type") || "").includes("application/json")) {
        const data = await res.json();
        return finish(data.type === "crisis" ? crisisHtml() : `<p class="msg error">${esc(data.message || "出错了，请稍后再试。")}</p>`);
      }
      await readStream(res, (t) => {
        result += t;
        out.innerHTML = md(result);
      });
      result = result.trim();
      finish(result ? md(result) : '<p class="msg error">没有收到结果，请再试一次。</p>');
    })
    .catch((err) => {
      if (err.name !== "AbortError") finish('<p class="msg error">网络出错了，请稍后再试。</p>');
    });
}

const notesEl = $("#view-notes");
notesEl.addEventListener("input", (e) => {
  if (e.target.id === "noteTitle" || e.target.id === "noteBody") touchNote();
  if (e.target.id === "noteSearch") {
    state.noteQuery = e.target.value;
    $("#noteList").innerHTML = noteListHtml();
  }
});
notesEl.addEventListener("click", async (e) => {
  const noteBtn = e.target.closest("[data-note]");
  if (noteBtn) {
    state.noteId = noteBtn.dataset.note;
    state.notePreview = false;
    return renderNotes();
  }
  const note = state.notes.find((n) => n.id === state.noteId);
  const assistBtn = e.target.closest("[data-assist]");
  if (assistBtn && note) {
    e.target.closest("details").open = false;
    return openAssistDialog(assistBtn.dataset.assist, note);
  }
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "new") {
    openTemplateDialog();
  } else if (act === "list") {
    state.noteId = null;
    renderNotes();
  } else if (act === "edit" || act === "preview") {
    state.notePreview = act === "preview";
    renderNotes();
  } else if (act === "export" && note) {
    downloadText(note.title || "笔记", noteMarkdown(note));
  } else if (act === "export-all") {
    downloadText(`未言笔记-${new Date().toISOString().slice(0, 10)}`, state.notes.map(noteMarkdown).join("\n---\n\n"));
  } else if (act === "delete" && note) {
    if (!confirm(`删除笔记《${note.title || "未命名笔记"}》？删除后无法恢复。`)) return;
    await store.remove("notes", note.id);
    state.notes = state.notes.filter((n) => n !== note);
    state.noteId = null;
    renderNotes();
  }
});

// ---------- chat ----------

function scopeOptions() {
  const opts = [{ value: "courses", label: "课程与平台参考资料" }];
  if (state.uploads.length) {
    opts.push({ value: "uploads", label: "我上传的全部资料" });
    for (const d of state.uploads) opts.push({ value: `upload:${d.id}`, label: `我的资料：${d.title}` });
  }
  return opts;
}

function renderScope() {
  const opts = scopeOptions();
  if (!opts.some((o) => o.value === state.scope)) state.scope = "courses";
  $("#scope").innerHTML = opts
    .map((o) => `<option value="${esc(o.value)}" ${o.value === state.scope ? "selected" : ""}>${esc(o.label)}</option>`)
    .join("");
}

$("#scope").addEventListener("change", (e) => (state.scope = e.target.value));

function scopeDocIds() {
  if (state.scope === "courses") {
    return [...state.courses.map((d) => `course:${d.id}`), ...state.library.map((d) => `library:${d.id}`)];
  }
  if (state.scope === "uploads") return state.uploads.map((d) => `upload:${d.id}`);
  return [state.scope];
}

function crisisHtml() {
  const lines = state.safety.message.split(/\n+/).map((p) => `<p>${esc(p)}</p>`).join("");
  const hotlines = visibleHotlines(state.safety.hotlines)
    .map((h) => `<li><a href="tel:${esc(h.number)}"><span>${esc(h.name)}</span><b>${esc(h.number)}</b></a></li>`)
    .join("");
  return `<div class="crisis"><h3>你的安全最重要</h3>${lines}<ul class="hotlines">${hotlines}</ul></div>`;
}

function withCites(text, count) {
  return text.replace(/\[(\d{1,2})\]/g, (m, n) => (Number(n) >= 1 && Number(n) <= count ? `<sup class="cite">${n}</sup>` : m));
}

function messageHtml(m, i) {
  if (m.role === "user") return `<div class="msg user">${esc(m.content)}</div>`;
  if (m.kind === "crisis") {
    return `<div class="msg">${crisisHtml()}<small class="hint">这条消息没有发送给 AI。</small></div>`;
  }
  if (m.kind === "notice") return `<div class="msg notice">${esc(m.content)}</div>`;
  if (m.kind === "error") return `<div class="msg error">${esc(m.content)}</div>`;

  const sources = m.sources
    .map(
      (s, n) => `
      <details class="src">
        <summary><span>[${n + 1}] 《${esc(s.title)}》</span><span class="kind">${KIND_LABEL[s.kind] || ""}</span></summary>
        <blockquote>${esc(s.text)}</blockquote>
      </details>`
    )
    .join("");
  return `
    <div class="msg ai" data-i="${i}">
      <div class="prose">${m.content ? md(withCites(m.content, m.sources.length)) : ""}</div>
      ${m.pending ? '<span class="typing"></span>' : ""}
      <div class="sources"><span class="sources-label">依据的资料（点开可看原文）</span>${sources}</div>
      ${
        m.pending
          ? ""
          : `<div class="msg-actions">
              <button class="ghost small" data-act="save" data-i="${i}">记笔记</button>
              <button class="ghost small" data-act="copy" data-i="${i}">复制</button>
            </div>`
      }
    </div>`;
}

function renderMessages() {
  const el = $("#messages");
  if (!state.messages.length) {
    el.innerHTML = `
      <div class="chat-intro">
        <p>你可以问关于课程内容的问题，也可以先在“我的资料”里上传自己找到的资料，再把“回答依据”切换过去。</p>
        <p>未言只根据所选资料回答。资料里没有的内容，它会直接告诉你。</p>
      </div>`;
    return;
  }
  el.innerHTML = state.messages.map(messageHtml).join("");
  scrollMessages(true);
}

function scrollMessages(force = false) {
  const el = $("#messages");
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  if (force || nearBottom) el.scrollTop = el.scrollHeight;
}

let renderQueued = false;
function renderStreaming(i) {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const m = state.messages[i];
    const prose = $(`.msg.ai[data-i="${i}"] .prose`);
    if (m && prose) prose.innerHTML = md(withCites(m.content, m.sources.length));
    scrollMessages();
  });
}

async function readStream(res, onText) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      try {
        const text = JSON.parse(data).choices?.[0]?.delta?.content;
        if (text) onText(text);
      } catch { /* ignore keep-alive or partial lines */ }
    }
  }
}

/** One source per document: passages from the same document are joined, best document first. */
function mergeByDoc(hits) {
  const byDoc = new Map();
  for (const h of hits) {
    const s = byDoc.get(h.docId);
    if (s) s.text = `${s.text}\n……\n${h.text}`.slice(0, 1900);
    else byDoc.set(h.docId, { title: h.title, text: h.text, kind: h.kind });
  }
  return [...byDoc.values()];
}

/** Earlier question/answer pairs that actually went to the model (no crisis or notice turns). */
function historyForServer(upTo) {
  const history = [];
  for (let i = 0; i < upTo - 1; i++) {
    const q = state.messages[i];
    const a = state.messages[i + 1];
    if (q.role === "user" && a?.kind === "answer" && a.content) {
      history.push({ role: "user", content: q.content }, { role: "assistant", content: a.content });
    }
  }
  return history;
}

function lastAnsweredQuestion(before) {
  for (let i = before - 1; i >= 0; i--) {
    if (state.messages[i].role === "user" && state.messages[i + 1]?.kind === "answer") return state.messages[i].content;
  }
  return "";
}

function updateComposer() {
  $("#sendBtn").disabled = state.busy;
  $("#sendBtn").textContent = state.busy ? "回答中…" : "发送";
}

async function ask(question) {
  question = question.trim();
  if (!question || state.busy) return;

  const userIndex = state.messages.push({ role: "user", content: question }) - 1;

  if (detectCrisis(question, state.safety.keywords)) {
    state.messages.push({ role: "assistant", kind: "crisis" });
    return renderMessages();
  }

  const docIds = scopeDocIds();
  if (!docIds.length) {
    state.messages.push({
      role: "assistant",
      kind: "notice",
      content: "现在还没有可以作为依据的资料。课程上线后就可以提问；你也可以先到“我的资料”上传资料。",
    });
    return renderMessages();
  }

  let hits = search(state.index, question, { topK: 5, docIds });
  const previous = lastAnsweredQuestion(userIndex);
  if (!hits.length && previous && isFollowUp(question)) hits = search(state.index, `${previous} ${question}`, { topK: 5, docIds });
  if (!hits.length) {
    state.messages.push({ role: "assistant", kind: "notice", content: NO_HIT });
    return renderMessages();
  }

  const msg = {
    role: "assistant",
    kind: "answer",
    content: "",
    pending: true,
    question,
    sources: mergeByDoc(hits),
  };
  const i = state.messages.push(msg) - 1;
  state.busy = true;
  updateComposer();
  renderMessages();

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question,
        role: state.role,
        history: historyForServer(userIndex),
        sources: msg.sources.map(({ title, text }) => ({ title, text })),
      }),
    });
    if ((res.headers.get("content-type") || "").includes("application/json")) {
      const data = await res.json();
      if (data.type === "crisis") {
        state.messages[i] = { role: "assistant", kind: "crisis" };
      } else {
        Object.assign(msg, { kind: "error", content: data.message || "出错了，请稍后再试。" });
      }
    } else {
      await readStream(res, (text) => {
        msg.content += text;
        renderStreaming(i);
      });
      if (!msg.content) Object.assign(msg, { kind: "error", content: "没有收到回答，请再试一次。" });
    }
  } catch {
    Object.assign(msg, { kind: "error", content: "网络出错了，请检查网络后再试。" });
  } finally {
    msg.pending = false;
    state.busy = false;
    updateComposer();
    renderMessages();
  }
}

function autosize(t) {
  t.style.height = "auto";
  t.style.height = `${Math.min(t.scrollHeight, 160)}px`;
}

$("#question").addEventListener("input", (e) => autosize(e.target));
$("#question").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("#composer").requestSubmit();
  }
});
$("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("#question");
  if (state.busy || !q.value.trim()) return;
  const value = q.value;
  q.value = "";
  autosize(q);
  ask(value);
});
$("#clearChat").addEventListener("click", () => {
  if (state.busy) return;
  state.messages = [];
  renderMessages();
});
$("#messages").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const m = state.messages[Number(btn.dataset.i)];
  if (!m) return;
  const sourceList = m.sources.map((s, n) => `[${n + 1}]《${s.title}》`).join(" ");
  if (btn.dataset.act === "save") {
    openSaveDialog({
      title: m.question,
      body: `**问：${m.question}**\n\n${m.content}`,
      source: `问问未言，依据 ${sourceList}`,
    });
  } else if (btn.dataset.act === "copy") {
    try {
      await navigator.clipboard.writeText(`${m.content}\n\n来源：${sourceList}`);
      toast("已复制");
    } catch {
      toast("复制失败，请手动选择文字复制", "error");
    }
  }
});

// ---------- dialogs: help, about, first-visit notice ----------

function showInfo(html) {
  const dlg = $("#dialog");
  dlg.innerHTML = `<form method="dialog" class="dlg">${html}<menu><button value="ok" class="primary">我知道了</button></menu></form>`;
  dlg.onclose = null;
  dlg.showModal();
}

function showHelp() {
  showInfo(`<h2>需要帮助？</h2>${crisisHtml()}`);
}

function showAbout() {
  showInfo(`
    <h2>关于未言</h2>
    <p>${esc(state.safety.disclaimer)}</p>
    <p class="meta">笔记和你上传的资料只保存在这台设备的浏览器里。提问时，和问题相关的几段资料会发送给 AI 模型来生成回答。</p>
    <p class="meta">你的身份：${ROLE_LABEL[state.role] || "未选择"}（可以在课程页更改）</p>
    <p class="meta">当前模式：${state.status.mock ? "测试模式（未连接 AI 模型）" : `已连接 AI 模型（${esc(state.status.model)}）`}</p>`);
}

document.addEventListener("click", (e) => {
  const open = e.target.closest("[data-open]")?.dataset.open;
  if (open === "help") showHelp();
  if (open === "about") showAbout();
  const nav = e.target.closest("[data-nav]")?.dataset.nav;
  if (nav) setView(nav);
});

function maybeShowNotice() {
  const key = "unspoken.notice.v1";
  if (storageGet(key)) return;
  const dlg = $("#dialog");
  dlg.innerHTML = `
    <form method="dialog" class="dlg">
      <h2>欢迎来到未言</h2>
      <p>${esc(state.safety.disclaimer)}</p>
      <p class="meta">你是哪一位？我们会为你推荐合适的课程。之后可以在课程页随时更改。</p>
      <div class="role-pick">
        <button value="parent" class="primary">我是家长</button>
        <button value="student" class="primary">我是学生</button>
        <button value="none" class="ghost">先随便看看</button>
      </div>
    </form>`;
  dlg.onclose = () => {
    storageSet(key, "1");
    if (dlg.returnValue === "parent" || dlg.returnValue === "student") setRole(dlg.returnValue);
  };
  dlg.returnValue = "";
  dlg.showModal();
}

// ---------- start ----------

async function init() {
  setView("courses");
  state.role = ROLE_LABEL[storageGet("unspoken.role")] ? storageGet("unspoken.role") : "";
  state.done = loadDone();
  try {
    const [status, safety, courses, library] = await Promise.all([
      getJson("/api/status"),
      getJson("/config/safety.json"),
      getJson("/api/courses"),
      getJson("/api/library"),
    ]);
    Object.assign(state, { status, safety, courses, library });
  } catch {
    toast("连接服务器失败，请刷新页面重试", "error");
  }
  try {
    state.uploads = (await store.all("docs")).sort((a, b) => b.addedAt - a.addedAt);
    state.notes = (await store.all("notes")).sort((a, b) => b.updatedAt - a.updatedAt);
    if (await store.isMemoryOnly()) toast("这个浏览器不能保存数据（可能是无痕模式），关闭页面后笔记会丢失", "error");
  } catch {
    toast("读取本地笔记失败", "error");
  }
  $("#mockBanner").hidden = !state.status.mock;
  rebuildIndex();
  renderCourses();
  renderLibrary();
  renderNotes();
  renderScope();
  renderMessages();
  updateComposer();
  maybeShowNotice();
}

init();
