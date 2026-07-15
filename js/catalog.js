/* ============================================================
   catalog.js — catalogus van populaire assets voor de watchlist
   Volgen zonder te bezitten: koershistorie komt van CoinGecko
   (crypto) of rechtstreeks van Yahoo Finance (aandelen/ETF's).
   ============================================================ */

const WATCH_ASSETS_KEY = 'vermogen_watchassets_v1';

const CATALOG = [
  // ---- Aandelen NL/EU (Euronext/Xetra, noteren in EUR) ----
  { id: 'ASML',  name: 'ASML',            type: 'Aandeel', yahoo: 'ASML.AS' },
  { id: 'ADYEN', name: 'Adyen',           type: 'Aandeel', yahoo: 'ADYEN.AS' },
  { id: 'BESI',  name: 'BE Semiconductor', type: 'Aandeel', yahoo: 'BESI.AS' },
  { id: 'INGA',  name: 'ING Groep',       type: 'Aandeel', yahoo: 'INGA.AS' },
  { id: 'SHELL', name: 'Shell',           type: 'Aandeel', yahoo: 'SHELL.AS' },
  { id: 'PHIA',  name: 'Philips',         type: 'Aandeel', yahoo: 'PHIA.AS' },
  { id: 'HEIA',  name: 'Heineken',        type: 'Aandeel', yahoo: 'HEIA.AS' },
  { id: 'SAP',   name: 'SAP',             type: 'Aandeel', yahoo: 'SAP.DE' },
  // ---- Aandelen VS (USD, worden omgerekend naar EUR) ----
  { id: 'AAPL',  name: 'Apple',           type: 'Aandeel', yahoo: 'AAPL' },
  { id: 'MSFT',  name: 'Microsoft',       type: 'Aandeel', yahoo: 'MSFT' },
  { id: 'NVDA',  name: 'NVIDIA',          type: 'Aandeel', yahoo: 'NVDA' },
  { id: 'GOOGL', name: 'Alphabet',        type: 'Aandeel', yahoo: 'GOOGL' },
  { id: 'AMZN',  name: 'Amazon',          type: 'Aandeel', yahoo: 'AMZN' },
  { id: 'META',  name: 'Meta Platforms',  type: 'Aandeel', yahoo: 'META' },
  { id: 'TSLA',  name: 'Tesla',           type: 'Aandeel', yahoo: 'TSLA' },
  { id: 'AMD',   name: 'AMD',             type: 'Aandeel', yahoo: 'AMD' },
  { id: 'NFLX',  name: 'Netflix',         type: 'Aandeel', yahoo: 'NFLX' },
  { id: 'PLTR',  name: 'Palantir',        type: 'Aandeel', yahoo: 'PLTR' },
  { id: 'COIN',  name: 'Coinbase',        type: 'Aandeel', yahoo: 'COIN' },
  { id: 'MSTR',  name: 'Strategy (MicroStrategy)', type: 'Aandeel', yahoo: 'MSTR' },
  { id: 'IONQ',  name: 'IonQ',            type: 'Aandeel', yahoo: 'IONQ' },
  { id: 'RKLB',  name: 'Rocket Lab',      type: 'Aandeel', yahoo: 'RKLB' },
  // ---- ETF's (UCITS, EUR) ----
  { id: 'VWCE',  name: 'Vanguard FTSE All-World (Acc)', type: 'ETF', yahoo: 'VWCE.DE' },
  { id: 'VWRL',  name: 'Vanguard FTSE All-World (Dist)', type: 'ETF', yahoo: 'VWRL.AS' },
  { id: 'IWDA',  name: 'iShares Core MSCI World',  type: 'ETF', yahoo: 'IWDA.AS' },
  { id: 'VUSA',  name: 'Vanguard S&P 500',         type: 'ETF', yahoo: 'VUSA.AS' },
  { id: 'EMIM',  name: 'iShares Core EM IMI',      type: 'ETF', yahoo: 'EMIM.AS' },
  { id: 'SXR8',  name: 'iShares Core S&P 500 (Acc)', type: 'ETF', yahoo: 'SXR8.DE' },
  { id: 'IUSN',  name: 'iShares MSCI World Small Cap', type: 'ETF', yahoo: 'IUSN.DE' },
  // ---- Crypto (CoinGecko) ----
  { id: 'BTC',   name: 'Bitcoin',   type: 'Crypto' },
  { id: 'ETH',   name: 'Ethereum',  type: 'Crypto' },
  { id: 'SOL',   name: 'Solana',    type: 'Crypto' },
  { id: 'BNB',   name: 'BNB',       type: 'Crypto' },
  { id: 'XRP',   name: 'XRP',       type: 'Crypto' },
  { id: 'ADA',   name: 'Cardano',   type: 'Crypto' },
  { id: 'DOGE',  name: 'Dogecoin',  type: 'Crypto' },
  { id: 'AVAX',  name: 'Avalanche', type: 'Crypto' },
  { id: 'LINK',  name: 'Chainlink', type: 'Crypto' },
  { id: 'DOT',   name: 'Polkadot',  type: 'Crypto' },
  { id: 'ATOM',  name: 'Cosmos',    type: 'Crypto' },
  { id: 'NEAR',  name: 'NEAR',      type: 'Crypto' },
  { id: 'ARB',   name: 'Arbitrum',  type: 'Crypto' },
  { id: 'OP',    name: 'Optimism',  type: 'Crypto' },
  { id: 'TIA',   name: 'Celestia',  type: 'Crypto' },
  { id: 'SUI',   name: 'Sui',       type: 'Crypto' },
];

function loadStoredWatchAssets() {
  try {
    const parsed = JSON.parse(localStorage.getItem(WATCH_ASSETS_KEY)) || [];
    return Array.isArray(parsed) ? parsed.slice(0, MAX_IMPORT_ASSETS) : [];
  }
  catch (e) { return []; }
}

/** Registreert opgeslagen watch-only assets (historie volgt via applyLiveHistory). */
function loadWatchAssets() {
  for (const entry of loadStoredWatchAssets()) {
    if (assetById(entry.id)) continue;
    registerAsset({ ...entry, custom: true, watchOnly: true, seed: 1, drift: 0, vol: 0.3, start: 1 },
      new Array(HISTORY_DAYS).fill(1)); // placeholder; echte data komt uit LIVEHIST
  }
}

/** Bouwt een prijsgrid uit (ts,price)-punten: echt venster + vlak ervoor. */
function pointsToGrid(points) {
  const byIdx = new Map();
  for (const point of points) {
    if (!Array.isArray(point)) continue;
    const ts = Number(point[0]), p = Number(point[1]);
    if (!Number.isFinite(ts) || !Number.isFinite(p) || p <= 0) continue;
    byIdx.set(dateToIndex(new Date(ts).toISOString()), p);
  }
  const idxs = [...byIdx.keys()].sort((a, b) => a - b);
  if (!idxs.length) return null;
  const grid = new Array(HISTORY_DAYS).fill(null);
  let cur = byIdx.get(idxs[0]);
  for (let i = 0; i < HISTORY_DAYS; i++) {
    if (byIdx.has(i)) cur = byIdx.get(i);
    if (i >= idxs[0]) grid[i] = cur;
  }
  for (let i = 0; i < idxs[0]; i++) grid[i] = byIdx.get(idxs[0]); // vlak vóór echt venster
  return grid;
}

/**
 * Voegt een catalogus-asset toe als watch-only asset: haalt eerst echte
 * historie op (CoinGecko of Yahoo) en registreert dan. Retourneert {ok, error}.
 */
async function addWatchAsset(entry) {
  if (!networkConsentEnabled()) return { ok: false, error: 'Sta eerst externe koersdata toe bij Instellingen → Privacy en netwerk.' };
  const id = normalizeAssetId(entry?.id);
  if (!id) return { ok: false, error: 'Ongeldige ticker.' };
  entry = {
    ...entry, id,
    name: cleanDisplayText(entry.name || id, 80) || id,
    type: ['Crypto', 'ETF', 'Aandeel'].includes(entry.type) ? entry.type : 'Aandeel',
    yahoo: cleanDisplayText(entry.yahoo || '', 32),
  };
  if (assetById(entry.id)) return { ok: true };

  let points = null, src = null;
  if (entry.type === 'Crypto') {
    const cgId = entry.cg || COINGECKO_IDS[entry.id];
    if (!cgId) return { ok: false, error: `Geen CoinGecko-koppeling voor ${entry.id}` };
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      const res = await fetch(`https://api.coingecko.com/api/v3/coins/${encodeURIComponent(cgId)}/market_chart?vs_currency=eur&days=${HISTORY_DAYS}&interval=daily`, {
        signal: ctrl.signal, credentials: 'omit', referrerPolicy: 'no-referrer',
      });
      clearTimeout(timer);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.prices) && data.prices.length > 30 && data.prices.length <= 2000) { points = data.prices; src = 'live'; }
      }
    } catch (e) { /* netwerk */ }
  } else {
    // Met een ingestelde browserfallback eerst Alpha proberen; rechtstreekse
    // Yahoo-calls worden door externe browser-origins doorgaans geblokkeerd.
    const candidates = entry.yahoo ? [entry.yahoo] : yahooCandidates(entry.id);
    let got = await fetchAlphaVantageChart(entry.yahoo || entry.id);
    if (!got) {
      for (const sym of candidates) {
        got = await fetchYahooChart(sym);
        if (got) { entry.yahoo = sym; break; }
      }
    }
    if (got) {
      points = got.points;
      src = got.source || 'yahoo';
      if (got.name && entry.name === entry.id) entry.name = got.name;
      if (got.currency !== 'EUR') {
        const fx = await fxToEurSeries(got.currency);
        if (!fx) return { ok: false, error: `Geen betrouwbare EUR-wisselkoers beschikbaar voor ${got.currency}.` };
        points = points.map(([ts, p]) => [ts, p * fx[dateToIndex(new Date(ts).toISOString())]]);
      }
    }
  }
  if (!points) {
    const fallback = alphaVantageApiKey()
      ? ''
      : ' Yahoo blokkeert rechtstreekse browsercalls; vul bij Instellingen een Alpha Vantage API-sleutel in.';
    return { ok: false, error: `Kon geen koersdata vinden voor ${entry.id}.${fallback}` };
  }

  const grid = pointsToGrid(points);
  if (!grid) return { ok: false, error: `Ongeldige koersdata voor ${entry.id}` };
  const real = new Array(HISTORY_DAYS).fill(false);
  const pointIndices = points.map(([ts]) => dateToIndex(new Date(Number(ts)).toISOString()));
  const first = Math.min(...pointIndices), last = Math.max(...pointIndices);
  for (let i = first; i <= last; i++) real[i] = true;
  const color = CUSTOM_COLORS[(ASSETS.length + 3) % CUSTOM_COLORS.length];
  registerAsset({ id: entry.id, name: entry.name, type: entry.type, yahoo: entry.yahoo, color, custom: true, watchOnly: true, histSource: src, seed: 1, drift: 0, vol: 0.3, start: grid[0] }, grid, real);

  // persist: assetdefinitie + koersdata (zodat het na herladen terugkomt)
  const stored = loadStoredWatchAssets();
  stored.push({ id: entry.id, name: entry.name, type: entry.type, yahoo: entry.yahoo, color, histSource: src });
  const hist = loadLiveHistory();
  const compact = new Map(points.map(([ts, p]) => [dateToIndex(new Date(ts).toISOString()), +(+p).toPrecision(6)]));
  hist[entry.id] = { at: Date.now(), points: [...compact.entries()], src };
  try { commitStorage({ [WATCH_ASSETS_KEY]: JSON.stringify(stored), [LIVEHIST_KEY]: JSON.stringify(hist) }); }
  catch (e) {
    removeWatchAsset(entry.id);
    return { ok: false, error: 'Opslaan van de watchlist-asset is mislukt.' };
  }
  return { ok: true };
}

/** Verwijdert een watch-only asset volledig (definitie + historie). */
function removeWatchAsset(id) {
  const idx = ASSETS.findIndex(a => a.id === id && a.watchOnly);
  if (idx >= 0) { ASSETS.splice(idx, 1); delete MARKET.prices[id]; delete MARKET.provenance[id]; }
  const hist = loadLiveHistory();
  delete hist[id];
  try { commitStorage({
    [WATCH_ASSETS_KEY]: JSON.stringify(loadStoredWatchAssets().filter(e => e.id !== id)),
    [LIVEHIST_KEY]: JSON.stringify(hist),
  }); } catch (e) { /* UI meldt opslagfouten bij toevoegen; verwijderen is beste-effort */ }
}
