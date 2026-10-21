// Copies the browser builds of third-party libraries into public/vendor,
// so the demo runs without any CDN (CDNs are unreliable from mainland China).
import { copyFileSync, cpSync, mkdirSync } from "node:fs";

const files = [
  ["node_modules/marked/lib/marked.esm.js", "marked.esm.js"],
  ["node_modules/dompurify/dist/purify.es.mjs", "purify.es.mjs"],
  ["node_modules/mammoth/mammoth.browser.min.js", "mammoth.browser.min.js"],
  ["node_modules/pdfjs-dist/build/pdf.min.mjs", "pdf.min.mjs"],
  ["node_modules/pdfjs-dist/build/pdf.worker.min.mjs", "pdf.worker.min.mjs"],
];

mkdirSync("public/vendor", { recursive: true });
for (const [from, to] of files) {
  copyFileSync(from, `public/vendor/${to}`);
  console.log(`vendor: ${to}`);
}

// Character maps let pdf.js extract text from Chinese PDFs that use CID fonts.
cpSync("node_modules/pdfjs-dist/cmaps", "public/vendor/cmaps", { recursive: true });
console.log("vendor: cmaps/");
