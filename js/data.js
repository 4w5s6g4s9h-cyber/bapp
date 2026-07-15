/* ============================================================
   data.js — kernmodel, marktgrid en portefeuilleberekeningen

   Het datumgrid bevat kalenderdagen. Daarom annualiseren alle
   afgeleide statistieken met CALENDAR_DAYS_PER_YEAR. Per koerspunt
   wordt daarnaast provenance bijgehouden: alleen aantoonbaar echte
   historie mag financiële analyses en signalen voeden.
   ============================================================ */

// ---------- Seeded RNG ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussianFactory(rng) {
  // Box-Muller
  let spare = null;
  return function () {
    if (spare !== null) { const v = spare; spare = null; return v; }
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    const mag = Math.sqrt(-2.0 * Math.log(u));
    spare = mag * Math.sin(2.0 * Math.PI * v);
    return mag * Math.cos(2.0 * Math.PI * v);
  };
}

// ---------- Assets ----------
// Er is geen ingebouwde portfoliodata: assets komen uit een import of uit
// een expliciete externe koersopdracht. Externe netwerkcalls zijn opt-in.
const HISTORY_DAYS = 1095; // ~3 jaar datumgrid
const CALENDAR_DAYS_PER_YEAR = 365;
const ANALYSIS_MIN_COVERAGE = 0.90;

const ASSETS = [];

// ---------- Datums (kalenderdagen, eindigend vandaag) ----------
function generateDates() {
  const dates = new Array(HISTORY_DAYS);
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  for (let i = 0; i < HISTORY_DAYS; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - (HISTORY_DAYS - 1 - i));
    dates[i] = d;
  }
  return dates;
}

const MARKET = { dates: generateDates(), prices: {}, provenance: {} };

// Kleuren voor geïmporteerde assets
const CUSTOM_COLORS = ['#f472b6', '#4ade80', '#38bdf8', '#facc15', '#c084fc', '#fb923c', '#2dd4bf', '#a3e635', '#f87171', '#818cf8', '#e879f9', '#fde047'];

/** Veilige instrumentcode voor opslag, selectors en datakoppelingen. */
function normalizeAssetId(value) {
  const cleaned = String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9.-]/g, '')
    .slice(0, 12);
  if (!cleaned || ['__PROTO__', 'PROTOTYPE', 'CONSTRUCTOR'].includes(cleaned)) return null;
  return cleaned;
}

/** Veilige CoinGecko API-id voor persistente koerskoppelingen. */
function normalizeCoinGeckoId(value) {
  const cleaned = String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .slice(0, 100);
  return /^[a-z0-9._-]+$/.test(cleaned) ? cleaned : '';
}

function cleanDisplayText(value, maxLength = 80) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[<>]/g, '')
    .trim()
    .slice(0, maxLength);
}

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function safeColor(value, fallback = '#7c6bff') {
  const color = String(value || '');
  return /^(#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([0-9.,%\s-]+\))$/i.test(color) ? color : fallback;
}

function normalizePriceSeries(prices) {
  if (!Array.isArray(prices) || prices.length !== HISTORY_DAYS) return null;
  const out = prices.map(Number);
  return out.every(p => Number.isFinite(p) && p > 0) ? out : null;
}

function normalizeProvenance(provenance, fallback = false) {
  if (!Array.isArray(provenance) || provenance.length !== HISTORY_DAYS) {
    return new Array(HISTORY_DAYS).fill(Boolean(fallback));
  }
  return provenance.map(value => value === true);
}

/** Registreert of actualiseert een asset inclusief koersprovenance. */
function registerAsset(asset, prices, provenance = null) {
  const id = normalizeAssetId(asset?.id);
  const series = normalizePriceSeries(prices);
  if (!id || !series) throw new Error(`Ongeldige asset of koersreeks: ${id || 'onbekend'}`);
  const normalized = {
    ...asset,
    id,
    name: cleanDisplayText(asset.name || id, 80) || id,
    type: ['Crypto', 'ETF', 'Aandeel'].includes(asset.type) ? asset.type : 'Aandeel',
    color: safeColor(asset.color, CUSTOM_COLORS[ASSETS.length % CUSTOM_COLORS.length]),
    currency: cleanDisplayText(asset.currency || 'EUR', 8).toUpperCase(),
    isin: cleanDisplayText(asset.isin || '', 16).toUpperCase(),
    venue: cleanDisplayText(asset.venue || '', 16).toUpperCase(),
    yahoo: cleanDisplayText(asset.yahoo || '', 32),
    cg: normalizeCoinGeckoId(asset.cg),
  };
  const existing = assetById(id);
  if (existing) Object.assign(existing, normalized);
  else ASSETS.push(normalized);
  MARKET.prices[id] = series;
  // Afwezigheid van expliciete herkomst is nooit bewijs van echte historie.
  MARKET.provenance[id] = normalizeProvenance(provenance, false);
}

function assetById(id) { return ASSETS.find(a => a.id === id); }
function lastPrice(id) { return MARKET.prices[id][HISTORY_DAYS - 1]; }
function priceAt(id, i) { return MARKET.prices[id][i]; }

function marketCoverage(assetId, start = 0, end = HISTORY_DAYS - 1) {
  const provenance = MARKET.provenance[assetId];
  if (!provenance) return 0;
  const i0 = Math.max(0, start), i1 = Math.min(HISTORY_DAYS - 1, end);
  if (i1 < i0) return 0;
  let real = 0;
  for (let i = i0; i <= i1; i++) if (provenance[i]) real++;
  return real / (i1 - i0 + 1);
}

function hasReliableHistory(assetId, days = 365, minCoverage = ANALYSIS_MIN_COVERAGE) {
  const start = Math.max(0, HISTORY_DAYS - days);
  return marketCoverage(assetId, start, HISTORY_DAYS - 1) >= minCoverage;
}

function historyCoverageLabel(assetId, days = 365) {
  return `${Math.round(marketCoverage(assetId, Math.max(0, HISTORY_DAYS - days), HISTORY_DAYS - 1) * 100)}% echt`;
}

// ---------- Transacties (localStorage) ----------
const TX_KEY = 'vermogen_transactions_v3';

function normalizeStoredTransaction(tx) {
  if (!tx || typeof tx !== 'object') return null;
  const date = new Date(tx.date);
  const asset = normalizeAssetId(tx.asset);
  const qty = Number(tx.qty), price = Number(tx.price);
  if (!Number.isFinite(date.getTime()) || !asset || !['buy', 'sell'].includes(tx.type)
      || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price < 0) return null;
  const out = {
    id: cleanDisplayText(tx.id || `tx-${date.getTime()}-${asset}`, 100),
    date: date.toISOString(), type: tx.type, asset, qty, price,
  };
  if (tx.transfer === true) out.transfer = true;
  if (tx.dca && typeof tx.dca === 'object') {
    out.dca = { plan: cleanDisplayText(tx.dca.plan || '', 80), mult: Number(tx.dca.mult) || 1 };
  }
  return out;
}

function loadTransactions() {
  try {
    const raw = localStorage.getItem(TX_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        // overblijfsels van de oude demo-versie opruimen
        const clean = parsed
          .filter(tx => !String(tx.id).startsWith('seed-'))
          .map(normalizeStoredTransaction)
          .filter(Boolean);
        if (clean.length !== parsed.length || JSON.stringify(clean) !== JSON.stringify(parsed)) saveTransactions(clean);
        return clean;
      }
    }
  } catch (e) { /* corrupt -> leeg beginnen */ }
  return [];
}

function saveTransactions(txs) {
  if (!Array.isArray(txs)) throw new Error('Transacties moeten een lijst zijn.');
  const clean = txs.map(normalizeStoredTransaction);
  if (clean.some(tx => tx === null)) throw new Error('Een transactie is ongeldig.');
  localStorage.setItem(TX_KEY, JSON.stringify(clean));
}

// ---------- Portefeuille-berekeningen ----------
function dateToIndex(isoDate) {
  const t = new Date(isoDate).getTime();
  const start = MARKET.dates[0].getTime();
  const idx = Math.round((t - start) / 86400000);
  return Math.max(0, Math.min(HISTORY_DAYS - 1, idx));
}

// Holdings (aantallen per asset) per dag opbouwen uit transacties
function computeHoldingsTimeline(txs) {
  const deltas = {}; // idx -> {asset: dqty}
  for (const tx of txs) {
    const idx = dateToIndex(tx.date);
    const sign = tx.type === 'buy' ? 1 : -1;
    if (!deltas[idx]) deltas[idx] = {};
    deltas[idx][tx.asset] = (deltas[idx][tx.asset] || 0) + sign * tx.qty;
  }
  const timeline = new Array(HISTORY_DAYS);
  const current = {};
  for (let i = 0; i < HISTORY_DAYS; i++) {
    if (deltas[i]) {
      for (const [asset, dq] of Object.entries(deltas[i])) {
        current[asset] = Math.max(0, (current[asset] || 0) + dq);
      }
    }
    timeline[i] = { ...current };
  }
  return timeline;
}

function computePortfolioSeries(txs) {
  const timeline = computeHoldingsTimeline(txs);
  const values = new Array(HISTORY_DAYS);
  for (let i = 0; i < HISTORY_DAYS; i++) {
    let v = 0;
    for (const [asset, qty] of Object.entries(timeline[i])) {
      if (qty > 0 && MARKET.prices[asset]) v += qty * MARKET.prices[asset][i];
    }
    values[i] = v;
  }
  return { values, timeline };
}

/** Externe cashflow per dag: aankopen positief, verkopen negatief. */
function computeCashflowSeries(txs) {
  const flows = new Array(HISTORY_DAYS).fill(0);
  for (const tx of txs) {
    const amount = Number(tx.qty) * Number(tx.price);
    if (!Number.isFinite(amount)) continue;
    flows[dateToIndex(tx.date)] += (tx.type === 'buy' ? 1 : -1) * amount;
  }
  return flows;
}

/**
 * Cashflow-neutrale dagrendementen. Een flow wordt aan het begin van de dag
 * verondersteld: V_t / (V_t-1 + flow_t) - 1. Dit voorkomt dat een aankoop
 * als winst en een verkoop als verlies wordt weergegeven.
 */
function cashflowAdjustedReturns(txs, values) {
  const flows = computeCashflowSeries(txs);
  const returns = new Array(HISTORY_DAYS).fill(null);
  for (let i = 0; i < HISTORY_DAYS; i++) {
    const previous = i === 0 ? 0 : values[i - 1];
    const base = previous + flows[i];
    if (base > 1e-9 && Number.isFinite(values[i])) returns[i] = values[i] / base - 1;
  }
  return { returns, flows };
}

function cumulativeFromReturns(returns) {
  const out = new Array(returns.length).fill(null);
  let wealth = 1, started = false;
  for (let i = 0; i < returns.length; i++) {
    const r = returns[i];
    if (r === null || !Number.isFinite(r)) continue;
    started = true;
    wealth *= 1 + r;
    out[i] = wealth;
  }
  return started ? out : new Array(returns.length).fill(null);
}

function dailyPortfolioPnl(txs, values, index = HISTORY_DAYS - 1) {
  const flows = computeCashflowSeries(txs);
  const previous = index > 0 ? values[index - 1] : 0;
  const pnl = values[index] - previous - flows[index];
  const base = previous + flows[index];
  return { pnl, pct: base > 1e-9 ? pnl / base : 0, flow: flows[index] };
}

// Huidige posities met gemiddelde koopprijs (moving average cost basis)
function computePositions(txs) {
  const sorted = [...txs].sort((a, b) => new Date(a.date) - new Date(b.date));
  const pos = {}; // asset -> {qty, cost}
  for (const tx of sorted) {
    if (!pos[tx.asset]) pos[tx.asset] = { qty: 0, cost: 0 };
    const p = pos[tx.asset];
    if (tx.type === 'buy') {
      p.cost += tx.qty * tx.price;
      p.qty += tx.qty;
    } else {
      const avg = p.qty > 0 ? p.cost / p.qty : 0;
      const sellQty = Math.min(tx.qty, p.qty);
      p.cost -= avg * sellQty;
      p.qty -= sellQty;
    }
  }
  return ASSETS
    .filter(a => pos[a.id] && pos[a.id].qty > 1e-9 && MARKET.prices[a.id])
    .map(a => {
      const { qty, cost } = pos[a.id];
      const price = lastPrice(a.id);
      const value = qty * price;
      const avgPrice = cost / qty;
      return {
        asset: a, qty, avgPrice, price, value,
        cost,
        gain: value - cost,
        gainPct: cost > 0 ? (value / cost - 1) * 100 : 0,
      };
    })
    .sort((x, y) => y.value - x.value);
}

function totalInvested(txs) {
  // netto ingelegd: koopsom - verkoopopbrengst
  let sum = 0;
  for (const tx of txs) sum += (tx.type === 'buy' ? 1 : -1) * tx.qty * tx.price;
  return sum;
}

// ---------- Helpers ----------
function round2(x) { return Math.round(x * 100) / 100; }

const fmtEUR = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const fmtEUR2 = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtNum = new Intl.NumberFormat('nl-NL', { maximumFractionDigits: 4 });
const fmtDate = new Intl.DateTimeFormat('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtDateShort = new Intl.DateTimeFormat('nl-NL', { day: 'numeric', month: 'short' });

function fmtPct(x, digits = 2) {
  const sign = x > 0 ? '+' : '';
  return `${sign}${x.toFixed(digits).replace('.', ',')}%`;
}
function fmtSignedEUR(x) {
  return (x >= 0 ? '+' : '−') + fmtEUR.format(Math.abs(x));
}
