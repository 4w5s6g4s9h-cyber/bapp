/* ============================================================
   data.js — kernmodel, marktgrid en portefeuilleberekeningen

   Het datumgrid bevat kalenderdagen. Daarom annualiseren alle
   afgeleide statistieken met CALENDAR_DAYS_PER_YEAR. Per koerspunt
   wordt daarnaast kwaliteit bijgehouden: waargenomen marktdata,
   een doorgetrokken kalenderdag, of gereconstrueerde data. De
   legacy-provenance-array blijft als afgeleide compatibiliteitslaag.
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
const MARKET_SERIES_SCHEMA_VERSION = 2;
const PRICE_QUALITY = Object.freeze({
  OBSERVED: 'observed',
  CARRIED: 'carried',
  RECONSTRUCTED: 'reconstructed',
});
const PRICE_QUALITY_VALUES = new Set(Object.values(PRICE_QUALITY));
const MAX_CARRY_DAYS = Object.freeze({ Crypto: 1, ETF: 4, Aandeel: 4 });

const ASSETS = [];

// ---------- Datums (lokale kalenderdagen, eindigend vandaag) ----------
function localDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function localDateFromKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
  const [year, month, day] = String(value).split('-').map(Number);
  const date = new Date(year, month - 1, day, 12, 0, 0, 0);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

function calendarDayNumber(value) {
  const date = value instanceof Date ? value : localDateFromKey(value) || new Date(value);
  if (!Number.isFinite(date.getTime())) return NaN;
  return Math.trunc(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000);
}

function calendarDayDiff(from, to) {
  const start = calendarDayNumber(from), end = calendarDayNumber(to);
  return Number.isFinite(start) && Number.isFinite(end) ? end - start : NaN;
}

function addCalendarDays(dayKey, amount) {
  const date = localDateFromKey(dayKey);
  if (!date || !Number.isInteger(Number(amount))) return '';
  date.setDate(date.getDate() + Number(amount));
  return localDateKey(date);
}

function generateDates(endDate = new Date()) {
  const dates = new Array(HISTORY_DAYS);
  const today = new Date(endDate);
  if (!Number.isFinite(today.getTime())) throw new Error('Ongeldige einddatum voor marktgrid.');
  today.setHours(12, 0, 0, 0);
  for (let i = 0; i < HISTORY_DAYS; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - (HISTORY_DAYS - 1 - i));
    dates[i] = d;
  }
  return dates;
}

const MARKET = { dates: generateDates(), prices: {}, quality: {}, provenance: {}, meta: {} };

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

function normalizePriceQuality(quality, provenance = null) {
  if (Array.isArray(quality) && quality.length === HISTORY_DAYS
      && quality.every(value => PRICE_QUALITY_VALUES.has(value))) {
    return [...quality];
  }
  return normalizeProvenance(provenance, false)
    .map(value => value ? PRICE_QUALITY.OBSERVED : PRICE_QUALITY.RECONSTRUCTED);
}

function qualityIsReliable(value) {
  return value === PRICE_QUALITY.OBSERVED || value === PRICE_QUALITY.CARRIED;
}

function carryLimitForAsset(assetOrType) {
  const type = typeof assetOrType === 'string' ? assetOrType : assetOrType?.type;
  return MAX_CARRY_DAYS[type] ?? MAX_CARRY_DAYS.Aandeel;
}

/** Een carried punt is alleen betrouwbaar zolang het direct op een recente
    waarneming voortbouwt. Langdurige datagaten worden fail-closed. */
function sanitizePriceQuality(quality, assetOrType) {
  const normalized = normalizePriceQuality(quality);
  const limit = carryLimitForAsset(assetOrType);
  const out = new Array(HISTORY_DAYS);
  let lastObserved = -Infinity;
  for (let i = 0; i < HISTORY_DAYS; i++) {
    if (normalized[i] === PRICE_QUALITY.OBSERVED) {
      out[i] = PRICE_QUALITY.OBSERVED;
      lastObserved = i;
    } else if (normalized[i] === PRICE_QUALITY.CARRIED
        && i > 0 && qualityIsReliable(out[i - 1]) && i - lastObserved <= limit) {
      out[i] = PRICE_QUALITY.CARRIED;
    } else {
      out[i] = PRICE_QUALITY.RECONSTRUCTED;
    }
  }
  return out;
}

/** Registreert of actualiseert een asset inclusief koerskwaliteit. */
function registerAsset(asset, prices, provenance = null, quality = null, marketMeta = null) {
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
  const normalizedQuality = sanitizePriceQuality(normalizePriceQuality(quality, provenance), normalized);
  MARKET.quality[id] = normalizedQuality;
  MARKET.provenance[id] = normalizedQuality.map(qualityIsReliable);
  MARKET.meta[id] = {
    ...(MARKET.meta[id] || {}),
    ...(marketMeta && typeof marketMeta === 'object' ? marketMeta : {}),
    gridStartDate: localDateKey(MARKET.dates[0]),
    gridEndDate: localDateKey(MARKET.dates[HISTORY_DAYS - 1]),
  };
}

function assetById(id) { return ASSETS.find(a => a.id === id); }
function lastPrice(id) { return MARKET.prices[id][HISTORY_DAYS - 1]; }
function priceAt(id, i) { return MARKET.prices[id][i]; }

function priceQualityAt(assetId, index) {
  return MARKET.quality[assetId]?.[index] || PRICE_QUALITY.RECONSTRUCTED;
}

function isObservedPrice(assetId, index = HISTORY_DAYS - 1) {
  return priceQualityAt(assetId, index) === PRICE_QUALITY.OBSERVED;
}

function isReliablePrice(assetId, index = HISTORY_DAYS - 1) {
  return qualityIsReliable(priceQualityAt(assetId, index));
}

function latestObservedPriceIndex(assetId, end = HISTORY_DAYS - 1) {
  const quality = MARKET.quality[assetId];
  if (!quality) return -1;
  for (let i = Math.min(HISTORY_DAYS - 1, Math.max(0, end)); i >= 0; i--) {
    if (quality[i] === PRICE_QUALITY.OBSERVED) return i;
  }
  return -1;
}

function marketFreshness(assetId, end = HISTORY_DAYS - 1) {
  const index = Math.min(HISTORY_DAYS - 1, Math.max(0, Number(end) || 0));
  const observedIndex = latestObservedPriceIndex(assetId, index);
  const ageDays = observedIndex >= 0 ? index - observedIndex : null;
  const limitDays = carryLimitForAsset(assetById(assetId));
  const currentQuality = priceQualityAt(assetId, index);
  return {
    assetId,
    index,
    currentQuality,
    observedIndex,
    observedDate: observedIndex >= 0 ? localDateKey(MARKET.dates[observedIndex]) : null,
    ageDays,
    limitDays,
    fresh: observedIndex >= 0 && ageDays <= limitDays && qualityIsReliable(currentQuality),
  };
}

function isFreshPrice(assetId, index = HISTORY_DAYS - 1) {
  return marketFreshness(assetId, index).fresh;
}

/**
 * Schuift het runtimegrid naar de actuele lokale kalenderdag zonder bestaande
 * prijzen opnieuw te dateren. Nieuwe dagen krijgen uitsluitend carried- of
 * reconstructed-kwaliteit; nooit stilzwijgend observed.
 */
function ensureCurrentMarketGrid(now = new Date()) {
  const nextDates = generateDates(now);
  const currentEnd = localDateKey(MARKET.dates[HISTORY_DAYS - 1]);
  const nextEnd = localDateKey(nextDates[HISTORY_DAYS - 1]);
  if (currentEnd === nextEnd) return false;

  const oldDateIndex = new Map(MARKET.dates.map((date, index) => [localDateKey(date), index]));
  const oldStart = localDateKey(MARKET.dates[0]);
  const oldEnd = currentEnd;
  for (const id of Object.keys(MARKET.prices)) {
    const asset = assetById(id);
    const oldPrices = MARKET.prices[id];
    const oldQuality = sanitizePriceQuality(normalizePriceQuality(MARKET.quality[id], MARKET.provenance[id]), asset);
    const nextPrices = new Array(HISTORY_DAYS);
    const nextQuality = new Array(HISTORY_DAYS);
    for (let i = 0; i < HISTORY_DAYS; i++) {
      const key = localDateKey(nextDates[i]);
      const oldIndex = oldDateIndex.get(key);
      if (oldIndex !== undefined) {
        nextPrices[i] = oldPrices[oldIndex];
        nextQuality[i] = oldQuality[oldIndex];
      } else if (key < oldStart) {
        nextPrices[i] = oldPrices[0];
        nextQuality[i] = PRICE_QUALITY.RECONSTRUCTED;
      } else if (key > oldEnd) {
        const previousPrice = i > 0 ? nextPrices[i - 1] : oldPrices[HISTORY_DAYS - 1];
        const previousQuality = i > 0 ? nextQuality[i - 1] : oldQuality[HISTORY_DAYS - 1];
        nextPrices[i] = previousPrice;
        nextQuality[i] = qualityIsReliable(previousQuality) ? PRICE_QUALITY.CARRIED : PRICE_QUALITY.RECONSTRUCTED;
      } else {
        nextPrices[i] = i > 0 ? nextPrices[i - 1] : oldPrices[0];
        nextQuality[i] = i > 0 && qualityIsReliable(nextQuality[i - 1])
          ? PRICE_QUALITY.CARRIED
          : PRICE_QUALITY.RECONSTRUCTED;
      }
    }
    MARKET.prices[id] = nextPrices;
    MARKET.quality[id] = sanitizePriceQuality(nextQuality, asset);
    MARKET.provenance[id] = MARKET.quality[id].map(qualityIsReliable);
    MARKET.meta[id] = {
      ...(MARKET.meta[id] || {}),
      gridStartDate: localDateKey(nextDates[0]),
      gridEndDate: nextEnd,
    };
  }
  MARKET.dates = nextDates;
  return true;
}

function marketCoverage(assetId, start = 0, end = HISTORY_DAYS - 1) {
  const quality = MARKET.quality[assetId];
  if (!quality) return 0;
  const i0 = Math.max(0, start), i1 = Math.min(HISTORY_DAYS - 1, end);
  if (i1 < i0) return 0;
  let covered = 0;
  for (let i = i0; i <= i1; i++) if (qualityIsReliable(quality[i])) covered++;
  return covered / (i1 - i0 + 1);
}

function observedCoverage(assetId, start = 0, end = HISTORY_DAYS - 1) {
  const quality = MARKET.quality[assetId];
  if (!quality) return 0;
  const i0 = Math.max(0, start), i1 = Math.min(HISTORY_DAYS - 1, end);
  if (i1 < i0) return 0;
  let observed = 0;
  for (let i = i0; i <= i1; i++) if (quality[i] === PRICE_QUALITY.OBSERVED) observed++;
  return observed / (i1 - i0 + 1);
}

function hasReliableHistory(assetId, days = 365, minCoverage = ANALYSIS_MIN_COVERAGE) {
  const start = Math.max(0, HISTORY_DAYS - days);
  return isFreshPrice(assetId, HISTORY_DAYS - 1)
    && marketCoverage(assetId, start, HISTORY_DAYS - 1) >= minCoverage;
}

function historyCoverageLabel(assetId, days = 365) {
  const start = Math.max(0, HISTORY_DAYS - days);
  const covered = Math.round(marketCoverage(assetId, start, HISTORY_DAYS - 1) * 100);
  const observed = Math.round(observedCoverage(assetId, start, HISTORY_DAYS - 1) * 100);
  return `${covered}% bron-gedekt · ${observed}% waargenomen`;
}

// ---------- Transacties + cashledger (schema v4) ----------
const TX_KEY = 'vermogen_transactions_v4';
const LEGACY_TX_KEY = 'vermogen_transactions_v3';
const RECONCILIATION_KEY = 'vermogen_reconciliation_v1';
const TRANSACTION_TYPES = Object.freeze([
  'buy', 'sell', 'deposit', 'withdrawal', 'dividend', 'interest',
  'fee', 'tax', 'split', 'transfer_in', 'transfer_out',
]);
const TRADE_TYPES = new Set(['buy', 'sell']);
const TRANSFER_TYPES = new Set(['transfer_in', 'transfer_out']);
const CASH_EVENT_TYPES = new Set(['deposit', 'withdrawal', 'dividend', 'interest', 'fee', 'tax']);
const ASSET_REQUIRED_TYPES = new Set(['buy', 'sell', 'split', 'transfer_in', 'transfer_out']);

function normalizeCurrency(value) {
  const currency = cleanDisplayText(value || 'EUR', 3).toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : null;
}

function normalizedNonNegative(value, fallback = 0) {
  const number = value === '' || value === null || value === undefined ? fallback : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function optionalNonNegative(value) {
  if (value === '' || value === null || value === undefined) return undefined;
  return normalizedNonNegative(value);
}

/**
 * Normaliseert schema-v4-gebeurtenissen. Oude v3 buy/sell-rijen worden als
 * extern afgerekend gemarkeerd: zo blijft hun historische waardering gelijk,
 * terwijl nieuwe interne trades de cashrekening wel gebruiken.
 */
function normalizeStoredTransaction(tx, { legacy = false } = {}) {
  if (!tx || typeof tx !== 'object' || Array.isArray(tx)) return null;
  const date = new Date(tx.date);
  if (!Number.isFinite(date.getTime())) return null;

  let type = cleanDisplayText(tx.type || '', 20).toLowerCase();
  if (tx.transfer === true && (type === 'buy' || type === 'sell')) {
    type = type === 'buy' ? 'transfer_in' : 'transfer_out';
  }
  if (!TRANSACTION_TYPES.includes(type)) return null;

  const asset = normalizeAssetId(tx.asset);
  if (ASSET_REQUIRED_TYPES.has(type) && !asset) return null;
  const currency = normalizeCurrency(tx.currency);
  const fxRate = Number(tx.fxRate ?? 1);
  if (!currency || !Number.isFinite(fxRate) || fxRate <= 0 || fxRate >= 1e6) return null;

  const out = {
    id: cleanDisplayText(tx.id || `tx-${date.getTime()}-${asset || type}`, 100),
    date: date.toISOString(), type, currency, fxRate,
  };
  if (asset) out.asset = asset;

  if (TRADE_TYPES.has(type)) {
    const qty = Number(tx.qty), price = Number(tx.price);
    const fee = normalizedNonNegative(tx.fee), tax = normalizedNonNegative(tx.tax);
    if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price < 0 || fee === null || tax === null) return null;
    Object.assign(out, { qty, price, fee, tax, external: legacy ? tx.external !== false : tx.external === true });
  } else if (TRANSFER_TYPES.has(type)) {
    const qty = Number(tx.qty), price = normalizedNonNegative(tx.price);
    const costBasis = optionalNonNegative(tx.costBasis);
    const externalValue = optionalNonNegative(tx.externalValue);
    if (!Number.isFinite(qty) || qty <= 0 || price === null || costBasis === null || externalValue === null) return null;
    Object.assign(out, { qty, price });
    if (costBasis !== undefined) out.costBasis = costBasis;
    if (externalValue !== undefined) out.externalValue = externalValue;
  } else if (type === 'split') {
    const ratio = Number(tx.ratio);
    if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1e6) return null;
    out.ratio = ratio;
  } else if (CASH_EVENT_TYPES.has(type)) {
    const amount = Number(tx.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount >= 1e12) return null;
    out.amount = amount;
  }

  if (tx.dca && typeof tx.dca === 'object' && type === 'buy') {
    out.dca = { plan: cleanDisplayText(tx.dca.plan || '', 80), mult: Number(tx.dca.mult) || 1 };
  }
  const note = cleanDisplayText(tx.note || '', 160);
  const source = cleanDisplayText(tx.source || '', 40);
  if (note) out.note = note;
  if (source) out.source = source;
  return out;
}

function loadTransactions() {
  const read = (key, legacy) => {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const clean = parsed
      .filter(tx => !String(tx?.id).startsWith('seed-'))
      .map(tx => normalizeStoredTransaction(tx, { legacy }))
      .filter(Boolean);
    return { parsed, clean };
  };
  try {
    const current = read(TX_KEY, false);
    if (current) {
      if (current.clean.length !== current.parsed.length || JSON.stringify(current.clean) !== JSON.stringify(current.parsed)) {
        localStorage.setItem(TX_KEY, JSON.stringify(current.clean));
      }
      return current.clean;
    }
    const legacy = read(LEGACY_TX_KEY, true);
    if (legacy) {
      const encoded = JSON.stringify(legacy.clean);
      localStorage.setItem(TX_KEY, encoded);
      if (localStorage.getItem(TX_KEY) !== encoded) throw new Error('Migratie naar transactieschema v4 is niet bevestigd.');
      localStorage.removeItem(LEGACY_TX_KEY);
      return legacy.clean;
    }
  } catch (e) { /* corrupt -> leeg beginnen; backuprestore blijft beschikbaar */ }
  return [];
}

function saveTransactions(txs) {
  if (!Array.isArray(txs)) throw new Error('Transacties moeten een lijst zijn.');
  const clean = txs.map(tx => normalizeStoredTransaction(tx));
  if (clean.some(tx => tx === null)) throw new Error('Een transactie is ongeldig.');
  const ids = new Set(clean.map(tx => tx.id));
  if (ids.size !== clean.length) throw new Error('Transactie-id’s moeten uniek zijn.');
  const encoded = JSON.stringify(clean);
  localStorage.setItem(TX_KEY, encoded);
  if (localStorage.getItem(TX_KEY) !== encoded) throw new Error('Transacties konden niet betrouwbaar worden opgeslagen.');
}

function transactionFxRate(tx) {
  const rate = Number(tx?.fxRate ?? 1);
  return Number.isFinite(rate) && rate > 0 ? rate : 1;
}
function transactionPriceEur(tx) { return Number(tx?.price || 0) * transactionFxRate(tx); }
function transactionAmountEur(tx) { return Number(tx?.amount || 0) * transactionFxRate(tx); }
function transactionFeeEur(tx) { return Number(tx?.fee || 0) * transactionFxRate(tx); }
function transactionTaxEur(tx) { return Number(tx?.tax || 0) * transactionFxRate(tx); }
function transactionTradeGrossEur(tx) {
  return Number(tx?.qty || 0) * transactionPriceEur(tx) + transactionFeeEur(tx) + transactionTaxEur(tx);
}
function transactionTradeNetEur(tx) {
  return Number(tx?.qty || 0) * transactionPriceEur(tx) - transactionFeeEur(tx) - transactionTaxEur(tx);
}
function transactionTransferValueEur(tx) {
  const native = tx?.externalValue !== undefined ? Number(tx.externalValue) : Number(tx?.qty || 0) * Number(tx?.price || 0);
  return Number.isFinite(native) ? native * transactionFxRate(tx) : 0;
}
function transactionTransferCostEur(tx) {
  const native = tx?.costBasis !== undefined ? Number(tx.costBasis) : Number(tx?.qty || 0) * Number(tx?.price || 0);
  return Number.isFinite(native) ? native * transactionFxRate(tx) : 0;
}

// ---------- Portefeuille-berekeningen ----------
function dateToIndex(isoDate) {
  const date = new Date(isoDate);
  const idx = calendarDayDiff(MARKET.dates[0], date);
  if (!Number.isFinite(idx)) return 0;
  return Math.max(0, Math.min(HISTORY_DAYS - 1, idx));
}

function dateToIndexUnclamped(value) {
  const date = value instanceof Date ? value : new Date(value);
  return calendarDayDiff(MARKET.dates[0], date);
}

function isFutureCalendarDate(value, reference = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return calendarDayDiff(reference, date) > 0;
}

function emptyLedgerPosition() { return { qty: 0, cost: 0, realized: 0 }; }

function addLedgerIssue(ledger, tx, code, message) {
  ledger.issues.push({ txId: tx.id, date: tx.date, asset: tx.asset || '', code, message });
}

/** Past één gevalideerde gebeurtenis toe en retourneert de externe flow naar de portefeuille. */
function applyLedgerTransaction(ledger, tx) {
  let externalFlow = 0;
  const position = tx.asset ? (ledger.positions[tx.asset] ||= emptyLedgerPosition()) : null;

  if (tx.type === 'buy') {
    const gross = transactionTradeGrossEur(tx);
    if (tx.external) { ledger.cash += gross; externalFlow += gross; }
    ledger.cash -= gross;
    position.qty += tx.qty;
    position.cost += gross;
    ledger.fees += transactionFeeEur(tx);
    ledger.taxes += transactionTaxEur(tx);
  } else if (tx.type === 'sell') {
    if (tx.qty > position.qty + 1e-9) {
      addLedgerIssue(ledger, tx, 'oversell', `Verkoop van ${tx.qty} ${tx.asset} overschrijdt het beschikbare aantal ${position.qty}.`);
      return 0;
    }
    const avg = position.qty > 0 ? position.cost / position.qty : 0;
    const basis = avg * tx.qty;
    const net = transactionTradeNetEur(tx);
    position.qty -= tx.qty;
    position.cost = Math.max(0, position.cost - basis);
    position.realized += net - basis;
    ledger.realized += net - basis;
    ledger.cash += net;
    if (tx.external) { ledger.cash -= net; externalFlow -= net; }
    ledger.fees += transactionFeeEur(tx);
    ledger.taxes += transactionTaxEur(tx);
  } else if (tx.type === 'deposit') {
    const amount = transactionAmountEur(tx);
    ledger.cash += amount; externalFlow += amount;
  } else if (tx.type === 'withdrawal') {
    const amount = transactionAmountEur(tx);
    ledger.cash -= amount; externalFlow -= amount;
  } else if (tx.type === 'dividend' || tx.type === 'interest') {
    const amount = transactionAmountEur(tx);
    ledger.cash += amount;
    ledger.income += amount;
  } else if (tx.type === 'fee') {
    const amount = transactionAmountEur(tx);
    ledger.cash -= amount; ledger.fees += amount;
  } else if (tx.type === 'tax') {
    const amount = transactionAmountEur(tx);
    ledger.cash -= amount; ledger.taxes += amount;
  } else if (tx.type === 'transfer_in') {
    const cost = transactionTransferCostEur(tx);
    position.qty += tx.qty;
    position.cost += cost;
    externalFlow += transactionTransferValueEur(tx);
  } else if (tx.type === 'transfer_out') {
    if (tx.qty > position.qty + 1e-9) {
      addLedgerIssue(ledger, tx, 'overtransfer', `Transfer van ${tx.qty} ${tx.asset} overschrijdt het beschikbare aantal ${position.qty}.`);
      return 0;
    }
    const avg = position.qty > 0 ? position.cost / position.qty : 0;
    position.qty -= tx.qty;
    position.cost = Math.max(0, position.cost - avg * tx.qty);
    externalFlow -= transactionTransferValueEur(tx);
  } else if (tx.type === 'split') {
    if (position.qty <= 0) {
      addLedgerIssue(ledger, tx, 'split-without-position', `Split voor ${tx.asset} heeft geen bestaande positie.`);
      return 0;
    }
    position.qty *= tx.ratio;
  }
  ledger.minCash = Math.min(ledger.minCash, ledger.cash);
  return externalFlow;
}

/** Bouwt effecten, cash, kostbasis en externe flows op één gedeelde tijdlijn. */
function buildPortfolioLedger(txs) {
  const eventsByDay = new Map();
  const preflightIssues = [];
  const normalized = (Array.isArray(txs) ? txs : [])
    .map(tx => normalizeStoredTransaction(tx))
    .filter(Boolean)
    .sort((a, b) => new Date(a.date) - new Date(b.date) || a.id.localeCompare(b.id));
  for (const tx of normalized) {
    const rawIndex = dateToIndexUnclamped(tx.date);
    if (rawIndex >= HISTORY_DAYS) {
      preflightIssues.push({
        txId: tx.id, date: tx.date, asset: tx.asset || '', code: 'future-transaction',
        message: `Boeking ${tx.id} ligt na de huidige kalenderdag en is niet verwerkt.`,
      });
      continue;
    }
    const idx = Math.max(0, rawIndex);
    if (!eventsByDay.has(idx)) eventsByDay.set(idx, []);
    eventsByDay.get(idx).push(tx);
  }

  const ledger = {
    cash: 0, minCash: 0, positions: {}, issues: preflightIssues,
    realized: 0, income: 0, fees: 0, taxes: 0,
  };
  const timeline = new Array(HISTORY_DAYS);
  const cashTimeline = new Array(HISTORY_DAYS).fill(0);
  const externalFlows = new Array(HISTORY_DAYS).fill(0);
  const values = new Array(HISTORY_DAYS).fill(0);

  for (let i = 0; i < HISTORY_DAYS; i++) {
    for (const tx of eventsByDay.get(i) || []) externalFlows[i] += applyLedgerTransaction(ledger, tx);
    const holdings = {};
    for (const [asset, position] of Object.entries(ledger.positions)) {
      if (position.qty > 1e-9) holdings[asset] = position.qty;
    }
    timeline[i] = holdings;
    cashTimeline[i] = ledger.cash;
    let value = ledger.cash;
    for (const [asset, qty] of Object.entries(holdings)) {
      if (MARKET.prices[asset]) value += qty * MARKET.prices[asset][i];
    }
    values[i] = value;
  }
  if (ledger.minCash < -0.005) {
    ledger.issues.push({
      txId: '', date: '', asset: '', code: 'negative-cash',
      message: `Het cashsaldo was historisch minimaal ${ledger.minCash.toFixed(2)} EUR; mogelijk ontbreekt een storting.`,
    });
  }
  return { ...ledger, timeline, cashTimeline, externalFlows, values };
}

function computeHoldingsTimeline(txs) { return buildPortfolioLedger(txs).timeline; }

function computePortfolioSeries(txs) {
  const ledger = buildPortfolioLedger(txs);
  return {
    values: ledger.values, timeline: ledger.timeline, cashTimeline: ledger.cashTimeline,
    externalFlows: ledger.externalFlows, cash: ledger.cash, ledger,
  };
}

/** Externe stortingen/onttrekkingen; interne trades, inkomsten en kosten tellen niet mee. */
function computeCashflowSeries(txs) { return buildPortfolioLedger(txs).externalFlows; }

function externalCashflowEvents(txs) {
  const ledger = {
    cash: 0, minCash: 0, positions: {}, issues: [],
    realized: 0, income: 0, fees: 0, taxes: 0,
  };
  const events = [];
  const normalized = (Array.isArray(txs) ? txs : [])
    .map(row => normalizeStoredTransaction(row))
    .filter(Boolean)
    .sort((a, b) => new Date(a.date) - new Date(b.date) || a.id.localeCompare(b.id));
  for (const tx of normalized) {
    if (dateToIndexUnclamped(tx.date) >= HISTORY_DAYS) continue;
    const amount = applyLedgerTransaction(ledger, tx);
    if (Math.abs(amount) > 1e-12) events.push({ date: tx.date, amount });
  }
  return events;
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

// Huidige posities met gemiddelde kostbasis, inclusief kosten en splits.
function computePositions(txs) {
  const ledger = buildPortfolioLedger(txs);
  return ASSETS
    .filter(a => ledger.positions[a.id] && ledger.positions[a.id].qty > 1e-9 && MARKET.prices[a.id])
    .map(a => {
      const { qty, cost, realized } = ledger.positions[a.id];
      const price = lastPrice(a.id);
      const value = qty * price;
      const avgPrice = cost / qty;
      return {
        asset: a, qty, avgPrice, price, value,
        cost, realized,
        gain: value - cost,
        gainPct: cost > 0 ? (value / cost - 1) * 100 : 0,
      };
    })
    .sort((x, y) => y.value - x.value);
}

function totalInvested(txs) {
  return computeCashflowSeries(txs).reduce((sum, amount) => sum + amount, 0);
}

function loadReconciliation() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECONCILIATION_KEY)) || {};
    const assets = {};
    if (parsed.assets && typeof parsed.assets === 'object' && !Array.isArray(parsed.assets)) {
      for (const [rawId, rawQty] of Object.entries(parsed.assets).slice(0, 250)) {
        const id = normalizeAssetId(rawId), qty = Number(rawQty);
        if (id && Number.isFinite(qty) && qty >= 0 && qty < 1e15) assets[id] = qty;
      }
    }
    const cash = parsed.cash === '' || parsed.cash === null || parsed.cash === undefined ? null : Number(parsed.cash);
    const date = parsed.date && Number.isFinite(new Date(parsed.date).getTime()) ? new Date(parsed.date).toISOString() : null;
    return { assets, cash: Number.isFinite(cash) && Math.abs(cash) < 1e15 ? cash : null, date };
  } catch (e) { return { assets: {}, cash: null, date: null }; }
}

function saveReconciliation(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') throw new Error('Reconciliatie ontbreekt.');
  const clean = { assets: {}, cash: null, date: new Date().toISOString() };
  for (const [rawId, rawQty] of Object.entries(snapshot.assets || {}).slice(0, 250)) {
    const id = normalizeAssetId(rawId), qty = Number(rawQty);
    if (!id || !Number.isFinite(qty) || qty < 0 || qty >= 1e15) throw new Error(`Ongeldige referentiehoeveelheid voor ${rawId}.`);
    clean.assets[id] = qty;
  }
  if (snapshot.cash !== '' && snapshot.cash !== null && snapshot.cash !== undefined) {
    const cash = Number(snapshot.cash);
    if (!Number.isFinite(cash) || Math.abs(cash) >= 1e15) throw new Error('Ongeldig referentie-cashsaldo.');
    clean.cash = cash;
  }
  localStorage.setItem(RECONCILIATION_KEY, JSON.stringify(clean));
  return clean;
}

function reconcilePortfolio(txs, snapshot = {}) {
  const ledger = buildPortfolioLedger(txs);
  const actualAssets = {};
  if (snapshot?.assets && typeof snapshot.assets === 'object' && !Array.isArray(snapshot.assets)) {
    for (const [rawId, rawQty] of Object.entries(snapshot.assets)) {
      const id = normalizeAssetId(rawId), qty = Number(rawQty);
      if (id && Number.isFinite(qty) && qty >= 0) actualAssets[id] = qty;
    }
  }
  const ids = new Set([
    ...Object.keys(ledger.positions).filter(id => ledger.positions[id].qty > 1e-9),
    ...Object.keys(actualAssets).map(normalizeAssetId).filter(Boolean),
  ]);
  const rows = [...ids].sort().map(asset => {
    const expected = ledger.positions[asset]?.qty || 0;
    const rawActual = Object.prototype.hasOwnProperty.call(actualAssets, asset) ? Number(actualAssets[asset]) : null;
    const actual = Number.isFinite(rawActual) ? rawActual : null;
    const difference = actual === null ? null : actual - expected;
    const tolerance = Math.max(1e-8, Math.abs(expected) * 1e-8);
    return { asset, expected, actual, difference, balanced: difference !== null && Math.abs(difference) <= tolerance };
  });
  const rawCash = snapshot?.cash;
  const actualCash = rawCash === '' || rawCash === null || rawCash === undefined ? null : Number(rawCash);
  const cash = {
    expected: ledger.cash,
    actual: Number.isFinite(actualCash) ? actualCash : null,
    difference: Number.isFinite(actualCash) ? actualCash - ledger.cash : null,
  };
  cash.balanced = cash.difference !== null && Math.abs(cash.difference) <= 0.01;
  const complete = rows.every(row => row.actual !== null) && cash.actual !== null;
  return {
    rows, cash, complete,
    balanced: complete && rows.every(row => row.balanced) && cash.balanced,
    checkedAt: snapshot?.date || null,
  };
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
