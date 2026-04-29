// Network-first for navigation HTML, cache-first for content-hashed assets.
// The previous cache-first-everything strategy meant updated builds never
// reached users — they kept getting the old index.html (pointing at the
// old asset bundles) for as many reloads as it took to revalidate.
const CACHE = "shandian-feiche-v3"

self.addEventListener("install", () => {
  self.skipWaiting()
})

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    await self.clients.claim()
    // Force any tabs already open under the old SW onto the new HTML.
    const wins = await self.clients.matchAll({ type: "window" })
    wins.forEach((c) => {
      try { c.navigate(c.url) } catch (_) {}
    })
  })())
})

self.addEventListener("fetch", (e) => {
  const req = e.request
  if (req.method !== "GET") return
  if (!req.url.startsWith(self.location.origin)) return

  const url = new URL(req.url)
  const isNav =
    req.mode === "navigate" ||
    url.pathname === "/" ||
    url.pathname.endsWith(".html") ||
    url.pathname.endsWith("/index.html")

  if (isNav) {
    // Network-first so the HTML always points at the latest hashed bundle.
    e.respondWith((async () => {
      try {
        const res = await fetch(req)
        if (res && res.status === 200) {
          const clone = res.clone()
          caches.open(CACHE).then((c) => c.put(req, clone)).catch(() => {})
        }
        return res
      } catch (_) {
        const cached = await caches.match(req)
        return cached || caches.match("/index.html")
      }
    })())
    return
  }

  // Cache-first for everything else (assets/*, models/*, images) — they're
  // URL-immutable thanks to vite's content hashing.
  e.respondWith((async () => {
    const cached = await caches.match(req)
    if (cached) {
      fetch(req).then((res) => {
        if (res && res.status === 200) {
          caches.open(CACHE).then((c) => c.put(req, res.clone())).catch(() => {})
        }
      }).catch(() => {})
      return cached
    }
    try {
      const res = await fetch(req)
      if (res && res.status === 200) {
        const clone = res.clone()
        caches.open(CACHE).then((c) => c.put(req, clone)).catch(() => {})
      }
      return res
    } catch (_) {
      return new Response("", { status: 504 })
    }
  })())
})
