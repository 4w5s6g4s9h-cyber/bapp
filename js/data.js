/* ============================================================
   data.js — marktsimulatie & portefeuillemodel
   Gesimuleerde maar realistische marktdata (seeded GBM met
   regimes en jumps), zodat de app deterministisch en offline werkt.
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
// Er is geen demo-data meer: assets komen uitsluitend uit de JSON-import
// van de gebruiker. Alles blijft in localStorage — niets verlaat de browser.
const HISTORY_DAYS = 1095; // ~3 jaar datumgrid

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

const MARKET = { dates: generateDates(), prices: {} };

// Kleuren voor geïmporteerde assets
const CUSTOM_COLORS = ['#f472b6', '#4ade80', '#38bdf8', '#facc15', '#c084fc', '#fb923c', '#2dd4bf', '#a3e635', '#f87171', '#818cf8', '#e879f9', '#fde047'];

/** Registreert een extra (geïmporteerd) asset met een prijsreeks op het datumgrid. */
function registerAsset(asset, prices) {
  if (assetById(asset.id)) { MARKET.prices[asset.id] = prices; return; }
  ASSETS.push(asset);
  MARKET.prices[asset.id] = prices;
}

function assetById(id) { return ASSETS.find(a => a.id === id); }
function lastPrice(id) { return MARKET.prices[id][HISTORY_DAYS - 1]; }
function priceAt(id, i) { return MARKET.prices[id][i]; }

// ---------- Transacties (localStorage) ----------
const TX_KEY = 'vermogen_transactions_v3';

function loadTransactions() {
  try {
    const raw = localStorage.getItem(TX_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        // overblijfsels van de oude demo-versie opruimen
        const clean = parsed.filter(tx => !String(tx.id).startsWith('seed-'));
        if (clean.length !== parsed.length) saveTransactions(clean);
        return clean;
      }
    }
  } catch (e) { /* corrupt -> leeg beginnen */ }
  return [];
}

function saveTransactions(txs) {
  localStorage.setItem(TX_KEY, JSON.stringify(txs));
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
