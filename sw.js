/* Service worker — network-first met cache-fallback (offline-support) */
const CACHE = 'vermogen-v15';
const ASSETS = [
  '.',
  'index.html',
  'css/style.css?v=15',
  'js/data.js?v=15',
  'js/ml.js?v=15',
  'js/charts.js?v=15',
  'js/quant.js?v=15',
  'js/backtest.js?v=15',
  'js/catalog.js?v=15',
  'js/dca.js?v=15',
  'js/importer.js?v=15',
  'js/alerts.js?v=15',
  'js/app.js?v=15',
  'manifest.webmanifest',
  'icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // CoinGecko e.d. niet cachen
  // network-first: altijd vers tijdens ontwikkeling, cache als offline-vangnet
  e.respondWith(
    fetch(e.request)
      .then(async res => {
        // Cache uitsluitend succesvolle same-origin responses. Een tijdelijke
        // 404/500 mag niet als blijvende offline-versie vast komen te zitten.
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          try { await caches.open(CACHE).then(c => c.put(e.request, copy)); } catch (error) { /* quota: netwerkresponse blijft bruikbaar */ }
        }
        return res;
      })
      .catch(async () => {
        const cached = await caches.match(e.request);
        if (cached) return cached;
        if (e.request.mode === 'navigate') return caches.match('index.html');
        return new Response('Offline en niet gecachet', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      })
  );
});
