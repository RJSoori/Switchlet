/// <reference lib="webworker" />
// Switchlet's service worker, kept short so anyone can read exactly what it does:
// 1. Offline: keeps a copy of the app (code, converters, fonts) and serves it when there's no network.
// 2. Share target: receives files shared to Switchlet on Android and hands them to the page, which
//    deletes them right away. Nothing is ever sent anywhere.
// 3. Upload meter: any request that could carry data (anything but GET/HEAD) has its body size counted
//    and reported to the page's privacy panel. Switchlet itself never makes one, so it stays at 0.
const sw = self as unknown as ServiceWorkerGlobalScope
declare const __PRECACHE__: string[]
declare const __VERSION__: string

const APP = `switchlet-${__VERSION__}`
const SHARED = 'switchlet-shared'

sw.addEventListener('install', (event) => {
  event.waitUntil(caches.open(APP).then((cache) => cache.addAll(__PRECACHE__)).then(() => sw.skipWaiting()))
})

sw.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== APP && key !== SHARED) await caches.delete(key)
    await sw.clients.claim()
  })())
})

sw.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)
  const ownOrigin = url.origin === sw.location.origin
  if (request.method === 'POST' && ownOrigin && url.pathname === '/share-target') return event.respondWith(receiveShare(request))
  if (request.method !== 'GET' && request.method !== 'HEAD') return event.respondWith(meterUpload(request))
  if (!ownOrigin) return // the security policy blocks these before they get here
  event.respondWith(request.mode === 'navigate' ? networkFirst(request) : cacheFirst(request))
})

// ignoreVary: servers may send "Vary: Origin". The page's module and worker requests carry an Origin header
// the precache requests didn't, so a Vary-aware lookup misses every script when offline. All entries are
// this origin's own files, identical whoever asks.
const FROM_APP: MultiCacheQueryOptions = { cacheName: APP, ignoreVary: true }

async function networkFirst(request: Request): Promise<Response> {
  try {
    return await fetch(request)
  } catch {
    return (await caches.match('/', FROM_APP)) ?? Response.error()
  }
}

async function cacheFirst(request: Request): Promise<Response> {
  return (await caches.match(request, FROM_APP)) ?? fetch(request)
}

async function meterUpload(request: Request): Promise<Response> {
  const bytes = (await request.clone().arrayBuffer()).byteLength
  for (const client of await sw.clients.matchAll({ includeUncontrolled: true })) {
    client.postMessage({ type: 'switchlet:upload', bytes, url: request.url, method: request.method })
  }
  return fetch(request)
}

/** Park shared files until the page collects them (it deletes them as soon as it has read them). */
async function receiveShare(request: Request): Promise<Response> {
  const files = (await request.formData()).getAll('files').filter((f): f is File => f instanceof File)
  const cache = await caches.open(SHARED)
  for (const key of await cache.keys()) await cache.delete(key)
  await Promise.all(files.map((file, i) => cache.put(`/__shared/${i}`, new Response(file, {
    headers: { 'content-type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) },
  }))))
  return Response.redirect(`/?shared=${files.length}`, 303)
}
