// Service worker: makes repeat visits fast and lets the app open without a network connection.
// App files are served from the saved copy at once and refreshed in the background
// ("stale while revalidate"), so a new version shows up on the next visit.
// Account data and AI answers (api/) are never cached.
// Paths are relative to this file, so the app works at a site root or in a subfolder (GitHub Pages demo).
// Change CACHE when releasing a new version: the new worker then saves fresh copies of everything.
const CACHE = "unspoken-v3";
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

  // Any page address is the app itself.
  const key = request.mode === "navigate" ? SCOPE : request;

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(key);
      const refresh = fetch(request)
        .then((response) => {
          if (response.ok) cache.put(key, response.clone());
          return response;
        })
        .catch(() => undefined);
      if (cached) {
        event.waitUntil(refresh); // update the saved copy for next time
        return cached;
      }
      return (await refresh) || Response.error();
    })
  );
});
