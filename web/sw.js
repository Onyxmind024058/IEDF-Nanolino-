// Service worker: keeps the RFEA Analyzer available offline.
// Each release is cached as one complete set, downloaded fresh (bypassing the
// browser's HTTP cache), so a page never mixes files from two versions.
// VERSION must equal APP_VERSION in js/app.js (tests/pwa-check.cjs checks it):
// changing it is what makes browsers download the new release.
const VERSION = "rfea-2.1.1";

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
    caches.open(VERSION)
      .then((cache) => cache.addAll(APP_FILES.map((url) => new Request(url, { cache: "reload" }))))
      .then(() => self.skipWaiting())
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
  // Opening the app with a file (file_handlers) or a query string still serves index.html
  const key = req.mode === "navigate" ? "./" : req;
  event.respondWith(
    caches.open(VERSION)
      .then((cache) => cache.match(key, { ignoreSearch: req.mode === "navigate" }))
      .then((cached) => cached || fetch(req))
  );
});
