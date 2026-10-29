const CACHE_NAME = "news-dashboard-shell-v9";
const SHELL_FILES = [
  "/",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // 뉴스/환율 API는 항상 최신 데이터를 받아야 하므로 네트워크 우선, 캐시 저장 안 함
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
    return;
  }

  // 그 외 정적 파일은 캐시 우선 (앱 셸을 빠르게 띄우기 위함)
  event.respondWith(
    caches.match(event.request).then((cached) => {
      return (
        cached ||
        fetch(event.request).then((resp) => {
          const copy = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return resp;
        })
      );
    })
  );
});
