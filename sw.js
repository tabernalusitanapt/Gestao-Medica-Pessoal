const CACHE_NAME = "gestao-medica-shell-v15";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./app-icon.svg",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
  "./assets/fonts/lusitana-regular.ttf",
  "./assets/fonts/lusitana-bold.ttf",
  "./assets/ocr/tesseract.min.js",
  "./assets/ocr/worker.min.js",
  "./assets/ocr/core/tesseract-core-lstm.wasm.js",
  "./assets/ocr/core/tesseract-core-lstm.wasm",
  "./assets/ocr/lang/por.traineddata",
  "./assets/ocr/LICENSE",
  "./assets/ocr/core/LICENSE",
  "./assets/ocr/lang/LICENSE",
  "./assets/ocr/tesseract.min.js.LICENSE.txt",
  "./assets/ocr/worker.min.js.LICENSE.txt",
  "./assets/pdf/pdf.min.mjs",
  "./assets/pdf/pdf.worker.min.mjs",
  "./assets/pdf/LICENSE"
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request).then(response => {
      if (response.ok) {
        return caches.open(CACHE_NAME).then(cache => cache.put(event.request, response.clone())).then(() => response);
      }
      return response;
    }).catch(() => caches.match(event.request).then(cached => cached || (event.request.mode === "navigate" ? caches.match("./") : Response.error())))
  );
});
