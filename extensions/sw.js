/* pi-mail Console service worker — caches the app shell for offline load.
 *
 * Strategy (per the PWA spec): the static shell is cache-first with a network
 * fallback (each cache hit also re-validates in the background so a live
 * console picks up edits), while navigations are network-first so the HTML is
 * always fresh and falls back to the cached shell when offline. API + SSE
 * requests are never cached — they pass straight through to the network.
 *
 * Bump CACHE_VERSION to invalidate the whole shell after a structural change.
 */
const CACHE_VERSION = "pi-mail-shell-v1";

const SHELL = [
  "/",
  "/manifest.webmanifest",
  "/ui.css",
  "/ui-core.js",
  "/ui-board.js",
  "/ui-board-modal.js",
  "/ui-board-settings.js",
  "/ui-spawn.js",
  "/ui-terminal.js",
  "/ui-mailbox.js",
  "/ui-logs.js",
  "/ui-costs.js",
  "/ui-app.js",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-192.png",
  "/icon-maskable-512.png",
  "https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js",
  "https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // POSTs, SSE, and WebSocket pass through

  const url = new URL(req.url);

  // API + SSE endpoints always hit the network (never cached).
  if (url.pathname.startsWith("/api/") || url.pathname === "/events") return;

  // Navigations: network-first so the shell HTML is always current; fall back
  // to the cached shell when offline.
  if (req.mode === "navigate") {
    event.respondWith(fetch(req).catch(() => caches.match("/")));
    return;
  }

  // Static app shell: cache-first with network fallback.
  const isShell = SHELL.includes(url.pathname) || url.origin === "https://cdn.jsdelivr.net";
  if (!isShell) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, clone));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});