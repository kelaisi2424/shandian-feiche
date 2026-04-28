// Minimal cache-first service worker. We don't pre-cache the JS bundle (its
// hash changes every build) — instead we cache on first fetch and then serve
// from cache to make repeat visits instant + offline-tolerant.
const CACHE = "shandian-feiche-v1"

self.addEventListener("install", (e) => {
  self.skipWaiting()
})

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  )
  self.clients.claim()
})

self.addEventListener("fetch", (e) => {
  const req = e.request
  if (req.method !== "GET") return
  if (!req.url.startsWith(self.location.origin)) return
  e.respondWith(
    caches.match(req).then((cached) => {
      if (cached) {
        // background revalidate
        fetch(req).then((res) => {
          if (res && res.status === 200) caches.open(CACHE).then((c) => c.put(req, res.clone()))
        }).catch(() => {})
        return cached
      }
      return fetch(req).then((res) => {
        if (res && res.status === 200) {
          const clone = res.clone()
          caches.open(CACHE).then((c) => c.put(req, clone))
        }
        return res
      }).catch(() => caches.match("/index.html"))
    })
  )
})
