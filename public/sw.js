// Service worker: lets the app open without a network connection.
// Network first, so users always get the latest version when online; the saved copy is only a fallback.
// Account data and AI answers (api/) are never cached.
// Paths are relative to this file, so the app works at a site root or in a subfolder (GitHub Pages demo).
const CACHE = "unspoken-v2";
const SCOPE = new URL("./", self.location).href;
const API_PREFIX = new URL("api/", SCOPE).pathname;
const APP_SHELL = [
  "./",
  "css/app.css",
  "js/app.js",
  "js/api.js",
  "js/i18n.js",
  "js/retrieval.js",
  "js/safety.js",
  "js/store.js",
  "js/parse.js",
  "js/templates.js",
  "vendor/marked.esm.js",
  "vendor/purify.es.mjs",
  "config/safety.json",
  "manifest.webmanifest",
  "favicon.svg",
  "icons/icon-192.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith(API_PREFIX)) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        // Any page address falls back to the app itself.
        if (request.mode === "navigate") return caches.match(SCOPE);
        return Response.error();
      })
  );
});
