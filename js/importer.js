/* ============================================================
   importer.js — JSON-import van portfolio/transactiegeschiedenis
   + live crypto-koersen (CoinGecko)

   De parser is bewust tolerant: hij scant het hele JSON-object op
   arrays die op transacties lijken (NL/EN veldnamen, DEGIRO-achtige
   exports, geneste structuren) en op koershistories. Onbekende assets
   worden geregistreerd; ontbrekende historie wordt gesynthetiseerd
   rond de bekende transactiekoersen.
   ============================================================ */

const CUSTOM_KEY = 'vermogen_custom_v1';
const MODE_KEY = 'vermogen_mode';

// ---------- waarde-parsers ----------
function parseNum(v) {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v !== 'string') return null;
  let s = v.replace(/[€$£\s]/g, '');
  if (!s) return null;
  const hasDot = s.includes('.'), hasComma = s.includes(',');
  if (hasDot && hasComma) {
    // laatste scheidingsteken is decimaal
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (hasComma) {
    s = s.replace(',', '.');
  }
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
}

function parseDateFlexible(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') {
    // unix seconden of ms
    const ms = v > 1e12 ? v : v > 1e9 ? v * 1000 : null;
    if (ms) { const d = new Date(ms); return isNaN(d) ? null : d; }
    return null;
  }
  if (typeof v !== 'string') return null;
  // dd-mm-yyyy / dd/mm/yyyy
  const m = v.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/);
  if (m) {
    const d = new Date(+m[3], +m[2] - 1, +m[1], 12);
    return isNaN(d) ? null : d;
  }
  const d = new Date(v);
  return isNaN(d) ? null : d;
}

function getField(obj, names) {
  const keys = Object.keys(obj);
  for (const name of names) {
    const k = keys.find(kk => kk.toLowerCase().replace(/[_\s-]/g, '') === name);
    if (k !== undefined && obj[k] !== null && obj[k] !== undefined && obj[k] !== '') return obj[k];
  }
  return undefined;
}

// ---------- transactie-normalisatie ----------
const F_DATE = ['date', 'datum', 'timestamp', 'time', 'executedat', 'createdat', 'transactiondate', 'transactiedatum', 'orderdate'];
const F_QTY = ['qty', 'quantity', 'aantal', 'shares', 'units', 'volume', 'stuks'];
const F_PRICE = ['price', 'koers', 'prijs', 'unitprice', 'rate', 'executionprice', 'prijsperstuk', 'koersperstuk'];
const F_TOTAL = ['total', 'totaal', 'totalvalue', 'value', 'bedrag', 'amounteur', 'totalamount', 'waarde', 'cost'];
const F_TYPE = ['side', 'transactietype', 'ordertype', 'buysell', 'action', 'richting', 'type'];
const F_SYMBOL = ['asset', 'ticker', 'symbol', 'symbool', 'code', 'product', 'isin', 'fonds', 'name', 'naam', 'instrument', 'coin', 'currency'];
const F_NAME = ['name', 'naam', 'product', 'description', 'omschrijving', 'instrument'];
const F_ASSETCLASS = ['assettype', 'assetclass', 'categorie', 'category', 'class', 'type'];

/** Herkent buy/sell in een tekstwaarde; null als het geen order-richting is. */
function parseSide(v) {
  if (typeof v !== 'string') return null;
  const t = v.toLowerCase().trim();
  if (/(^|\b)(sell|verkoop|verkocht|verkopen|s)($|\b)/.test(t)) return 'sell';
  if (/(^|\b)(buy|koop|aankoop|gekocht|kopen|b)($|\b)/.test(t)) return 'buy';
  return null;
}

/** Herkent een asset-klasse (Crypto/ETF/Aandeel) in een tekstwaarde. */
function parseAssetClass(v) {
  if (typeof v !== 'string') return null;
  const t = v.toLowerCase();
  if (/crypto|coin|token/.test(t)) return 'Crypto';
  if (/etf|fonds|fund|tracker|index/.test(t)) return 'ETF';
  if (/aandeel|stock|share|equity/.test(t)) return 'Aandeel';
  return null;
}

function normalizeTxCandidate(o) {
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return null;
  const date = parseDateFlexible(getField(o, F_DATE));
  let qty = parseNum(getField(o, F_QTY));
  let price = parseNum(getField(o, F_PRICE));
  const total = parseNum(getField(o, F_TOTAL));
  const rawSymbol = getField(o, F_SYMBOL);
  const rawName = getField(o, F_NAME);

  if (!date || !rawSymbol || qty === null || qty === 0) return null;
  if (price === null && total !== null && qty !== 0) price = Math.abs(total) / Math.abs(qty);
  // price 0 is legitiem (staking rewards, airdrops, bonussen): aantal telt
  // mee, kostprijs is nul. Alleen ontbrekend/negatief afwijzen.
  if (price === null || price < 0) return null;

  // probeer álle type-velden tot er één een order-richting oplevert
  // (velden als type:"Crypto" zijn een asset-klasse, geen richting)
  let type = null, assetClass = null;
  for (const name of F_TYPE) {
    const v = getField(o, [name]);
    if (v === undefined) continue;
    type = parseSide(v);
    if (type) break;
  }
  for (const name of F_ASSETCLASS) {
    const v = getField(o, [name]);
    if (v === undefined) continue;
    assetClass = parseAssetClass(v);
    if (assetClass) break;
  }
  if (!type) type = qty < 0 ? 'sell' : 'buy';
  qty = Math.abs(qty);

  const symbol = String(rawSymbol).trim().toUpperCase().slice(0, 12);
  return {
    date: date.toISOString(), type, qty, price,
    asset: symbol,
    assetName: rawName ? String(rawName).trim().slice(0, 40) : symbol,
    assetClass,
    currentPrice: parseNum(getField(o, ['currentprice', 'huidigekoers', 'lastprice', 'laatstekoers'])),
  };
}

// ---------- koershistorie-detectie ----------
function looksLikePricePoint(o) {
  if (typeof o !== 'object' || o === null) return false;
  const d = parseDateFlexible(getField(o, F_DATE));
  const p = parseNum(getField(o, ['close', 'price', 'koers', 'value', 'slotkoers', 'adjclose']));
  return !!d && p !== null && p > 0;
}

function extractPricePoints(arr) {
  const pts = [];
  for (const o of arr) {
    const d = parseDateFlexible(getField(o, F_DATE));
    const p = parseNum(getField(o, ['close', 'price', 'koers', 'value', 'slotkoers', 'adjclose']));
    if (d && p) pts.push({ idx: dateToIndex(d.toISOString()), price: p });
  }
  return pts.sort((a, b) => a.idx - b.idx);
}

// ---------- deep scan ----------
function scanJSON(root) {
  const txs = [];
  const histories = {}; // SYMBOL -> [{idx, price}]
  const seen = new Set();

  function visit(node, keyHint) {
    if (node === null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      if (node.length && typeof node[0] === 'object') {
        // transacties? (drempel bewust laag: exports bevatten vaak ook
        // regels die net niet parsen — de herkende rijen zijn dan alsnog goud)
        const normalized = node.map(normalizeTxCandidate);
        const ok = normalized.filter(Boolean);
        if (ok.length >= Math.max(1, node.length * 0.3) || ok.length >= 25) {
          txs.push(...ok);
          return; // niet dieper scannen in herkende tx-array
        }
        // koershistorie?
        if (node.length >= 20 && node.filter(looksLikePricePoint).length >= node.length * 0.7) {
          // symbool uit item zelf of uit de sleutel erboven
          const symFromItem = getField(node[0], ['symbol', 'ticker', 'asset', 'code']);
          const sym = (symFromItem || keyHint || '').toString().toUpperCase().replace(/[^A-Z0-9.]/g, '').slice(0, 12);
          if (sym) {
            histories[sym] = extractPricePoints(node);
            return;
          }
        }
      }
      for (const item of node) visit(item, keyHint);
      return;
    }
    for (const [k, v] of Object.entries(node)) visit(v, k);
  }
  visit(root, '');

  // ook: posities zonder transacties (qty + gemiddelde koopprijs) -> synthetische koop-tx
  if (txs.length === 0) {
    function visitPositions(node) {
      if (node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const o of node) {
          if (typeof o !== 'object' || o === null) continue;
          const sym = getField(o, F_SYMBOL);
          const qty = parseNum(getField(o, F_QTY));
          const avg = parseNum(getField(o, ['avgprice', 'averageprice', 'gak', 'costbasis', 'avgcost', 'gemiddeldekoers', 'aankoopkoers']));
          if (sym && qty && avg && qty > 0 && avg > 0) {
            const d = parseDateFlexible(getField(o, ['purchasedate', 'aankoopdatum', 'since', 'firstbuy'])) || new Date(Date.now() - 365 * 86400000);
            txs.push({
              date: d.toISOString(), type: 'buy', qty, price: avg,
              asset: String(sym).trim().toUpperCase().slice(0, 12),
              assetName: (getField(o, F_NAME) || sym).toString().slice(0, 40),
            });
          }
        }
        node.forEach(visitPositions);
        return;
      }
      Object.values(node).forEach(visitPositions);
    }
    visitPositions(root);
  }

  return { txs, histories };
}

// ---------- historie op datumgrid + synthese ----------
function historyToGrid(points) {
  const grid = new Array(HISTORY_DAYS).fill(null);
  for (const p of points) grid[p.idx] = p.price;
  // forward-fill + backfill
  let last = null;
  for (let i = 0; i < HISTORY_DAYS; i++) { if (grid[i] !== null) last = grid[i]; else if (last !== null) grid[i] = last; }
  let first = grid.find(v => v !== null);
  for (let i = 0; i < HISTORY_DAYS && grid[i] === null; i++) grid[i] = first;
  return grid.some(v => v === null) ? null : grid;
}

/** Synthetiseert historie rond bekende (transactie)prijspunten. */
function synthesizeHistory(points, symbol, volGuess) {
  const seed = [...symbol].reduce((s, c) => s * 31 + c.charCodeAt(0), 7) >>> 0;
  const rng = mulberry32(seed);
  const gauss = gaussianFactory(rng);
  const dVol = volGuess / Math.sqrt(252);
  const grid = new Array(HISTORY_DAYS);

  const anchors = points.length ? points : [{ idx: HISTORY_DAYS - 1, price: 100 }];
  // vóór het eerste anker: random walk terug
  let logP = Math.log(anchors[0].price);
  for (let i = anchors[0].idx; i >= 0; i--) {
    grid[i] = Math.exp(logP);
    logP -= dVol * gauss() * 0.9;
  }
  // tussen ankers: geometrische brug met ruis
  for (let a = 0; a < anchors.length - 1; a++) {
    const A = anchors[a], B = anchors[a + 1];
    const span = B.idx - A.idx;
    if (span <= 0) continue;
    for (let i = A.idx; i <= B.idx; i++) {
      const t = (i - A.idx) / span;
      const base = Math.exp(Math.log(A.price) * (1 - t) + Math.log(B.price) * t);
      // Brownian-bridge-achtige ruis: nul op de ankers
      const noise = dVol * Math.sqrt(Math.max(0, t * (1 - t) * span)) * gauss() * 0.55;
      grid[i] = base * Math.exp(noise);
    }
    grid[B.idx] = B.price;
  }
  // na het laatste anker: random walk vooruit (eindigt op "vandaag")
  const L = anchors[anchors.length - 1];
  logP = Math.log(L.price);
  for (let i = L.idx + 1; i < HISTORY_DAYS; i++) {
    logP += dVol * gauss() * 0.9;
    grid[i] = Math.exp(logP);
  }
  return grid;
}

// ---------- asset-registratie ----------
const KNOWN_CRYPTO = ['BTC', 'ETH', 'SOL', 'ADA', 'XRP', 'DOGE', 'DOT', 'LINK', 'AVAX', 'LTC', 'MATIC', 'POL', 'BNB', 'TRX', 'ATOM', 'XLM', 'UNI', 'AAVE'];

function guessType(symbol, name) {
  if (KNOWN_CRYPTO.includes(symbol)) return 'Crypto';
  const n = (name || '').toLowerCase();
  if (/coin|token|crypto/.test(n)) return 'Crypto';
  if (/etf|ucits|vanguard|ishares|index|tracker|fonds|fund/.test(n)) return 'ETF';
  return 'Aandeel';
}

function volForType(type) { return type === 'Crypto' ? 0.6 : type === 'ETF' ? 0.15 : 0.3; }

/**
 * Voert een import uit: registreert assets + histories, vervangt
 * transacties, en bewaart alles in localStorage.
 */
function importPortfolioJSON(jsonText) {
  let root;
  try { root = JSON.parse(jsonText); }
  catch (e) { return { ok: false, error: 'Het bestand is geen geldige JSON: ' + e.message }; }

  const { txs, histories } = scanJSON(root);
  if (!txs.length) {
    return { ok: false, error: 'Geen transacties of posities herkend in dit bestand. Verwacht: een array met objecten die datum, aantal, koers/bedrag en een ticker/naam bevatten.' };
  }

  // per asset: registreren
  const symbols = [...new Set(txs.map(t => t.asset))];
  const customAssets = [];
  const customPrices = {};
  let histMatched = 0, synthesized = 0;

  // snapshotdatum = laatste transactiedatum in het bestand; daar horen
  // eventuele currentPrice-velden bij (koers op exportmoment)
  const snapshotIdx = Math.max(...txs.map(t => dateToIndex(t.date)));

  symbols.forEach((sym, i) => {
    const symTxs = txs.filter(t => t.asset === sym);
    const name = symTxs[0]?.assetName || sym;
    const type = symTxs.find(t => t.assetClass)?.assetClass || guessType(sym, name);
    const existing = assetById(sym);
    const color = existing ? existing.color : CUSTOM_COLORS[i % CUSTOM_COLORS.length];

    // historie: echte punten > synthetisch rond tx-prijzen
    let grid = null, fromImport = false;
    const histKey = Object.keys(histories).find(k => k === sym || k.startsWith(sym) || sym.startsWith(k));
    if (histKey && histories[histKey].length >= 20) {
      grid = historyToGrid(histories[histKey]);
      if (grid) { histMatched++; fromImport = true; }
    }
    if (!grid) {
      const anchors = symTxs
        .filter(t => t.price > 0) // gratis verkregen (price 0) is geen koersinformatie
        .map(t => ({ idx: dateToIndex(t.date), price: t.price }))
        .sort((a, b) => a.idx - b.idx);
      // currentPrice van de meest recente transactie = koers op snapshotdatum
      const withCur = [...symTxs].reverse().find(t => t.currentPrice && t.currentPrice > 0);
      if (withCur) {
        const filtered = anchors.filter(a => a.idx < snapshotIdx);
        filtered.push({ idx: snapshotIdx, price: withCur.currentPrice });
        grid = synthesizeHistory(filtered, sym, volForType(type));
      } else {
        grid = synthesizeHistory(anchors, sym, volForType(type));
      }
      synthesized++;
    }

    const histSource = fromImport ? 'import' : 'synth';
    if (existing) {
      MARKET.prices[sym] = grid;
      existing.histSource = histSource;
      customPrices[sym] = grid;
    } else {
      const asset = { id: sym, name, type, start: grid[0], drift: 0.08, vol: volForType(type), seed: 1, color, custom: true, histSource };
      registerAsset(asset, grid);
      customAssets.push(asset);
      customPrices[sym] = grid;
    }
  });

  const cleanTxs = txs
    .map((t, i) => ({ id: 'imp-' + i, date: t.date, type: t.type, asset: t.asset, qty: t.qty, price: t.price }))
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  // persist
  const report = {
    txCount: cleanTxs.length,
    assetCount: symbols.length,
    symbols,
    histMatched, synthesized,
    date: new Date().toISOString(),
  };
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify({
      assets: customAssets,
      prices: Object.fromEntries(Object.entries(customPrices).map(([k, v]) => [k, v.map(p => +p.toPrecision(6))])),
      report,
    }));
    localStorage.setItem(MODE_KEY, 'import');
    saveTransactions(cleanTxs);
  } catch (e) {
    return { ok: false, error: 'Opslaan mislukt (bestand te groot voor localStorage?): ' + e.message };
  }

  return { ok: true, txs: cleanTxs, report };
}

/** Laadt eerder geïmporteerde data bij het opstarten (vóór app.js init). */
function loadCustomData() {
  if (localStorage.getItem(MODE_KEY) !== 'import') return null;
  try {
    const data = JSON.parse(localStorage.getItem(CUSTOM_KEY));
    if (!data) return null;
    for (const asset of data.assets || []) registerAsset(asset, data.prices[asset.id]);
    for (const [sym, prices] of Object.entries(data.prices || {})) {
      if (MARKET.prices[sym] && !(data.assets || []).some(a => a.id === sym)) MARKET.prices[sym] = prices;
    }
    return data.report || null;
  } catch (e) { return null; }
}

/** Wist álle app-data (transacties, assets, watchlist, alerts, historie). */
function clearAllData() {
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith('vermogen_')) localStorage.removeItem(key);
  }
  location.reload();
}

const IMPORT_REPORT = loadCustomData();

// ---------- live crypto-koersen (CoinGecko, gratis & CORS-vriendelijk) ----------
const COINGECKO_IDS = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', ADA: 'cardano', XRP: 'ripple',
  DOGE: 'dogecoin', DOT: 'polkadot', LINK: 'chainlink', AVAX: 'avalanche-2',
  LTC: 'litecoin', MATIC: 'matic-network', POL: 'matic-network', BNB: 'binancecoin',
  TRX: 'tron', ATOM: 'cosmos', XLM: 'stellar', UNI: 'uniswap', AAVE: 'aave',
  OP: 'optimism', TIA: 'celestia', ZK: 'zksync', ARB: 'arbitrum', SUI: 'sui',
  NEAR: 'near', INJ: 'injective-protocol', RNDR: 'render-token', FTM: 'fantom',
};

async function fetchLivePrices() {
  const wanted = ASSETS.filter(a => a.type === 'Crypto' && COINGECKO_IDS[a.id]);
  if (!wanted.length) return null;
  const ids = [...new Set(wanted.map(a => COINGECKO_IDS[a.id]))].join(',');
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=eur`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    const updated = [];
    for (const a of wanted) {
      const eur = data[COINGECKO_IDS[a.id]]?.eur;
      if (eur && eur > 0) {
        // alleen "vandaag" bijwerken; historie blijft zoals geïmporteerd
        MARKET.prices[a.id][HISTORY_DAYS - 1] = eur;
        updated.push(a.id);
      }
    }
    return updated.length ? updated : null;
  } catch (e) { return null; }
}

/* ============================================================
   Echte koershistorie (CoinGecko, 365 dagen EOD) + export
   ============================================================ */
const LIVEHIST_KEY = 'vermogen_livehist_v1';

function loadLiveHistory() {
  try { return JSON.parse(localStorage.getItem(LIVEHIST_KEY)) || {}; }
  catch (e) { return {}; }
}

/** Voegt echte dagkoersen samen met de bestaande reeks (echt venster wint;
    het stuk ervóór wordt geschaald zodat er geen sprong op de naad zit). */
function mergeRealHistory(assetId, points) {
  const series = MARKET.prices[assetId];
  if (!series || !points.length) return false;
  const byIdx = new Map();
  for (const [ts, price] of points) {
    const idx = dateToIndex(new Date(ts).toISOString());
    byIdx.set(idx, price); // laatste waarde per dag wint
  }
  const idxs = [...byIdx.keys()].sort((a, b) => a - b);
  const first = idxs[0], last = idxs[idxs.length - 1];
  // schaal het gereconstrueerde stuk vóór het echte venster naar de naad
  const ratio = byIdx.get(first) / series[first];
  if (isFinite(ratio) && ratio > 0) {
    for (let i = 0; i < first; i++) series[i] *= ratio;
  }
  // echt venster invullen (gaten forward-fillen)
  let cur = byIdx.get(first);
  for (let i = first; i <= last; i++) {
    if (byIdx.has(i)) cur = byIdx.get(i);
    series[i] = cur;
  }
  // na het venster (zeldzaam): doortrekken naar de laatste echte koers
  for (let i = last + 1; i < HISTORY_DAYS; i++) series[i] = cur;
  return true;
}

/**
 * Haalt 365 dagen echte dagkoersen op voor alle crypto-assets (CoinGecko),
 * sequentieel met pauze i.v.m. rate limits. onProgress(done, total, id).
 */
async function fetchLiveHistory(onProgress) {
  const wanted = ASSETS.filter(a => a.type === 'Crypto' && COINGECKO_IDS[a.id]);
  if (!wanted.length) return { ok: false, error: 'Geen crypto-assets met een bekende CoinGecko-koppeling.' };
  const store = loadLiveHistory();
  const updated = [];
  for (let i = 0; i < wanted.length; i++) {
    const a = wanted[i];
    if (onProgress) onProgress(i, wanted.length, a.id);
    try {
      const url = `https://api.coingecko.com/api/v3/coins/${COINGECKO_IDS[a.id]}/market_chart?vs_currency=eur&days=365&interval=daily`;
      const res = await fetch(url);
      if (res.status === 429) { await new Promise(r => setTimeout(r, 12000)); i--; continue; }
      if (!res.ok) continue;
      const data = await res.json();
      if (data.prices && data.prices.length > 30) {
        // compact opslaan: [dagindex, koers]
        const compact = data.prices.map(([ts, p]) => [dateToIndex(new Date(ts).toISOString()), +p.toPrecision(6)]);
        const dedup = new Map(compact);
        store[a.id] = { at: Date.now(), points: [...dedup.entries()] };
        updated.push(a.id);
      }
    } catch (e) { /* netwerk: overslaan */ }
    if (i < wanted.length - 1) await new Promise(r => setTimeout(r, 1500));
  }
  try { localStorage.setItem(LIVEHIST_KEY, JSON.stringify(store)); } catch (e) { /* quota */ }
  applyLiveHistory();
  if (onProgress) onProgress(wanted.length, wanted.length, null);
  return { ok: updated.length > 0, updated };
}

/** Past opgeslagen echte historie toe op de reeksen in het geheugen. */
function applyLiveHistory() {
  const store = loadLiveHistory();
  for (const [id, entry] of Object.entries(store)) {
    if (!MARKET.prices[id]) continue;
    mergeRealHistory(id, entry.points.map(([idx, p]) => [MARKET.dates[Math.max(0, Math.min(HISTORY_DAYS - 1, idx))].getTime(), p]));
    const a = assetById(id);
    if (a) a.histSource = entry.src === 'yahoo' ? 'yahoo' : 'live';
  }
}

/** Status van de koershistorie per asset (voor de instellingen-pagina). */
function historyStatus(asset) {
  if (asset.histSource === 'live') return { label: 'echt · CoinGecko (1j)', cls: 'up' };
  if (asset.histSource === 'yahoo') return { label: 'echt · Yahoo (1j)', cls: 'up' };
  if (asset.histSource === 'import') return { label: 'echt · uit import', cls: 'up' };
  return { label: 'gereconstrueerd', cls: 'muted' };
}

/** Exporteert alle data als downloadbare JSON (zelfde formaat als import). */
function exportBackup(txs) {
  const koershistorie = {};
  for (const a of ASSETS) {
    const series = MARKET.prices[a.id];
    koershistorie[a.id] = MARKET.dates
      .map((d, i) => ({ date: d.toISOString().slice(0, 10), close: +series[i].toPrecision(6) }))
      .filter((_, i) => i % 1 === 0);
  }
  const payload = {
    meta: { app: 'Vermogen', exportedAt: new Date().toISOString(), note: 'Backup — importeerbaar via Instellingen' },
    transactions: txs,
    koershistorie,
    watchlist: JSON.parse(localStorage.getItem('vermogen_watchlist_v1') || '[]'),
    alerts: loadAlerts().map(({ value, triggered, ...rule }) => rule),
  };
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const el = document.createElement('a');
  el.href = url;
  el.download = `vermogen-backup-${new Date().toISOString().slice(0, 10)}.json`;
  el.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* ============================================================
   Aandelen/ETF-koershistorie via Yahoo Finance
   (chart-API via publieke CORS-proxy — geen API-key nodig;
   alleen tickersymbolen verlaten je browser, nooit je portfolio)
   + USD→EUR-conversie via frankfurter.dev (ECB-koersen, gratis)
   ============================================================ */
const YAHOO_MAP_KEY = 'vermogen_yahoo_v1'; // gevonden symbolen cachen

const CORS_PROXIES = [
  u => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
  u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
];

async function fetchViaProxy(url) {
  for (const wrap of CORS_PROXIES) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      const res = await fetch(wrap(url), { signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok) return await res.json();
    } catch (e) { /* volgende proxy */ }
  }
  return null;
}

/** EUR-koersen per dagindex voor een vreemde valuta (forward-filled). */
async function fxToEurSeries(currency) {
  if (currency === 'EUR') return null;
  const from = MARKET.dates[0].toISOString().slice(0, 10);
  const to = MARKET.dates[HISTORY_DAYS - 1].toISOString().slice(0, 10);
  try {
    const res = await fetch(`https://api.frankfurter.dev/v1/${from}..${to}?base=${currency}&symbols=EUR`);
    if (!res.ok) return null;
    const data = await res.json();
    const series = new Array(HISTORY_DAYS).fill(null);
    for (const [date, rates] of Object.entries(data.rates || {})) {
      series[dateToIndex(date)] = rates.EUR;
    }
    let last = null;
    for (let i = 0; i < HISTORY_DAYS; i++) { if (series[i] !== null) last = series[i]; else series[i] = last; }
    const first = series.find(v => v !== null);
    for (let i = 0; i < HISTORY_DAYS && series[i] === null; i++) series[i] = first;
    return series.some(v => v === null) ? null : series;
  } catch (e) { return null; }
}

/** Probeert een Yahoo-symbool te vinden voor een ticker (US, dan EU-beurzen). */
function yahooCandidates(ticker) {
  return [ticker, `${ticker}.DE`, `${ticker}.AS`, `${ticker}.MI`, `${ticker}.PA`, `${ticker}.L`];
}

async function fetchYahooChart(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d`;
  const data = await fetchViaProxy(url);
  const r = data?.chart?.result?.[0];
  if (!r || !r.timestamp || !r.indicators?.quote?.[0]?.close) return null;
  const closes = r.indicators.quote[0].close;
  const points = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    if (closes[i] !== null && closes[i] > 0) points.push([r.timestamp[i] * 1000, closes[i]]);
  }
  return points.length > 30 ? { points, currency: r.meta?.currency || 'USD', name: r.meta?.shortName || r.meta?.longName || null } : null;
}

/**
 * Haalt echte historie op voor aandelen/ETF's (Yahoo) — beste-effort:
 * probeert per ticker meerdere beurzen, cachet het gevonden symbool.
 */
async function fetchStockHistory(onProgress) {
  const wanted = ASSETS.filter(a => a.type !== 'Crypto');
  if (!wanted.length) return { ok: false, updated: [], failed: [] };
  let symMap;
  try { symMap = JSON.parse(localStorage.getItem(YAHOO_MAP_KEY)) || {}; } catch (e) { symMap = {}; }
  const store = loadLiveHistory();
  const fxCache = {};
  const updated = [], failed = [];

  for (let i = 0; i < wanted.length; i++) {
    const a = wanted[i];
    if (onProgress) onProgress(i, wanted.length, a.id);
    const candidates = symMap[a.id] ? [symMap[a.id], ...yahooCandidates(a.id)] : yahooCandidates(a.id);
    let got = null, gotSym = null;
    for (const sym of candidates) {
      got = await fetchYahooChart(sym);
      if (got) { gotSym = sym; break; }
    }
    if (!got) { failed.push(a.id); continue; }
    symMap[a.id] = gotSym;

    let points = got.points;
    if (got.currency !== 'EUR') {
      if (!(got.currency in fxCache)) fxCache[got.currency] = await fxToEurSeries(got.currency);
      const fx = fxCache[got.currency];
      if (fx) points = points.map(([ts, p]) => [ts, p * fx[dateToIndex(new Date(ts).toISOString())]]);
    }
    const compact = new Map(points.map(([ts, p]) => [dateToIndex(new Date(ts).toISOString()), +p.toPrecision(6)]));
    store[a.id] = { at: Date.now(), points: [...compact.entries()], src: 'yahoo' };
    updated.push(a.id);
    await new Promise(r => setTimeout(r, 400));
  }
  try {
    localStorage.setItem(YAHOO_MAP_KEY, JSON.stringify(symMap));
    localStorage.setItem(LIVEHIST_KEY, JSON.stringify(store));
  } catch (e) { /* quota */ }
  applyLiveHistory();
  if (onProgress) onProgress(wanted.length, wanted.length, null);
  return { ok: updated.length > 0, updated, failed };
}

/* ============================================================
   CSV-import: DEGIRO Transactions.csv & Bitvavo Volledige
   geschiedenis.csv — MERGE-modus: vult bestaande data aan,
   dubbele rijen worden overgeslagen (dedupe op asset+dag+aantal).
   ============================================================ */

// ISIN → ticker (geverifieerd tegen de portefeuille; incl. oude
// CUSIP's van vóór SPAC-fusies en reverse splits)
const ISIN_TICKERS = {
  'IE00BK5BQT80': 'VWCE', 'IE00B3RBWM25': 'VWRL', 'IE00BDVPNG13': 'WTAI', 'DE000A0F5UH1': 'ISPA',
  'US0378331005': 'AAPL', 'US88160R1014': 'TSLA', 'US02079K3059': 'GOOGL', 'US46222L1089': 'IONQ',
  'US7731211089': 'RKLB', 'US7731221062': 'RKLB', 'KYG9442R1267': 'RKLB',
  'US2128731039': 'CONX', 'US63909J1088': 'NAUT', 'KYG3166W1069': 'NAUT',
  'US00534B1008': 'ADGM', 'KYG316591083': 'ADGM', 'US00165C1045': 'AMC',
  'US5494981039': 'LCID', 'US5494982029': 'LCID', 'US1714391026': 'LCID',
  'US02008G1022': 'ALUR', 'US02008G2012': 'ALUR', 'US2048331076': 'ALUR',
  'KYG8990D1253': 'TPGY',
};

/** Simpele maar correcte CSV-parser (quotes, komma's binnen velden). */
function parseCSVText(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(f => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); if (row.some(f => f !== '')) rows.push(row); }
  return rows;
}

function csvRowsToObjects(rows) {
  const header = rows[0];
  return rows.slice(1).map(r => {
    const o = {};
    header.forEach((h, i) => { o[h] = r[i] ?? ''; });
    o._raw = r;
    return o;
  });
}

/** DEGIRO Transactions.csv → genormaliseerde transacties. */
function parseDegiroCSV(objs) {
  const txs = [];
  for (const o of objs) {
    if (!o['Datum'] || !o['ISIN']) continue;
    const aantal = parseNum(o['Aantal']);
    if (!aantal) continue; // 0-rijen zijn CUSIP-conversies e.d.
    const [d, m, y] = o['Datum'].split('-');
    const dag = `${y}-${m}-${d}`; // brondatum = dedupe-dag (géén tz-conversie)
    const waardeEur = Math.abs(parseNum(o['Waarde EUR']) ?? 0);
    const asset = ISIN_TICKERS[o['ISIN']] || o['ISIN'];
    const orderId = (o['Order ID'] || o[''] || o._raw[o._raw.length - 1] || '').trim();
    txs.push({
      id: orderId ? `dg-${orderId}` : `dg-${dag}-${asset}-${aantal}`,
      day: dag,
      date: new Date(`${dag}T12:00:00`).toISOString(),
      type: aantal < 0 ? 'sell' : 'buy',
      asset,
      assetName: (o['Product'] || asset).slice(0, 40),
      qty: Math.abs(aantal),
      price: waardeEur / Math.abs(aantal),
    });
  }
  return { txs, transfers: 0 };
}

/** Bitvavo Volledige geschiedenis.csv → genormaliseerde transacties. */
function parseBitvavoCSV(objs) {
  const txs = [];
  let transfers = 0;
  for (const o of objs) {
    const type = (o['Type'] || '').toLowerCase();
    const cur = o['Currency'];
    if (!cur || cur === 'EUR') continue;
    if (type === 'deposit' || type === 'withdrawal') { transfers++; continue; }
    if (!['buy', 'sell', 'staking', 'fixed_staking', 'manually_assigned'].includes(type)) continue;
    const amt = parseFloat(o['Amount']);
    if (!amt) continue;
    const price = parseFloat(o['Quote Price']) || 0;
    txs.push({
      id: o['Transaction ID'] ? `bv-${o['Transaction ID']}` : `bv-${o['Date']}-${cur}-${amt}`,
      day: o['Date'], // brondatum = dedupe-dag (géén tz-conversie)
      date: new Date(`${o['Date']}T12:00:00`).toISOString(),
      type: amt < 0 ? 'sell' : 'buy',
      asset: cur.toUpperCase(),
      assetName: cur.toUpperCase(),
      qty: Math.abs(amt),
      price, // staking/rewards hebben prijs 0: aantal telt, kostprijs nul
    });
  }
  return { txs, transfers };
}

/**
 * Importeert een transactie-CSV (DEGIRO of Bitvavo) in merge-modus:
 * bestaande transacties blijven staan, alleen nieuwe rijen komen erbij.
 */
function importTransactionCSV(text, existingTxs) {
  const rows = parseCSVText(text);
  if (rows.length < 2) return { ok: false, error: 'CSV is leeg of onleesbaar.' };
  const header = rows[0].join(',').toLowerCase();
  const objs = csvRowsToObjects(rows);

  let parsed, bron;
  if (header.includes('isin') && header.includes('order')) { parsed = parseDegiroCSV(objs); bron = 'DEGIRO'; }
  else if (header.includes('quote price') || header.includes('timezone')) { parsed = parseBitvavoCSV(objs); bron = 'Bitvavo'; }
  else return { ok: false, error: 'CSV-formaat niet herkend. Ondersteund: DEGIRO Transactions.csv en Bitvavo Volledige geschiedenis.csv.' };

  if (!parsed.txs.length) return { ok: false, error: `Geen transacties gevonden in deze ${bron}-export.` };

  // dedupe: asset + dag + aantal (en op id)
  const keys = new Set(), ids = new Set();
  for (const t of existingTxs) {
    keys.add(`${t.asset}|${String(t.date).slice(0, 10)}|${Math.abs(t.qty).toFixed(8)}`);
    ids.add(t.id);
  }
  const known = new Set(ASSETS.map(a => a.id));

  const added = [], skippedAssets = new Set();
  let dedupe = 0;
  for (const t of parsed.txs) {
    if (!known.has(t.asset)) { skippedAssets.add(t.asset); continue; }
    const key = `${t.asset}|${t.day}|${t.qty.toFixed(8)}`;
    if (keys.has(key) || ids.has(t.id)) { dedupe++; continue; }
    keys.add(key); ids.add(t.id);
    delete t.day;
    added.push(t);
  }
  existingTxs.push(...added);
  existingTxs.sort((a, b) => new Date(a.date) - new Date(b.date));
  saveTransactions(existingTxs);

  return {
    ok: true, bron,
    added: added.length,
    dedupe,
    transfers: parsed.transfers,
    skippedAssets: [...skippedAssets],
    addedValue: added.reduce((s, t) => s + (t.type === 'buy' ? 1 : -1) * t.qty * t.price, 0),
  };
}
