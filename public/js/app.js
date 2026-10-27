import { marked } from "../vendor/marked.esm.js";
import DOMPurify from "../vendor/purify.es.mjs";
import { buildIndex, search, isFollowUp } from "./retrieval.js";
import { detectCrisis, visibleHotlines } from "./safety.js";
import * as localStore from "./store.js"; // only to import notes saved in the browser before accounts
import { get, put, post, patch, del, setUnauthorizedHandler } from "./api.js";
import { fileToText, ACCEPT } from "./parse.js";
import { TEMPLATES } from "./templates.js";
import { t, setLang, getLang, detectLang } from "./i18n.js";

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

/** User-facing text for any API or network error. */
function errorText(err) {
  const msg = t(`err.${err?.code}`);
  return msg.startsWith("err.") ? t("err.generic") : msg;
}

function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function storageSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode: ignore */ }
}
function storageRemove(key) {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

// ---------- state ----------

const state = {
  user: null,
  authMode: "login",
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

/**
 * Courses and platform references in the current language (English falls back to Chinese).
 * The reference library is large, so it loads in the background without holding up the first screen.
 */
async function loadContent() {
  const lang = getLang();
  state.courses = await get(`/api/courses?lang=${lang}`);
  rebuildIndex();
  loadLibrary(lang);
}

async function loadLibrary(lang, attempt = 1) {
  try {
    const library = await get(`/api/library?lang=${lang}`);
    if (lang !== getLang() || !state.user) return; // language changed or signed out while it was loading
    state.library = library;
    rebuildIndex();
    renderLibrary();
    renderScope();
  } catch (err) {
    if (!state.user || err.status === 401 || lang !== getLang()) return;
    if (attempt < 3) setTimeout(() => loadLibrary(lang, attempt + 1), 3000 * attempt);
    else toast(errorText(err), "error");
  }
}

function renderAll() {
  applyStaticText();
  renderPlanLine();
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
  applyStaticText();
  if (!state.user) {
    state.langChosenSignedOut = true; // applied to the account at the next login
    return state.offline ? showOffline() : renderAuth({ keepValues: true });
  }
  patch("/api/me", { lang: getLang() }).catch(() => {});
  try {
    await loadContent();
  } catch (err) {
    toast(errorText(err), "error");
  }
  renderAll();
  if ($("#dialog").open && $("#dialog").dataset.kind === "welcome") renderWelcome();
  if ($("#dialog").open && $("#dialog").dataset.kind === "account") openAccount();
}

// ---------- navigation ----------

function setView(view) {
  state.view = view;
  document.body.dataset.view = view;
  for (const b of document.querySelectorAll("[data-nav]")) b.classList.toggle("active", b.dataset.nav === view);
  hideSelToolbar();
  if (view === "chat") scrollMessages(true);
}

// ---------- role & progress (saved in the account) ----------

const ROLES = ["parent", "student"];

function setRole(role) {
  state.role = ROLES.includes(role) ? role : "";
  renderCourses();
  patch("/api/me", { role: state.role }).catch((err) => toast(errorText(err), "error"));
}

async function toggleDone(id) {
  const wasDone = state.done.has(id);
  if (wasDone) state.done.delete(id);
  else state.done.add(id);
  renderCourses();
  try {
    if (wasDone) await del(`/api/progress/${encodeURIComponent(id)}`);
    else await put(`/api/progress/${encodeURIComponent(id)}`);
  } catch (err) {
    if (wasDone) state.done.add(id);
    else state.done.delete(id);
    renderCourses();
    toast(errorText(err), "error");
  }
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
    unsavedNotes.add(note);
    const saved = await flushNotes();
    renderNotes();
    toast(saved ? t("save.done", { t: note.title }) : t("notes.saveFailed"), saved ? "" : "error");
  };
}

// ---------- library (uploads) ----------

/** Platform references grouped by collection; ungrouped ones first. */
function libraryGroups() {
  const groups = new Map([["", []]]);
  for (const d of state.library) {
    if (!groups.has(d.group)) groups.set(d.group, []);
    groups.get(d.group).push(d);
  }
  return [...groups].filter(([, docs]) => docs.length);
}

const groupLabel = (group) => (t(`lib.group.${group}`).startsWith("lib.") ? group : t(`lib.group.${group}`));

function docItem(doc, { removable }) {
  const open = state.openDocId === doc.key;
  return `
    <li class="doc" data-doc="${esc(doc.key)}">
      <div class="doc-row">
        <span class="doc-title">${esc(doc.title)}</span>
        <span class="doc-meta">${t("lib.chars", { n: doc.text.length.toLocaleString() })}${doc.addedAt ? ` · ${fmtDate(doc.addedAt)}` : ""}</span>
        <span class="doc-actions">
          <button class="ghost small" data-act="toggle">${open ? t("lib.hide") : t("lib.view")}</button>
          <button class="primary small" data-act="ask">${t("lib.ask")}</button>
          ${removable ? `<button class="danger-btn small" data-act="delete">${t("common.delete")}</button>` : ""}
        </span>
      </div>
      ${open ? `<div class="doc-preview">${esc(doc.text.slice(0, 4000))}${doc.text.length > 4000 ? "\n……" : ""}</div>` : ""}
      ${open && doc.url ? `<a class="doc-source" href="${esc(doc.url)}" target="_blank" rel="noopener">${t("lib.original")}</a>` : ""}
    </li>`;
}

function renderLibrary() {
  const el = $("#view-library");
  const uploads = state.uploads.map((d) => docItem({ ...d, key: `upload:${d.id}` }, { removable: true })).join("");
  const loading = state.loadingFiles.map((n) => `<li class="doc loading">${esc(t("lib.loading", { n }))}</li>`).join("");
  const platform = libraryGroups()
    .map(
      ([group, docs]) => `
    <h2 class="section-title">${group ? esc(groupLabel(group)) : t("lib.platform")}</h2>
    ${group && !t(`lib.credit.${group}`).startsWith("lib.") ? `<p class="hint credit">${t(`lib.credit.${group}`)}</p>` : ""}
    <ul class="doc-list">${docs.map((d) => docItem({ ...d, key: `library:${d.id}` }, { removable: false })).join("")}</ul>`
    )
    .join("");

  el.innerHTML = `
    <div class="view-head"><h1>${t("lib.title")}</h1></div>
    <p class="hint">${t("lib.hint")}</p>
    <label class="dropzone" id="dropzone">
      <strong>${t("lib.upload")}</strong>
      ${t("lib.drop")}
      <input type="file" id="fileInput" accept="${ACCEPT}" multiple>
    </label>
    ${uploads || loading ? `<ul class="doc-list">${loading}${uploads}</ul>` : `<div class="empty"><p>${t("lib.empty")}</p></div>`}
    ${platform}`;
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
      await put(`/api/docs/${encodeURIComponent(doc.id)}`, { title: doc.title, name: doc.name, text: doc.text, addedAt: doc.addedAt });
      state.uploads.unshift(doc);
      toast(t("lib.added", { t: doc.title }));
    } catch (err) {
      const fileReason = t(`err.file.${err.code}`);
      const reason = fileReason.startsWith("err.") ? errorText(err) : fileReason;
      toast(t("lib.readFail", { n: file.name, e: reason }), "error");
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
    state.scope = key;
    renderScope();
    setView("chat");
    if (!isPhone()) $("#question").focus();
  } else if (act === "delete") {
    const doc = state.uploads.find((d) => d.id === id);
    if (!confirm(t("lib.confirmDelete", { t: doc.title }))) return;
    try {
      await del(`/api/docs/${encodeURIComponent(id)}`);
    } catch (err) {
      if (err.status !== 404) return toast(errorText(err), "error");
    }
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

let retryTimer = null;

const pushNote = (n, options) =>
  put(`/api/notes/${encodeURIComponent(n.id)}`, { title: n.title, body: n.body, createdAt: n.createdAt, updatedAt: n.updatedAt }, options);

/** Saves every queued note. Failed saves stay queued and are retried. Returns true when all were saved. */
async function flushNotes({ unloading = false } = {}) {
  if (!state.user) return false;
  const notes = [...unsavedNotes];
  unsavedNotes.clear();
  // While the page closes, small saves can still complete (browsers cap keepalive bodies at 64 KB).
  const results = await Promise.allSettled(
    notes.map((n) => pushNote(n, { keepalive: unloading && n.body.length < 15000 }))
  );
  const failed = notes.filter((n, i) => results[i].status === "rejected" && state.notes.includes(n));
  for (const n of failed) unsavedNotes.add(n);
  const s = $("#saveState");
  clearTimeout(retryTimer);
  if (failed.length) {
    if (s) s.textContent = t("notes.saveFailed");
    if (!unloading) retryTimer = setTimeout(() => flushNotes(), 5000);
    return false;
  }
  if (s && !unsavedNotes.size) s.textContent = t("notes.saved");
  return true;
}

const flushNotesSoon = debounce(flushNotes, 400);
addEventListener("pagehide", () => flushNotes({ unloading: true }));
document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flushNotes({ unloading: true }));

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
  unsavedNotes.add(note);
  renderNotes();
  flushNotes();
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
    unsavedNotes.add(note);
    flushNotes();
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

  // Same as chat: crisis language is answered here and never leaves the browser.
  if (detectCrisis(text, state.safety.keywords)) return finish(crisisHtml());

  fetch("api/assist", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task, text, role: state.role, lang: getLang() }),
    signal: controller.signal,
  })
    .then(async (res) => {
      if ((res.headers.get("content-type") || "").includes("application/json")) {
        const data = await res.json();
        if (res.status === 401) return showAuth("expired");
        if (res.status === 402) return showUpgrade();
        return finish(data.type === "crisis" ? crisisHtml() : `<p class="msg error">${esc(serverError(data))}</p>`);
      }
      await readStream(res, (chunk) => {
        result += chunk;
        out.innerHTML = md(result);
      });
      result = result.trim();
      finish(result ? md(result) : `<p class="msg error">${t("err.noResult")}</p>`);
      if (!state.status.demo) refreshUser();
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
    try {
      await del(`/api/notes/${encodeURIComponent(note.id)}`);
    } catch (err) {
      if (err.status !== 404) {
        unsavedNotes.add(note);
        return toast(errorText(err), "error");
      }
    }
    state.notes = state.notes.filter((n) => n !== note);
    state.noteId = null;
    renderNotes();
  }
});

// ---------- chat ----------

/** "Answer from" choices, in groups: everything, each reference collection, the user's uploads. */
function scopeOptions() {
  const groups = [{ label: "", options: [{ value: "courses", label: t("scope.courses") }] }];
  for (const [group, docs] of libraryGroups()) {
    if (!group) continue;
    groups.push({
      label: groupLabel(group),
      options: [{ value: `group:${group}`, label: t("scope.wholeGroup") }, ...docs.map((d) => ({ value: `library:${d.id}`, label: d.title }))],
    });
  }
  if (state.uploads.length) {
    groups.push({
      label: t("scope.mine"),
      options: [{ value: "uploads", label: t("scope.uploads") }, ...state.uploads.map((d) => ({ value: `upload:${d.id}`, label: d.title }))],
    });
  }
  return groups;
}

function renderScope() {
  const groups = scopeOptions();
  if (!groups.some((g) => g.options.some((o) => o.value === state.scope))) state.scope = "courses";
  const option = (o) => `<option value="${esc(o.value)}" ${o.value === state.scope ? "selected" : ""}>${esc(o.label)}</option>`;
  $("#scope").innerHTML = groups
    .map((g) => (g.label ? `<optgroup label="${esc(g.label)}">${g.options.map(option).join("")}</optgroup>` : g.options.map(option).join("")))
    .join("");
}

$("#scope").addEventListener("change", (e) => (state.scope = e.target.value));

function scopeDocIds() {
  if (state.scope === "courses") {
    return [...state.courses.map((d) => `course:${d.id}`), ...state.library.map((d) => `library:${d.id}`)];
  }
  if (state.scope === "uploads") return state.uploads.map((d) => `upload:${d.id}`);
  if (state.scope.startsWith("group:")) {
    const group = state.scope.slice(6);
    return state.library.filter((d) => d.group === group).map((d) => `library:${d.id}`);
  }
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

/** Sources the finished answer cites as [n], keeping their numbers. While the answer streams in, all of them. */
function shownSources(m) {
  const all = m.sources.map((s, i) => ({ ...s, n: i + 1 }));
  if (m.pending) return all;
  const cited = new Set([...String(m.content).matchAll(/\[(\d{1,2})\]/g)].map((x) => Number(x[1])));
  return all.filter((s) => cited.has(s.n));
}

function messageHtml(m, i) {
  if (m.role === "user") return `<div class="msg user">${esc(m.content)}</div>`;
  if (m.kind === "crisis") return `<div class="msg">${crisisHtml()}<small class="hint">${t("chat.notSent")}</small></div>`;
  if (m.kind === "notice") return `<div class="msg notice">${esc(t(m.key))}</div>`;
  if (m.kind === "error") return `<div class="msg error">${esc(m.key ? t(m.key) : m.content)}</div>`;

  const shown = shownSources(m);
  const sources = shown
    .map(
      (s) => `
      <details class="src">
        <summary><span>[${s.n}] ${esc(quote(s.title))}</span><span class="kind">${t(`kind.${s.kind}`)}</span></summary>
        <blockquote>${esc(s.text)}</blockquote>
      </details>`
    )
    .join("");
  return `
    <div class="msg ai" data-i="${i}">
      <div class="prose">${m.content ? md(withCites(m.content, m.sources.length)) : ""}</div>
      ${m.pending ? `<span class="typing" data-label="${esc(t("chat.sending"))}"></span>` : ""}
      ${
        shown.length
          ? `<div class="sources"><span class="sources-label">${t("chat.sources")}</span>${sources}</div>`
          : `<p class="general-note">${t("chat.general")}</p>`
      }
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

  // Material first: the best passages go to the model. With no match, the model still answers,
  // from general knowledge, and the answer is labelled as such.
  const docIds = scopeDocIds();
  let hits = docIds.length ? search(state.index, question, { topK: 5, docIds }) : [];
  const previous = lastAnsweredQuestion(userIndex);
  if (!hits.length && docIds.length && previous && isFollowUp(question)) {
    hits = search(state.index, `${previous} ${question}`, { topK: 5, docIds });
  }

  const msg = { role: "assistant", kind: "answer", content: "", pending: true, question, sources: mergeByDoc(hits) };
  const i = state.messages.push(msg) - 1;
  state.busy = true;
  updateComposer();
  renderMessages();

  try {
    const res = await fetch("api/chat", {
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
      if (res.status === 401) showAuth("expired");
      if (res.status === 402) showUpgrade();
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
    if (state.user && !state.status.demo) refreshUser();
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
  const sourceList = shownSources(m).map((s) => `[${s.n}] ${quote(s.title)}`).join(" ");
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

// ---------- free trial and membership ----------

const fmtDay = (ms) => new Date(ms).toLocaleDateString(getLang() === "en" ? "en-GB" : "zh-CN", { dateStyle: "long" });

function renderPlanLine() {
  const el = $("#planLine");
  const plan = state.user?.plan;
  if (!plan || state.status.demo || plan.paidUntil) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const text = plan.freeLeft > 0 ? t("plan.freeLeft", { n: plan.freeLeft }) : t("plan.freeNone");
  el.innerHTML = `<span>${esc(text)}</span><button type="button" class="linklike" data-open="upgrade">${t("plan.upgrade")}</button>`;
}

/** Re-reads the account after an AI call, so the trial counter stays right. */
async function refreshUser() {
  try {
    const { user } = await get("/api/me");
    if (user) {
      state.user = user;
      renderPlanLine();
    }
  } catch {
    /* the counter just stays as it was */
  }
}

function showUpgrade() {
  const plan = state.user?.plan || {};
  const info = state.status.plan || {};
  const body = plan.paidUntil
    ? t("plan.member", { date: fmtDay(plan.paidUntil) })
    : plan.freeLeft > 0
      ? t("plan.bodyFree", { n: plan.freeLeft, days: info.days, limit: info.dailyLimit })
      : t("plan.bodyUsedUp", { days: info.days, limit: info.dailyLimit });
  const email = esc(state.user?.email || "");
  const steps = [
    info.qr ? `<li>${t("plan.step1")}</li>` : "",
    `<li>${info.contact ? t("plan.step2", { email, contact: esc(info.contact) }) : t("plan.step2NoContact", { email })}</li>`,
    `<li>${t("plan.step3")}</li>`,
  ].join("");
  const howTo =
    plan.paidUntil
      ? ""
      : info.qr || info.contact
        ? `<h3>${t("plan.howTitle")}</h3><ol>${steps}</ol>${info.qr ? `<img class="pay-qr" src="api/pay/qr" alt="${t("plan.qrAlt")}">` : ""}`
        : `<p class="meta">${t("plan.notSetUp")}</p>`;
  showInfo(
    "upgrade",
    `<h2>${t("plan.title")}</h2>
    <p>${body}</p>
    ${info.price && !plan.paidUntil ? `<p><b>${t("plan.price", { price: esc(info.price) })}</b></p>` : ""}
    ${howTo}`
  );
}

// ---------- help, about, welcome ----------

function showInfo(kind, html) {
  openDialog(kind, `<form method="dialog" class="dlg">${html}<menu><button value="ok" class="primary">${t("common.ok")}</button></menu></form>`);
}

function showHelp() {
  showInfo("help", `<h2>${t("help.title")}</h2>${crisisHtml()}`);
}

function showAbout() {
  const role = ROLES.includes(state.role) ? t(`role.${state.role}`) : t("role.none");
  const mode = state.status.demo ? t("demo.mode") : state.status.mock ? t("about.mock") : t("about.live", { m: esc(state.status.model) });
  showInfo(
    "about",
    `<h2>${t("about.title")}</h2>
    <p>${esc(safetyText("disclaimer"))}</p>
    <p class="meta">${t("about.data")}</p>
    <p class="meta">${t("about.role", { r: role })}</p>
    <p class="meta">${t("about.mode", { m: mode })}</p>`
  );
}

/** Shown once, right after sign-up: pick a role so lessons can be recommended. */
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
    if (ROLES.includes(dlg.returnValue)) setRole(dlg.returnValue);
    offerImport();
  };
}

// ---------- sign in / sign up ----------

function renderAuth({ message = "", keepValues = false } = {}) {
  const el = $("#auth");
  const old = keepValues ? Object.fromEntries(new FormData($("#authForm") || undefined)) : {};
  const signup = state.authMode === "signup";
  el.innerHTML = `
    <div class="auth-card">
      <div class="auth-top">
        <span class="brand-mark">${t("brand.mark")}</span>
        <button type="button" class="lang-btn" data-lang-toggle aria-label="${t("lang.switchAria")}">${t("lang.switch")}</button>
      </div>
      <p class="auth-tagline">${t("auth.tagline")}</p>
      <span class="tabs auth-tabs" role="tablist">
        <button type="button" role="tab" data-auth-mode="login" class="${signup ? "" : "on"}" aria-selected="${!signup}">${t("auth.login")}</button>
        <button type="button" role="tab" data-auth-mode="signup" class="${signup ? "on" : ""}" aria-selected="${signup}">${t("auth.signup")}</button>
      </span>
      <form class="auth-form" id="authForm" novalidate>
        <label>${t("auth.email")}
          <input type="email" name="email" autocomplete="email" required value="${esc(old.email || "")}">
        </label>
        <label>${t("auth.password")}${signup ? ` <small>(${t("auth.passwordHint")})</small>` : ""}
          <input type="password" name="password" autocomplete="${signup ? "new-password" : "current-password"}" required>
        </label>
        ${
          signup
            ? `<label>${t("auth.invite")}
                 <input type="text" name="invite" autocomplete="off" autocapitalize="characters" spellcheck="false" required value="${esc(old.invite || "")}">
               </label>
               <p class="auth-note">${esc(safetyText("disclaimer"))}</p>
               <label class="check"><input type="checkbox" name="agree" ${old.agree ? "checked" : ""}> <span>${t("auth.agree")}</span></label>`
            : ""
        }
        <p class="auth-error" id="authError" role="alert">${esc(message)}</p>
        <button type="submit" class="primary" id="authSubmit">${signup ? t("auth.submitSignup") : t("auth.submitLogin")}</button>
        <p class="auth-note">${signup ? t("auth.inviteOnly") : t("auth.forgot")}</p>
      </form>
    </div>`;
}

function showAuth(reason = "") {
  const expired = reason === "expired" && state.user;
  // Keep edits that have not reached the server; they are saved after the same user logs back in.
  if (state.user) {
    state.pendingFor = state.user.email;
    state.authMode = "login"; // someone who was signed in only needs to log back in
  }
  state.user = null;
  document.body.dataset.auth = "out";
  if ($("#dialog").open) $("#dialog").close();
  renderAuth({ message: expired ? t("auth.expired") : "" });
}

/** Started without a connection: say so, rather than showing a login form. */
function showOffline() {
  state.offline = true;
  document.body.dataset.auth = "out";
  $("#auth").innerHTML = `
    <div class="auth-card">
      <div class="auth-top">
        <span class="brand-mark">${t("brand.mark")}</span>
        <button type="button" class="lang-btn" data-lang-toggle aria-label="${t("lang.switchAria")}">${t("lang.switch")}</button>
      </div>
      <p>${t("pwa.offlineStart")}</p>
      <button type="button" class="primary" data-retry>${t("pwa.retry")}</button>
    </div>`;
}

$("#auth").addEventListener("click", (e) => {
  if (e.target.closest("[data-retry]")) return location.reload();
  const mode = e.target.closest("[data-auth-mode]")?.dataset.authMode;
  if (mode && mode !== state.authMode) {
    state.authMode = mode;
    renderAuth({ keepValues: true });
  }
});

$("#auth").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const data = Object.fromEntries(new FormData(form));
  const signup = state.authMode === "signup";
  const error = (msg) => ($("#authError").textContent = msg);
  if (!data.email?.trim() || !data.password || (signup && !data.invite?.trim())) return error(t("auth.needFields"));
  if (signup && !data.agree) return error(t("auth.needAgree"));
  const button = $("#authSubmit");
  button.disabled = true;
  button.textContent = t("auth.working");
  try {
    const { user } = signup
      ? await post("/api/auth/register", { email: data.email.trim(), password: data.password, invite: data.invite.trim(), lang: getLang() })
      : await post("/api/auth/login", { email: data.email.trim(), password: data.password });
    await enterApp(user, { isNew: signup });
  } catch (err) {
    error(errorText(err));
    button.disabled = false;
    button.textContent = signup ? t("auth.submitSignup") : t("auth.submitLogin");
  }
});

/** Load everything that belongs to this account and show the app. */
async function enterApp(user, { isNew = false } = {}) {
  const sameUserAsBefore = state.pendingFor === user.email;
  state.pendingFor = null;
  if (!sameUserAsBefore) {
    unsavedNotes.clear();
    resetUserState();
  }
  state.user = user;
  if (user.lang && user.lang !== getLang() && !state.langChosenSignedOut) {
    setLang(user.lang);
    storageSet("unspoken.lang", user.lang);
  } else if (user.lang !== getLang()) {
    patch("/api/me", { lang: getLang() }).catch(() => {});
  }
  state.langChosenSignedOut = false;
  state.role = ROLES.includes(user.role) ? user.role : "";
  document.body.dataset.auth = "in";
  setView("courses");
  try {
    const [notes, docs, done] = await Promise.all([get("/api/notes"), get("/api/docs"), get("/api/progress"), loadContent()]);
    const waiting = new Map([...unsavedNotes].map((n) => [n.id, n]));
    state.notes = [...waiting.values(), ...notes.filter((n) => !waiting.has(n.id))].sort((a, b) => b.updatedAt - a.updatedAt);
    unsavedNotes.clear();
    for (const n of waiting.values()) unsavedNotes.add(state.notes.find((x) => x.id === n.id));
    state.uploads = docs;
    state.done = new Set(done);
  } catch (err) {
    toast(errorText(err), "error");
  }
  if (unsavedNotes.size) flushNotes();
  rebuildIndex();
  renderAll();
  if (isNew) renderWelcome();
  else offerImport();
}

function resetUserState() {
  Object.assign(state, {
    uploads: [],
    notes: [],
    done: new Set(),
    role: "",
    messages: [],
    courseId: null,
    noteId: null,
    noteQuery: "",
    openDocId: null,
    scope: "courses",
  });
}

async function logout() {
  await flushNotes();
  try {
    await post("/api/auth/logout");
  } catch {
    /* the cookie is cleared server-side when reachable; the screen changes either way */
  }
  unsavedNotes.clear();
  state.pendingFor = null;
  resetUserState();
  state.user = null;
  state.authMode = "login";
  showAuth();
}

// ---------- account ----------

function openDemoAccount() {
  const dlg = openDialog(
    "account",
    `<div class="dlg">
      <h2>${t("account.title")}</h2>
      <p>${t("demo.accountNote")}</p>
      <button type="button" class="ghost" data-acc="export">${t("account.exportAll")}</button>
      <button type="button" class="danger-btn" data-acc="reset">${t("demo.reset")}</button>
      <menu><button type="button" class="primary" data-acc="close">${t("account.close")}</button></menu>
    </div>`
  );
  dlg.querySelector(".dlg").addEventListener("click", async (e) => {
    const act = e.target.closest("[data-acc]")?.dataset.acc;
    if (act === "close") dlg.close();
    if (act === "export") {
      downloadText(t("notes.exportName", { date: new Date().toISOString().slice(0, 10) }), state.notes.map(noteMarkdown).join("\n---\n\n"));
    }
    if (act === "reset") {
      await del("/api/me", {});
      storageRemove("unspoken.demo.welcomed");
      location.reload();
    }
  });
}

function openAccount() {
  const u = state.user;
  if (!u) return;
  if (state.status.demo) return openDemoAccount();
  const joined = new Date(u.createdAt).toLocaleDateString(getLang() === "en" ? "en-GB" : "zh-CN", { dateStyle: "long" });
  const dlg = openDialog(
    "account",
    `<div class="dlg">
      <h2>${t("account.title")}</h2>
      <p class="meta">${esc(u.email)} · ${t("account.joined", { date: joined })}</p>
      <hr>
      <h3>${t("account.planTitle")}</h3>
      <p class="meta">${
        u.plan?.paidUntil
          ? t("plan.member", { date: fmtDay(u.plan.paidUntil) })
          : u.plan?.freeLeft > 0
            ? t("plan.freeLeft", { n: u.plan.freeLeft })
            : t("plan.freeNone")
      }</p>
      ${u.plan?.paidUntil ? "" : `<button type="button" class="primary" data-open="upgrade">${t("plan.upgrade")}</button>`}
      <hr>
      <h3>${t("account.pwTitle")}</h3>
      <div class="field-row">
        <input type="password" id="pwCurrent" autocomplete="current-password" placeholder="${t("account.pwCurrent")}" aria-label="${t("account.pwCurrent")}">
        <input type="password" id="pwNew" autocomplete="new-password" placeholder="${t("account.pwNew")}" aria-label="${t("account.pwNew")}">
        <button type="button" class="ghost" data-acc="password">${t("account.pwSave")}</button>
        <p id="pwMsg" role="status"></p>
      </div>
      <hr>
      <h3>${t("account.dataTitle")}</h3>
      <p class="meta">${t("account.dataNote")}</p>
      <button type="button" class="ghost" data-acc="export">${t("account.exportAll")}</button>
      <hr>
      <h3>${t("account.deleteTitle")}</h3>
      <p class="meta">${t("account.deleteNote")}</p>
      <div class="field-row">
        <input type="password" id="delPassword" autocomplete="current-password" placeholder="${t("auth.password")}" aria-label="${t("auth.password")}">
        <button type="button" class="danger-btn" data-acc="delete">${t("account.deleteBtn")}</button>
        <p id="delMsg" role="status"></p>
      </div>
      <menu>
        <button type="button" class="ghost" data-acc="logout">${t("account.logout")}</button>
        <button type="button" class="primary" data-acc="close">${t("account.close")}</button>
      </menu>
    </div>`
  );

  dlg.querySelector(".dlg").addEventListener("click", async (e) => {
    const act = e.target.closest("[data-acc]")?.dataset.acc;
    if (!act) return;
    const say = (id, text, ok) => {
      const el = $(id, dlg);
      el.textContent = text;
      el.className = ok ? "ok" : "bad";
    };
    const passwordError = (err) => (err.code === "bad_credentials" ? t("account.wrongPassword") : errorText(err));
    if (act === "close") dlg.close();
    if (act === "logout") {
      dlg.close();
      logout();
    }
    if (act === "export") {
      downloadText(t("notes.exportName", { date: new Date().toISOString().slice(0, 10) }), state.notes.map(noteMarkdown).join("\n---\n\n"));
    }
    if (act === "password") {
      try {
        await post("/api/me/password", { current: $("#pwCurrent", dlg).value, next: $("#pwNew", dlg).value });
        $("#pwCurrent", dlg).value = "";
        $("#pwNew", dlg).value = "";
        say("#pwMsg", t("account.pwDone"), true);
      } catch (err) {
        say("#pwMsg", passwordError(err), false);
      }
    }
    if (act === "delete") {
      try {
        await del("/api/me", { password: $("#delPassword", dlg).value });
        dlg.close();
        unsavedNotes.clear();
        state.pendingFor = null;
        resetUserState();
        state.user = null;
        showAuth();
        toast(t("account.deleted"));
      } catch (err) {
        say("#delMsg", passwordError(err), false);
      }
    }
  });
}

// ---------- import what was saved in this browser before accounts ----------

async function offerImport() {
  if (state.status.demo || storageGet("unspoken.importSkip")) return;
  let notes = [];
  let docs = [];
  try {
    notes = await localStore.all("notes");
    docs = await localStore.all("docs");
  } catch {
    /* nothing stored locally */
  }
  let done = [];
  try {
    done = JSON.parse(storageGet("unspoken.done") || "[]");
  } catch {
    /* ignore */
  }
  if (!notes.length && !docs.length && !done.length) return;

  const dlg = openDialog(
    "import",
    `<form method="dialog" class="dlg">
      <h2>${t("import.title")}</h2>
      <p>${t("import.body", { notes: notes.length, docs: docs.length, done: done.length })}</p>
      <menu>
        <button value="never" class="ghost">${t("import.never")}</button>
        <button value="later" class="ghost">${t("import.later")}</button>
        <button value="yes" class="primary">${t("import.yes")}</button>
      </menu>
    </form>`
  );
  dlg.onclose = async () => {
    if (dlg.returnValue === "never") return storageSet("unspoken.importSkip", "1");
    if (dlg.returnValue !== "yes") return;
    let failed = 0;
    for (const n of notes) {
      try {
        await pushNote({ id: n.id, title: n.title || "", body: n.body || "", createdAt: n.createdAt, updatedAt: n.updatedAt });
        await localStore.remove("notes", n.id);
      } catch {
        failed++;
      }
    }
    for (const d of docs) {
      try {
        await put(`/api/docs/${encodeURIComponent(d.id)}`, { title: d.title, name: d.name || "", text: d.text, addedAt: d.addedAt });
        await localStore.remove("docs", d.id);
      } catch {
        failed++;
      }
    }
    for (const id of done) {
      try {
        await put(`/api/progress/${encodeURIComponent(id)}`);
      } catch {
        failed++;
      }
    }
    if (!failed) storageRemove("unspoken.done");
    try {
      const [serverNotes, serverDocs, serverDone] = await Promise.all([get("/api/notes"), get("/api/docs"), get("/api/progress")]);
      state.notes = serverNotes;
      state.uploads = serverDocs;
      state.done = new Set(serverDone);
    } catch {
      /* keep what is shown */
    }
    rebuildIndex();
    renderAll();
    toast(failed ? t("import.partial") : t("import.done"), failed ? "error" : "");
  };
}

// ---------- global clicks ----------

document.addEventListener("click", (e) => {
  if (e.target.closest("[data-lang-toggle]")) return switchLang();
  const open = e.target.closest("[data-open]")?.dataset.open;
  if (open === "help") showHelp();
  if (open === "about") showAbout();
  if (open === "account") openAccount();
  if (open === "upgrade") showUpgrade();
  const nav = e.target.closest("[data-nav]")?.dataset.nav;
  if (nav) setView(nav);
});

// ---------- start ----------

// Installable app: the service worker lets the app open offline; data still needs the network.
if ("serviceWorker" in navigator) {
  addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
addEventListener("offline", () => toast(t("pwa.offline"), "error"));
addEventListener("online", () => {
  toast(t("pwa.online"));
  if (unsavedNotes.size) flushNotes();
});

async function init() {
  setLang(detectLang(storageGet("unspoken.lang"), navigator.languages || [navigator.language]));
  applyStaticText();
  setUnauthorizedHandler(() => showAuth("expired"));
  // Ask "who am I?" at the same time as the status, instead of one after the other.
  const meRequest = get("/api/me").then(
    (data) => ({ data }),
    (err) => ({ err })
  );
  try {
    const [status, safety] = await Promise.all([getJson("api/status"), getJson("config/safety.json")]);
    Object.assign(state, { status, safety });
  } catch {
    toast(t("err.server"), "error");
  }
  $("#mockBanner").hidden = !state.status.mock;
  if (state.status.demo) {
    $("#mockBanner").dataset.i18n = "demo.banner";
    applyStaticText();
  }
  try {
    const { data, err } = await meRequest;
    if (err) throw err;
    const { user } = data;
    if (user) await enterApp(user);
    else showAuth();
    if (state.status.demo && !storageGet("unspoken.demo.welcomed")) {
      storageSet("unspoken.demo.welcomed", "1");
      renderWelcome();
    }
  } catch (err) {
    if (err.code === "network") return showOffline();
    showAuth();
    toast(errorText(err), "error");
  }
}

init();
