import { marked } from "/vendor/marked.esm.js";
import DOMPurify from "/vendor/purify.es.mjs";
import { buildIndex, search, isFollowUp } from "/js/retrieval.js";
import { detectCrisis, visibleHotlines } from "/js/safety.js";
import * as store from "/js/store.js";
import { fileToText, ACCEPT } from "/js/parse.js";
import { TEMPLATES } from "/js/templates.js";
import { t, setLang, getLang, detectLang } from "/js/i18n.js";

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
  new Date(ms).toLocaleString(getLang() === "en" ? "en-GB" : "zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

const quote = (title) => t("quote", { t: title });

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
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
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
  safety: { keywords: [], hotlines: [], zh: {}, en: {} },
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

const safetyText = (field) => state.safety[getLang()]?.[field] || state.safety.zh?.[field] || "";
const hotlineName = (h) => (typeof h.name === "string" ? h.name : h.name[getLang()] || h.name.zh);

function rebuildIndex() {
  state.index = buildIndex([
    ...state.courses.map((d) => ({ id: `course:${d.id}`, title: d.title, text: d.text, kind: "course" })),
    ...state.library.map((d) => ({ id: `library:${d.id}`, title: d.title, text: d.text, kind: "library" })),
    ...state.uploads.map((d) => ({ id: `upload:${d.id}`, title: d.title, text: d.text, kind: "upload" })),
  ]);
}

// ---------- language ----------

/** Translate the fixed parts of the page (elements tagged with data-i18n*). */
function applyStaticText() {
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll("[data-i18n-placeholder]")) el.placeholder = t(el.dataset.i18nPlaceholder);
  for (const el of document.querySelectorAll("[data-i18n-aria]")) el.setAttribute("aria-label", t(el.dataset.i18nAria));
  document.documentElement.lang = getLang() === "en" ? "en" : "zh-CN";
  document.title = t("doc.title");
}

/** Courses and platform references in the current language (English falls back to Chinese). */
async function loadContent() {
  const lang = getLang();
  const [courses, library] = await Promise.all([getJson(`/api/courses?lang=${lang}`), getJson(`/api/library?lang=${lang}`)]);
  Object.assign(state, { courses, library });
  rebuildIndex();
}

function renderAll() {
  applyStaticText();
  renderCourses();
  renderLibrary();
  renderNotes();
  renderScope();
  renderMessages();
  updateComposer();
}

async function switchLang() {
  setLang(getLang() === "zh" ? "en" : "zh");
  storageSet("unspoken.lang", getLang());
  try {
    await loadContent();
  } catch {
    toast(t("err.server"), "error");
  }
  renderAll();
  if ($("#dialog").open && $("#dialog").dataset.kind === "welcome") renderWelcome();
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

const ROLES = ["parent", "student"];

function setRole(role) {
  state.role = ROLES.includes(role) ? role : "";
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
const audienceLabel = (a) => t(`audience.${["parent", "student"].includes(a) ? a : "all"}`);

// ---------- courses ----------

function courseCard(c) {
  const done = state.done.has(c.id);
  return `
    <button class="course-card" data-course="${esc(c.id)}">
      <span class="card-top">
        <span class="num">${t("courses.lesson", { n: state.courses.indexOf(c) + 1 })}</span>
        ${done ? `<span class="done-tag">${t("courses.doneTag")}</span>` : ""}
      </span>
      <h2>${esc(c.title)}</h2>
      ${c.summary ? `<p>${esc(c.summary)}</p>` : ""}
      <span class="tags">
        <span class="tag">${audienceLabel(c.audience)}</span>
        ${c.draft ? `<span class="tag draft">${t("courses.draftTag")}</span>` : ""}
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
      <button class="back" data-act="all">${t("courses.back")}</button>
      <article class="reader" id="reader" data-title="${esc(course.title)}">
        ${course.draft ? `<p class="draft-note">${t("courses.draftNote")}</p>` : ""}
        <span class="tag">${audienceLabel(course.audience)}</span>
        <h1>${esc(course.title)}</h1>
        ${course.summary ? `<p class="lede">${esc(course.summary)}</p>` : ""}
        <div class="prose">${md(body)}</div>
        ${chips ? `<div class="ask-box"><h3>${t("courses.askTitle")}</h3><div class="chips">${chips}</div></div>` : ""}
        <div class="reader-foot">
          <button class="${done ? "ghost" : "primary"}" data-act="done">${done ? t("courses.doneTag") : t("courses.markDone")}</button>
          ${next ? `<button class="ghost" data-course="${esc(next.id)}">${t("courses.next", { title: esc(next.title) })}</button>` : ""}
        </div>
      </article>
      <p class="reader-tip">${t("courses.tip")}</p>`;
    if (shownCourseId !== course.id) el.parentElement.scrollTop = 0;
    shownCourseId = course.id;
    return;
  }
  shownCourseId = null;

  if (!state.courses.length) {
    el.innerHTML = `
      <div class="view-head"><h1>${t("courses.title")}</h1></div>
      <div class="empty">
        <h2>${t("courses.emptyTitle")}</h2>
        <p>${t("courses.emptyBody")}</p>
      </div>`;
    return;
  }

  const doneCount = state.courses.filter((c) => state.done.has(c.id)).length;
  const mine = state.courses.filter(forRole);
  const others = state.courses.filter((c) => !forRole(c));
  const roleButtons = [["parent", "role.parent"], ["student", "role.student"], ["", "role.all"]]
    .map(([r, key]) => `<button class="${state.role === r ? "on" : ""}" data-role="${r}">${t(key)}</button>`)
    .join("");

  el.innerHTML = `
    <div class="view-head"><h1>${t("courses.title")}</h1><span class="progress">${t("courses.progress", { done: doneCount, total: state.courses.length })}</span></div>
    <p class="hint">${t("courses.hint")}</p>
    <div class="role-switch" role="group" aria-label="${t("courses.roleAria")}"><span>${t("courses.iam")}</span><span class="tabs">${roleButtons}</span></div>
    ${state.role ? `<h2 class="section-title">${t(`courses.rec.${state.role}`)}</h2>` : ""}
    <div class="course-grid">${mine.map(courseCard).join("")}</div>
    ${others.length ? `<h2 class="section-title">${t("courses.others")}</h2><div class="course-grid">${others.map(courseCard).join("")}</div>` : ""}`;
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
    openSaveDialog({ title, body: `> ${text.replace(/\n/g, "\n> ")}`, source: t("sel.source", { title }) });
  } else {
    state.scope = "courses";
    renderScope();
    if (isPhone()) setView("chat");
    const q = $("#question");
    q.value = t("sel.askPrefix", { title, text });
    q.focus();
    q.setSelectionRange(q.value.length, q.value.length);
    autosize(q);
  }
});

// ---------- dialogs ----------

function openDialog(kind, html) {
  const dlg = $("#dialog");
  dlg.dataset.kind = kind;
  dlg.innerHTML = html;
  dlg.onclose = null;
  dlg.returnValue = "";
  if (!dlg.open) dlg.showModal();
  return dlg;
}

// ---------- save-to-notebook dialog ----------

function openSaveDialog({ title, body, source }) {
  const options = state.notes
    .map((n) => `<option value="${esc(n.id)}">${esc(n.title || t("common.untitled"))}</option>`)
    .join("");
  const dlg = openDialog(
    "save",
    `<form method="dialog" class="dlg">
      <h2>${t("save.title")}</h2>
      <label>${t("save.to")}
        <select name="saveTo">
          <option value="new">${t("save.new")}</option>
          ${options}
        </select>
      </label>
      <label class="new-title">${t("save.noteTitle")}
        <input name="newTitle" maxlength="80" value="${esc(title.slice(0, 40))}">
      </label>
      <div class="preview prose">${md(body)}</div>
      <p class="meta">${esc(t("save.source", { s: source }))}</p>
      <menu>
        <button value="cancel" class="ghost">${t("common.cancel")}</button>
        <button value="ok" class="primary">${t("common.save")}</button>
      </menu>
    </form>`
  );
  const { saveTo, newTitle } = $("form", dlg).elements;
  saveTo.addEventListener("change", () => ($(".new-title", dlg).hidden = saveTo.value !== "new"));
  dlg.onclose = async () => {
    if (dlg.returnValue !== "ok") return;
    const entry = `${body}\n\n${t("save.entrySource", { s: source, date: fmtDate(Date.now()) })}`;
    const now = Date.now();
    let note;
    if (saveTo.value === "new") {
      note = { id: uid(), title: newTitle.value.trim() || t("common.untitled"), body: entry, createdAt: now, updatedAt: now };
      state.notes.unshift(note);
    } else {
      note = state.notes.find((n) => n.id === saveTo.value);
      note.body = note.body ? `${note.body}\n\n---\n\n${entry}` : entry;
      note.updatedAt = now;
      state.notes = [note, ...state.notes.filter((n) => n !== note)];
    }
    await store.put("notes", note);
    renderNotes();
    toast(t("save.done", { t: note.title }));
  };
}

// ---------- library (uploads) ----------

function docItem(doc, { removable }) {
  const open = state.openDocId === doc.key;
  return `
    <li class="doc" data-doc="${esc(doc.key)}">
      <div class="doc-row">
        <span class="doc-title">${esc(doc.title)}</span>
        <span class="doc-meta">${t("lib.chars", { n: doc.text.length.toLocaleString() })}${doc.addedAt ? ` · ${fmtDate(doc.addedAt)}` : ""}</span>
        <span class="doc-actions">
          <button class="ghost small" data-act="toggle">${open ? t("lib.hide") : t("lib.view")}</button>
          ${removable ? `<button class="primary small" data-act="ask">${t("lib.ask")}</button><button class="danger-btn small" data-act="delete">${t("common.delete")}</button>` : ""}
        </span>
      </div>
      ${open ? `<div class="doc-preview">${esc(doc.text.slice(0, 4000))}${doc.text.length > 4000 ? "\n……" : ""}</div>` : ""}
    </li>`;
}

function renderLibrary() {
  const el = $("#view-library");
  const uploads = state.uploads.map((d) => docItem({ ...d, key: `upload:${d.id}` }, { removable: true })).join("");
  const loading = state.loadingFiles.map((n) => `<li class="doc loading">${esc(t("lib.loading", { n }))}</li>`).join("");
  const platform = state.library.map((d) => docItem({ ...d, key: `library:${d.id}` }, { removable: false })).join("");

  el.innerHTML = `
    <div class="view-head"><h1>${t("lib.title")}</h1></div>
    <p class="hint">${t("lib.hint")}</p>
    <label class="dropzone" id="dropzone">
      <strong>${t("lib.upload")}</strong>
      ${t("lib.drop")}
      <input type="file" id="fileInput" accept="${ACCEPT}" multiple>
    </label>
    ${uploads || loading ? `<ul class="doc-list">${loading}${uploads}</ul>` : `<div class="empty"><p>${t("lib.empty")}</p></div>`}
    ${platform ? `<h2 class="section-title">${t("lib.platform")}</h2><ul class="doc-list">${platform}</ul>` : ""}`;
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
      toast(t("lib.added", { t: doc.title }));
    } catch (err) {
      const reason = t(`err.file.${err.code || "other"}`);
      toast(t("lib.readFail", { n: file.name, e: reason.startsWith("err.") ? t("err.file.other") : reason }), "error");
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
    if (!confirm(t("lib.confirmDelete", { t: doc.title }))) return;
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
  if (!notes.length && state.noteQuery) return `<li class="hint">${t("notes.noMatch")}</li>`;
  return notes
    .map(
      (n) => `
      <li><button class="note-item ${n.id === state.noteId ? "active" : ""}" data-note="${esc(n.id)}">
        <b>${esc(n.title || t("common.untitled"))}</b><small>${fmtDate(n.updatedAt)}</small>
      </button></li>`
    )
    .join("");
}

const ASSIST_TASKS = ["points", "gentle", "feelings"];

function renderNotes() {
  const el = $("#view-notes");
  const note = state.notes.find((n) => n.id === state.noteId);

  const editor = note
    ? `
      <button class="back" data-act="list">${t("notes.back")}</button>
      <input class="note-title" id="noteTitle" maxlength="80" value="${esc(note.title)}" placeholder="${t("notes.titlePh")}" aria-label="${t("notes.titlePh")}">
      <div class="note-tools">
        <span class="tabs">
          <button data-act="edit" class="${state.notePreview ? "" : "on"}">${t("notes.edit")}</button>
          <button data-act="preview" class="${state.notePreview ? "on" : ""}">${t("notes.preview")}</button>
        </span>
        <details class="assist">
          <summary class="ghost small">${t("notes.assist")}</summary>
          <div class="assist-menu">
            <p>${t("notes.assistHint")}</p>
            ${ASSIST_TASKS.map((task) => `<button data-assist="${task}">${t(`assist.${task}`)}</button>`).join("")}
          </div>
        </details>
        <span class="save-state" id="saveState">${t("notes.saved")}</span>
        <button class="ghost small" data-act="export">${t("notes.export")}</button>
        <button class="danger-btn small" data-act="delete">${t("common.delete")}</button>
      </div>
      ${
        state.notePreview
          ? `<div class="note-preview prose">${note.body ? md(note.body) : `<p class="hint">${t("notes.emptyPreview")}</p>`}</div>`
          : `<textarea class="note-body" id="noteBody" placeholder="${t("notes.bodyPh")}" aria-label="${t("notes.bodyAria")}">${esc(note.body)}</textarea>`
      }`
    : `<p class="note-placeholder">${state.notes.length ? t("notes.pick") : t("notes.none")}</p>`;

  el.innerHTML = `
    <div class="notes" data-mode="${note ? "edit" : "list"}">
      <div class="notes-list">
        <div class="view-head"><h1>${t("notes.title")}</h1><button class="primary small" data-act="new">${t("notes.new")}</button></div>
        <p class="hint">${t("notes.hint")}</p>
        ${
          state.notes.length
            ? `<div class="notes-search">
                <input type="search" id="noteSearch" placeholder="${t("notes.search")}" value="${esc(state.noteQuery)}" aria-label="${t("notes.search")}">
                <button class="ghost small" data-act="export-all">${t("notes.exportAll")}</button>
              </div>`
            : ""
        }
        <ul id="noteList">${noteListHtml()}</ul>
      </div>
      <div class="note-editor">${editor}</div>
    </div>`;
}

// Edited notes wait here briefly so typing doesn't write on every key.
// Each note is queued separately, so editing another note never drops a pending save.
const unsavedNotes = new Set();

async function flushNotes() {
  const notes = [...unsavedNotes];
  unsavedNotes.clear();
  await Promise.all(notes.map((n) => store.put("notes", n)));
  const s = $("#saveState");
  if (s && !unsavedNotes.size) s.textContent = t("notes.saved");
}

const flushNotesSoon = debounce(flushNotes, 400);
addEventListener("pagehide", flushNotes);
document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flushNotes());

function touchNote() {
  const note = state.notes.find((n) => n.id === state.noteId);
  if (!note) return;
  note.title = $("#noteTitle")?.value ?? note.title;
  if ($("#noteBody")) note.body = $("#noteBody").value;
  note.updatedAt = Date.now();
  const s = $("#saveState");
  if (s) s.textContent = t("notes.saving");
  const item = $(`[data-note="${CSS.escape(note.id)}"] b`);
  if (item) item.textContent = note.title || t("common.untitled");
  unsavedNotes.add(note);
  flushNotesSoon();
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
  const lang = getLang();
  const templates = TEMPLATES.filter((tpl) => tpl.audience === "all" || !state.role || tpl.audience === state.role);
  const dlg = openDialog(
    "template",
    `<form method="dialog" class="dlg">
      <h2>${t("tpl.title")}</h2>
      <p class="meta">${t("tpl.hint")}</p>
      <div class="tpl-grid">
        <button class="tpl" value="blank"><b>${t("tpl.blank")}</b><small>${t("tpl.blankDesc")}</small></button>
        ${templates.map((tpl) => `<button class="tpl" value="${esc(tpl.id)}"><b>${esc(tpl[lang].title)}</b><small>${esc(tpl[lang].desc)}</small></button>`).join("")}
      </div>
      <menu><button value="cancel" class="ghost">${t("common.cancel")}</button></menu>
    </form>`
  );
  dlg.onclose = () => {
    const choice = dlg.returnValue;
    if (choice === "blank") createNote();
    const tpl = TEMPLATES.find((x) => x.id === choice);
    if (tpl) createNote({ title: tpl[lang].title, body: tpl[lang].body });
  };
}

function downloadText(filename, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  a.download = `${filename.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60) || t("notes.fileName")}.md`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const noteMarkdown = (n) => `# ${n.title || t("common.untitled")}\n\n${n.body}\n`;

// ---------- AI writing help (notebook) ----------

/** User-facing text for an error response from the server. */
function serverError(data) {
  const msg = t(`err.${data?.error}`);
  return msg.startsWith("err.") ? t("err.generic") : msg;
}

function openAssistDialog(task, note) {
  const textarea = $("#noteBody");
  let start = 0;
  let end = note.body.length;
  if (textarea && textarea.selectionEnd > textarea.selectionStart) {
    start = textarea.selectionStart;
    end = textarea.selectionEnd;
  }
  const text = note.body.slice(start, end).trim();
  if (!text) return toast(t("assist.needText"));
  if (text.length > 3000) return toast(t("assist.tooLong"), "error");

  const dlg = openDialog(
    "assist",
    `<form method="dialog" class="dlg">
      <h2>${t("assist.title", { label: t(`assist.${task}`) })}</h2>
      <details class="src"><summary>${t("assist.original", { n: text.length })}</summary><blockquote>${esc(text)}</blockquote></details>
      <div class="preview prose assist-result" id="assistResult"><span class="typing" data-label="${esc(t("common.working"))}"></span></div>
      <p class="meta">${t("assist.note")}</p>
      <menu>
        <button value="cancel" class="ghost">${t("common.cancel")}</button>
        <button value="insert" class="ghost" id="assistInsert" disabled>${t("assist.insert")}</button>
        <button value="replace" class="primary" id="assistReplace" disabled>${t("assist.replace")}</button>
      </menu>
    </form>`
  );
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
    toast(action === "replace" ? t("assist.replaced") : t("assist.inserted"));
  };

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
    body: JSON.stringify({ task, text, role: state.role, lang: getLang() }),
    signal: controller.signal,
  })
    .then(async (res) => {
      if ((res.headers.get("content-type") || "").includes("application/json")) {
        const data = await res.json();
        return finish(data.type === "crisis" ? crisisHtml() : `<p class="msg error">${esc(serverError(data))}</p>`);
      }
      await readStream(res, (chunk) => {
        result += chunk;
        out.innerHTML = md(result);
      });
      result = result.trim();
      finish(result ? md(result) : `<p class="msg error">${t("err.noResult")}</p>`);
    })
    .catch((err) => {
      if (err.name !== "AbortError") finish(`<p class="msg error">${t("err.network")}</p>`);
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
    flushNotes();
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
    downloadText(note.title || t("notes.fileName"), noteMarkdown(note));
  } else if (act === "export-all") {
    downloadText(t("notes.exportName", { date: new Date().toISOString().slice(0, 10) }), state.notes.map(noteMarkdown).join("\n---\n\n"));
  } else if (act === "delete" && note) {
    if (!confirm(t("notes.confirmDelete", { t: note.title || t("common.untitled") }))) return;
    unsavedNotes.delete(note); // a queued save must not bring the note back
    await store.remove("notes", note.id);
    state.notes = state.notes.filter((n) => n !== note);
    state.noteId = null;
    renderNotes();
  }
});

// ---------- chat ----------

function scopeOptions() {
  const opts = [{ value: "courses", label: t("scope.courses") }];
  if (state.uploads.length) {
    opts.push({ value: "uploads", label: t("scope.uploads") });
    for (const d of state.uploads) opts.push({ value: `upload:${d.id}`, label: t("scope.upload", { title: d.title }) });
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
  const lines = safetyText("message")
    .split(/\n+/)
    .map((p) => `<p>${esc(p)}</p>`)
    .join("");
  const hotlines = visibleHotlines(state.safety.hotlines)
    .map((h) => `<li><a href="tel:${esc(h.number)}"><span>${esc(hotlineName(h))}</span><b>${esc(h.number)}</b></a></li>`)
    .join("");
  return `<div class="crisis"><h3>${t("crisis.title")}</h3>${lines}<ul class="hotlines">${hotlines}</ul></div>`;
}

function withCites(text, count) {
  return text.replace(/\[(\d{1,2})\]/g, (m, n) => (Number(n) >= 1 && Number(n) <= count ? `<sup class="cite">${n}</sup>` : m));
}

function messageHtml(m, i) {
  if (m.role === "user") return `<div class="msg user">${esc(m.content)}</div>`;
  if (m.kind === "crisis") return `<div class="msg">${crisisHtml()}<small class="hint">${t("chat.notSent")}</small></div>`;
  if (m.kind === "notice") return `<div class="msg notice">${esc(t(m.key))}</div>`;
  if (m.kind === "error") return `<div class="msg error">${esc(m.key ? t(m.key) : m.content)}</div>`;

  const sources = m.sources
    .map(
      (s, n) => `
      <details class="src">
        <summary><span>[${n + 1}] ${esc(quote(s.title))}</span><span class="kind">${t(`kind.${s.kind}`)}</span></summary>
        <blockquote>${esc(s.text)}</blockquote>
      </details>`
    )
    .join("");
  return `
    <div class="msg ai" data-i="${i}">
      <div class="prose">${m.content ? md(withCites(m.content, m.sources.length)) : ""}</div>
      ${m.pending ? `<span class="typing" data-label="${esc(t("chat.sending"))}"></span>` : ""}
      <div class="sources"><span class="sources-label">${t("chat.sources")}</span>${sources}</div>
      ${
        m.pending
          ? ""
          : `<div class="msg-actions">
              <button class="ghost small" data-act="save" data-i="${i}">${t("chat.save")}</button>
              <button class="ghost small" data-act="copy" data-i="${i}">${t("chat.copy")}</button>
            </div>`
      }
    </div>`;
}

function renderMessages() {
  const el = $("#messages");
  if (!state.messages.length) {
    el.innerHTML = `
      <div class="chat-intro">
        <p>${t("chat.intro1")}</p>
        <p>${t("chat.intro2")}</p>
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
  $("#sendBtn").textContent = state.busy ? t("chat.sending") : t("chat.send");
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
    state.messages.push({ role: "assistant", kind: "notice", key: "chat.noDocs" });
    return renderMessages();
  }

  let hits = search(state.index, question, { topK: 5, docIds });
  const previous = lastAnsweredQuestion(userIndex);
  if (!hits.length && previous && isFollowUp(question)) hits = search(state.index, `${previous} ${question}`, { topK: 5, docIds });
  if (!hits.length) {
    state.messages.push({ role: "assistant", kind: "notice", key: "chat.noHit" });
    return renderMessages();
  }

  const msg = { role: "assistant", kind: "answer", content: "", pending: true, question, sources: mergeByDoc(hits) };
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
        lang: getLang(),
        history: historyForServer(userIndex),
        sources: msg.sources.map(({ title, text }) => ({ title, text })),
      }),
    });
    if ((res.headers.get("content-type") || "").includes("application/json")) {
      const data = await res.json();
      if (data.type === "crisis") state.messages[i] = { role: "assistant", kind: "crisis" };
      else Object.assign(msg, { kind: "error", content: serverError(data) });
    } else {
      await readStream(res, (text) => {
        msg.content += text;
        renderStreaming(i);
      });
      if (!msg.content) Object.assign(msg, { kind: "error", key: "err.noAnswer" });
    }
  } catch {
    Object.assign(msg, { kind: "error", key: "err.network" });
  } finally {
    msg.pending = false;
    state.busy = false;
    updateComposer();
    renderMessages();
  }
}

function autosize(el) {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
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
  const sourceList = m.sources.map((s, n) => `[${n + 1}] ${quote(s.title)}`).join(" ");
  if (btn.dataset.act === "save") {
    openSaveDialog({
      title: m.question,
      body: t("chat.noteBody", { q: m.question, a: m.content }),
      source: t("chat.noteSource", { list: sourceList }),
    });
  } else if (btn.dataset.act === "copy") {
    try {
      await navigator.clipboard.writeText(`${m.content}\n\n${t("chat.copySources", { list: sourceList })}`);
      toast(t("chat.copied"));
    } catch {
      toast(t("chat.copyFail"), "error");
    }
  }
});

// ---------- help, about, first-visit welcome ----------

function showInfo(kind, html) {
  openDialog(kind, `<form method="dialog" class="dlg">${html}<menu><button value="ok" class="primary">${t("common.ok")}</button></menu></form>`);
}

function showHelp() {
  showInfo("help", `<h2>${t("help.title")}</h2>${crisisHtml()}`);
}

function showAbout() {
  const role = ROLES.includes(state.role) ? t(`role.${state.role}`) : t("role.none");
  const mode = state.status.mock ? t("about.mock") : t("about.live", { m: esc(state.status.model) });
  showInfo(
    "about",
    `<h2>${t("about.title")}</h2>
    <p>${esc(safetyText("disclaimer"))}</p>
    <p class="meta">${t("about.data")}</p>
    <p class="meta">${t("about.role", { r: role })}</p>
    <p class="meta">${t("about.mode", { m: mode })}</p>`
  );
}

function renderWelcome() {
  const dlg = openDialog(
    "welcome",
    `<form method="dialog" class="dlg">
      <div class="dlg-top">
        <h2>${t("welcome.title")}</h2>
        <button type="button" class="lang-btn" data-lang-toggle aria-label="${t("lang.switchAria")}">${t("lang.switch")}</button>
      </div>
      <p>${esc(safetyText("disclaimer"))}</p>
      <p class="meta">${t("welcome.who")}</p>
      <div class="role-pick">
        <button value="parent" class="primary">${t("welcome.parent")}</button>
        <button value="student" class="primary">${t("welcome.student")}</button>
        <button value="none" class="ghost">${t("welcome.browse")}</button>
      </div>
    </form>`
  );
  dlg.onclose = () => {
    storageSet("unspoken.notice.v1", "1");
    if (ROLES.includes(dlg.returnValue)) setRole(dlg.returnValue);
  };
}

document.addEventListener("click", (e) => {
  if (e.target.closest("[data-lang-toggle]")) return switchLang();
  const open = e.target.closest("[data-open]")?.dataset.open;
  if (open === "help") showHelp();
  if (open === "about") showAbout();
  const nav = e.target.closest("[data-nav]")?.dataset.nav;
  if (nav) setView(nav);
});

// ---------- start ----------

async function init() {
  setLang(detectLang(storageGet("unspoken.lang"), navigator.languages || [navigator.language]));
  applyStaticText();
  setView("courses");
  const savedRole = storageGet("unspoken.role");
  state.role = ROLES.includes(savedRole) ? savedRole : "";
  state.done = loadDone();
  try {
    const [status, safety] = await Promise.all([getJson("/api/status"), getJson("/config/safety.json")]);
    Object.assign(state, { status, safety });
    await loadContent();
  } catch {
    toast(t("err.server"), "error");
  }
  try {
    state.uploads = (await store.all("docs")).sort((a, b) => b.addedAt - a.addedAt);
    state.notes = (await store.all("notes")).sort((a, b) => b.updatedAt - a.updatedAt);
    if (await store.isMemoryOnly()) toast(t("err.memoryOnly"), "error");
  } catch {
    toast(t("err.localRead"), "error");
  }
  $("#mockBanner").hidden = !state.status.mock;
  rebuildIndex();
  renderAll();
  if (!storageGet("unspoken.notice.v1")) renderWelcome();
}

init();
