// Extracts plain text from uploaded files, entirely in the browser.

export const ACCEPT = ".txt,.md,.pdf,.docx";
export const MAX_FILE_BYTES = 15 * 1024 * 1024;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("组件加载失败"));
    document.head.append(s);
  });
}

async function pdfToText(file) {
  const pdfjs = await import("/vendor/pdf.min.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.min.mjs";
  const doc = await pdfjs.getDocument({
    data: await file.arrayBuffer(),
    cMapUrl: "/vendor/cmaps/",
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
  await loadScript("/vendor/mammoth.browser.min.js");
  const result = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return result.value;
}

/** Return the text of a .txt / .md / .pdf / .docx file. Throws with a user-facing message. */
export async function fileToText(file) {
  if (file.size > MAX_FILE_BYTES) throw new Error("文件超过 15MB");
  const ext = file.name.split(".").pop().toLowerCase();
  let text;
  if (ext === "txt" || ext === "md") text = await file.text();
  else if (ext === "docx") text = await docxToText(file);
  else if (ext === "pdf") text = await pdfToText(file);
  else throw new Error("只支持 PDF、Word（.docx）、TXT 和 Markdown 文件");

  text = text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) {
    throw new Error(ext === "pdf" ? "没有提取到文字，可能是扫描版 PDF" : "文件里没有文字");
  }
  return text;
}
