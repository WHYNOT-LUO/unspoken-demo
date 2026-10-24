// Extracts plain text from uploaded files, entirely in the browser.
// Errors carry a `code` (tooBig | type | scanned | empty | load) for the UI to translate.

const fail = (code) => Object.assign(new Error(code), { code });

export const ACCEPT = ".txt,.md,.pdf,.docx";
export const MAX_FILE_BYTES = 15 * 1024 * 1024;

const vendor = (file) => new URL(`../vendor/${file}`, import.meta.url).href;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(fail("load"));
    document.head.append(s);
  });
}

async function pdfToText(file) {
  const pdfjs = await import(vendor("pdf.min.mjs"));
  pdfjs.GlobalWorkerOptions.workerSrc = vendor("pdf.worker.min.mjs");
  const doc = await pdfjs.getDocument({
    data: await file.arrayBuffer(),
    cMapUrl: vendor("cmaps/"),
    cMapPacked: true,
  }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    pages.push(content.items.map((it) => it.str + (it.hasEOL ? "\n" : "")).join(""));
  }
  return pages.join("\n\n");
}

async function docxToText(file) {
  await loadScript(vendor("mammoth.browser.min.js"));
  const result = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return result.value;
}

/** Return the text of a .txt / .md / .pdf / .docx file. Throws an error with a `code`. */
export async function fileToText(file) {
  if (file.size > MAX_FILE_BYTES) throw fail("tooBig");
  const ext = file.name.split(".").pop().toLowerCase();
  let text;
  if (ext === "txt" || ext === "md") text = await file.text();
  else if (ext === "docx") text = await docxToText(file);
  else if (ext === "pdf") text = await pdfToText(file);
  else throw fail("type");

  text = text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) throw fail(ext === "pdf" ? "scanned" : "empty");
  return text;
}
