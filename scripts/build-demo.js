// Builds the static GitHub Pages demo into dist-demo/:
// the normal web app, plus demo/demo-backend.js (an in-browser stand-in for the server)
// and the lessons as JSON. No server, no accounts, no AI calls.
import { cpSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalized } from "../lib/content.js";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(APP_DIR, "dist-demo");

rmSync(OUT, { recursive: true, force: true });
cpSync(join(APP_DIR, "public"), OUT, { recursive: true });
cpSync(join(APP_DIR, "demo", "demo-backend.js"), join(OUT, "js", "demo-backend.js"));

mkdirSync(join(OUT, "demo-data"));
for (const lang of ["zh", "en"]) {
  for (const kind of ["courses", "library"]) {
    const docs = loadLocalized(join(APP_DIR, "content", kind), lang);
    writeFileSync(join(OUT, "demo-data", `${kind}-${lang}.json`), JSON.stringify(docs));
  }
}

// The stand-in must run before the app, so it can answer the app's first requests.
const indexFile = join(OUT, "index.html");
const appScript = '<script type="module" src="js/app.js"></script>';
const html = readFileSync(indexFile, "utf8");
if (!html.includes(appScript)) throw new Error("index.html no longer loads js/app.js the expected way");
writeFileSync(indexFile, html.replace(appScript, `<script type="module" src="js/demo-backend.js"></script>\n  ${appScript}`));

writeFileSync(join(OUT, ".nojekyll"), ""); // serve files as they are
console.log(`Demo built in ${OUT}`);
