const CACHE = 'nossatv-v5';
const URLS = [
  'index.html', 'guest.html', 'vereadores.html', 'scene.html', 'monitor.html',
  'styles.css', 'script.js', 'source-types.js', 'whip-client.js',
  'stream-manager.js', 'vereador-manager.js', 'qrcode.js',
  'manifest.json', 'favicon.svg', 'service-worker.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(URLS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.protocol === 'chrome-extension:' || url.protocol === 'moz-extension:') return;

  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) return cached;
      return fetch(e.request).then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone));
        }
        return res;
      }).catch(() => new Response('Offline', { status: 503 }));
    })
  );
});
