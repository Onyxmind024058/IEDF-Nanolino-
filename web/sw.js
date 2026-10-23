// Service worker: keeps the RFEA Analyzer available offline.
// Files are served from the cache and refreshed in the background, so a new
// version appears on the next start. Bump VERSION when the file list changes.
const VERSION = "rfea-v2";

const APP_FILES = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "css/basel.css",
  "js/rfea-analysis.js",
  "js/app.js",
  "vendor/plotly-2.35.2.min.js",
  "icon.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(APP_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.open(VERSION).then(async (cache) => {
      // Opening the app with a file (file_handlers) or a query string still serves index.html
      const key = req.mode === "navigate" ? "./" : req;
      const cached = await cache.match(key, { ignoreSearch: req.mode === "navigate" });
      const network = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(key, res.clone());
          return res;
        })
        .catch(() => cached);
      if (cached) {
        event.waitUntil(network);
        return cached;
      }
      return network;
    })
  );
});
