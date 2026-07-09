/* Service worker — network-first met cache-fallback (offline-support) */
const CACHE = 'vermogen-v11';
const ASSETS = [
  '.',
  'index.html',
  'css/style.css?v=11',
  'js/data.js?v=11',
  'js/ml.js?v=11',
  'js/charts.js?v=11',
  'js/quant.js?v=11',
  'js/backtest.js?v=11',
  'js/catalog.js?v=11',
  'js/dca.js?v=11',
  'js/importer.js?v=11',
  'js/alerts.js?v=11',
  'js/app.js?v=11',
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
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
