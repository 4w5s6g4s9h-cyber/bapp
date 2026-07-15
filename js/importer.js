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
const BACKUP_SCHEMA_VERSION = 2;
const NETWORK_CONSENT_KEY = 'vermogen_network_consent_v1';
const AUTO_REFRESH_KEY = 'vermogen_auto_refresh_v1';
const PRICE_REFRESH_META_KEY = 'vermogen_price_refresh_meta_v1';
const CRYPTO_AUTO_REFRESH_MS = 60 * 60 * 1000;
const STOCK_AUTO_REFRESH_MS = 24 * 60 * 60 * 1000;
const AUTO_STOCK_BATCH_SIZE = 10;
const MAX_IMPORT_BYTES = 8 * 1024 * 1024;
const MAX_IMPORT_TRANSACTIONS = 25000;
const MAX_IMPORT_ASSETS = 250;

function storageKeys() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key !== null) keys.push(key);
  }
  return keys;
}

/** Past meerdere localStorage-mutaties toe met volledige rollback bij fouten. */
function commitStorage(updates, { clearNamespace = false } = {}) {
  const before = new Map(storageKeys().map(key => [key, localStorage.getItem(key)]));
  try {
    if (clearNamespace) {
      for (const key of storageKeys()) if (key.startsWith('vermogen_')) localStorage.removeItem(key);
    }
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === undefined) localStorage.removeItem(key);
      else localStorage.setItem(key, String(value));
    }
    for (const [key, value] of Object.entries(updates)) {
      if (value !== null && value !== undefined && localStorage.getItem(key) !== String(value)) {
        throw new Error(`Verificatie van opslagkey ${key} mislukt.`);
      }
    }
  } catch (error) {
    for (const key of storageKeys()) if (key.startsWith('vermogen_')) localStorage.removeItem(key);
    for (const [key, value] of before) localStorage.setItem(key, value);
    throw error;
  }
}

function networkConsentEnabled() {
  return localStorage.getItem(NETWORK_CONSENT_KEY) === 'yes';
}

function setNetworkConsent(enabled) {
  localStorage.setItem(NETWORK_CONSENT_KEY, enabled ? 'yes' : 'no');
}

/** Uurverversing is een afzonderlijke opt-in bovenop netwerktoestemming. */
function autoRefreshEnabled() {
  return localStorage.getItem(AUTO_REFRESH_KEY) === 'yes';
}

function setAutoRefreshEnabled(enabled) {
  localStorage.setItem(AUTO_REFRESH_KEY, enabled ? 'yes' : 'no');
}

function validRefreshTimestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

function loadPriceRefreshMeta() {
  let raw = {};
  try { raw = JSON.parse(localStorage.getItem(PRICE_REFRESH_META_KEY)) || {}; }
  catch (e) { raw = {}; }
  return {
    cryptoAttemptAt: validRefreshTimestamp(raw.cryptoAttemptAt),
    cryptoSuccessAt: validRefreshTimestamp(raw.cryptoSuccessAt),
    stockAttemptAt: validRefreshTimestamp(raw.stockAttemptAt),
    stockSuccessAt: validRefreshTimestamp(raw.stockSuccessAt),
    completedAt: validRefreshTimestamp(raw.completedAt),
    lastError: cleanDisplayText(raw.lastError || '', 160),
  };
}

function savePriceRefreshMeta(patch) {
  const current = loadPriceRefreshMeta();
  const next = {
    ...current,
    ...patch,
    lastError: cleanDisplayText(patch?.lastError ?? current.lastError, 160),
  };
  for (const key of ['cryptoAttemptAt', 'cryptoSuccessAt', 'stockAttemptAt', 'stockSuccessAt', 'completedAt']) {
    next[key] = validRefreshTimestamp(next[key]);
  }
  localStorage.setItem(PRICE_REFRESH_META_KEY, JSON.stringify(next));
  return next;
}

function isPriceRefreshDue(lastAttemptAt, intervalMs, now = Date.now()) {
  const last = validRefreshTimestamp(lastAttemptAt);
  const current = validRefreshTimestamp(now);
  if (!last || !current || last > current + 5 * 60 * 1000) return true;
  return current - last >= intervalMs;
}

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
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(s)) return null;
  const n = Number(s);
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
    const day = +m[1], month = +m[2], year = +m[3];
    const d = new Date(year, month - 1, day, 12);
    return isNaN(d) || d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day ? null : d;
  }
  const isoDay = v.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T)/);
  if (isoDay) {
    const year = +isoDay[1], month = +isoDay[2], day = +isoDay[3];
    const check = new Date(year, month - 1, day, 12);
    if (check.getFullYear() !== year || check.getMonth() !== month - 1 || check.getDate() !== day) return null;
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
const F_ISIN = ['isin', 'instrumentid', 'securityid'];
const F_CURRENCY = ['currency', 'valuta', 'quotecurrency', 'koersvaluta'];
const F_VENUE = ['venue', 'exchange', 'beurs', 'market'];
const F_QUOTE_SYMBOL = ['quotesymbol', 'yahoo', 'yahoosymbol', 'marketsymbol'];
const F_SOURCE_ID = ['id', 'transactionid', 'transaction_id', 'orderid', 'order_id'];

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

  const symbol = normalizeAssetId(rawSymbol);
  if (!symbol) return null;
  const sourceId = cleanDisplayText(getField(o, F_SOURCE_ID) || '', 80);
  return {
    date: date.toISOString(), type, qty, price,
    asset: symbol,
    assetName: cleanDisplayText(rawName || symbol, 80) || symbol,
    assetClass,
    currentPrice: parseNum(getField(o, ['currentprice', 'huidigekoers', 'lastprice', 'laatstekoers'])),
    isin: cleanDisplayText(getField(o, F_ISIN) || '', 16).toUpperCase(),
    currency: cleanDisplayText(getField(o, F_CURRENCY) || 'EUR', 8).toUpperCase(),
    venue: cleanDisplayText(getField(o, F_VENUE) || '', 16).toUpperCase(),
    quoteSymbol: cleanDisplayText(getField(o, F_QUOTE_SYMBOL) || '', 32),
    sourceId,
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
  let scannedNodes = 0;

  function visit(node, keyHint, depth = 0) {
    if (node === null || typeof node !== 'object') return;
    if (depth > 64) throw new Error('JSON is te diep genest.');
    if (++scannedNodes > 100000) throw new Error('JSON bevat te veel objecten.');
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
      for (const item of node) visit(item, keyHint, depth + 1);
      return;
    }
    for (const [k, v] of Object.entries(node)) visit(v, k, depth + 1);
  }
  visit(root, '');

  // ook: posities zonder transacties (qty + gemiddelde koopprijs) -> synthetische koop-tx
  if (txs.length === 0) {
    function visitPositions(node, depth = 0) {
      if (node === null || typeof node !== 'object') return;
      if (depth > 64) return;
      if (Array.isArray(node)) {
        for (const o of node) {
          if (typeof o !== 'object' || o === null) continue;
          const sym = getField(o, F_SYMBOL);
          const qty = parseNum(getField(o, F_QTY));
          const avg = parseNum(getField(o, ['avgprice', 'averageprice', 'gak', 'costbasis', 'avgcost', 'gemiddeldekoers', 'aankoopkoers']));
          const asset = normalizeAssetId(sym);
          if (asset && qty && avg && qty > 0 && avg > 0) {
            const d = parseDateFlexible(getField(o, ['purchasedate', 'aankoopdatum', 'since', 'firstbuy'])) || new Date(Date.now() - 365 * 86400000);
            txs.push({
              date: d.toISOString(), type: 'buy', qty, price: avg,
              asset,
              assetName: cleanDisplayText(getField(o, F_NAME) || sym, 80),
              isin: cleanDisplayText(getField(o, F_ISIN) || '', 16).toUpperCase(),
              currency: cleanDisplayText(getField(o, F_CURRENCY) || 'EUR', 8).toUpperCase(),
              venue: cleanDisplayText(getField(o, F_VENUE) || '', 16).toUpperCase(),
            });
          }
        }
        node.forEach(item => visitPositions(item, depth + 1));
        return;
      }
      Object.values(node).forEach(value => visitPositions(value, depth + 1));
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

/** Echte brondekking: directe punten en forward-fill tussen eerste/laatste bronpunt. */
function provenanceFromPoints(points) {
  const provenance = new Array(HISTORY_DAYS).fill(false);
  if (!points.length) return provenance;
  const indices = points.map(p => p.idx).filter(i => Number.isInteger(i)).sort((a, b) => a - b);
  if (!indices.length) return provenance;
  const first = Math.max(0, indices[0]), last = Math.min(HISTORY_DAYS - 1, indices[indices.length - 1]);
  for (let i = first; i <= last; i++) provenance[i] = true;
  return provenance;
}

function stableTransactionId(tx, index = 0) {
  if (tx.sourceId) return `src-${cleanDisplayText(tx.sourceId, 72).replace(/[^A-Za-z0-9._-]/g, '-')}`;
  const raw = [tx.date, tx.type, tx.asset, Number(tx.qty).toPrecision(12), Number(tx.price).toPrecision(12)].join('|');
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i++) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `imp-${(hash >>> 0).toString(16)}-${index}`;
}

/** Synthetiseert historie rond bekende (transactie)prijspunten. */
function synthesizeHistory(points, symbol, volGuess) {
  const seed = [...symbol].reduce((s, c) => s * 31 + c.charCodeAt(0), 7) >>> 0;
  const rng = mulberry32(seed);
  const gauss = gaussianFactory(rng);
  const dVol = volGuess / Math.sqrt(CALENDAR_DAYS_PER_YEAR);
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

function normalizeBackupTransaction(tx, index) {
  if (!tx || typeof tx !== 'object') throw new Error(`Ongeldige transactie op positie ${index + 1}.`);
  const date = parseDateFlexible(tx.date);
  const asset = normalizeAssetId(tx.asset);
  const qty = Number(tx.qty), price = Number(tx.price);
  if (!date || !asset || !['buy', 'sell'].includes(tx.type) || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price < 0) {
    throw new Error(`Ongeldige transactie op positie ${index + 1}.`);
  }
  const normalized = {
    id: cleanDisplayText(tx.id || stableTransactionId({ ...tx, asset }, index), 100),
    date: date.toISOString(), type: tx.type, asset, qty, price,
  };
  if (tx.dca && typeof tx.dca === 'object') {
    normalized.dca = { plan: cleanDisplayText(tx.dca.plan || '', 80), mult: Number(tx.dca.mult) || 1 };
  }
  if (tx.transfer === true) normalized.transfer = true;
  return normalized;
}

function restoreBackup(root) {
  if (root?.schemaVersion !== BACKUP_SCHEMA_VERSION || root?.meta?.kind !== 'vermogen-backup' || !root.state) return null;
  const state = root.state;
  if (!Array.isArray(state.transactions) || !Array.isArray(state.assets) || typeof state.prices !== 'object') {
    throw new Error('Backupstructuur is incompleet.');
  }
  if (state.transactions.length > MAX_IMPORT_TRANSACTIONS || state.assets.length > MAX_IMPORT_ASSETS) {
    throw new Error('Backup overschrijdt de veilige importlimieten.');
  }
  const assets = state.assets.map((asset, index) => {
    const id = normalizeAssetId(asset.id);
    const prices = normalizePriceSeries(state.prices[id]);
    if (!id || !prices) throw new Error(`Ongeldige asset of koersreeks op positie ${index + 1}.`);
    return {
      ...asset, id,
      name: cleanDisplayText(asset.name || id, 80) || id,
      color: safeColor(asset.color, CUSTOM_COLORS[index % CUSTOM_COLORS.length]),
      type: ['Crypto', 'ETF', 'Aandeel'].includes(asset.type) ? asset.type : 'Aandeel',
      custom: true,
    };
  });
  const assetIds = new Set(assets.map(a => a.id));
  if (assetIds.size !== assets.length) throw new Error('Backup bevat dubbele asset-id’s.');
  const transactions = state.transactions.map(normalizeBackupTransaction);
  if (transactions.some(tx => !assetIds.has(tx.asset))) throw new Error('Backup bevat transacties zonder assetdefinitie.');
  const transactionIds = new Set(transactions.map(tx => tx.id));
  if (transactionIds.size !== transactions.length) throw new Error('Backup bevat dubbele transactie-id’s.');

  const prices = {}, provenance = {};
  for (const asset of assets) {
    prices[asset.id] = normalizePriceSeries(state.prices[asset.id]).map(p => +p.toPrecision(10));
    const sourceFlags = state.provenance?.[asset.id];
    if (!Array.isArray(sourceFlags) || sourceFlags.length !== HISTORY_DAYS || !sourceFlags.every(value => typeof value === 'boolean')) {
      throw new Error(`Backup mist geldige koersherkomst voor ${asset.id}.`);
    }
    provenance[asset.id] = normalizeProvenance(sourceFlags);
  }
  const report = {
    txCount: transactions.length,
    assetCount: assets.length,
    symbols: assets.map(a => a.id),
    histMatched: assets.filter(a => a.histSource !== 'synth').length,
    synthesized: assets.filter(a => a.histSource === 'synth').length,
    restoredBackup: true,
    date: new Date().toISOString(),
  };
  const updates = {
    [CUSTOM_KEY]: JSON.stringify({ schemaVersion: BACKUP_SCHEMA_VERSION, assets, prices, provenance, report }),
    [MODE_KEY]: 'import',
    [TX_KEY]: JSON.stringify(transactions),
    vermogen_watchlist_v1: JSON.stringify(Array.isArray(state.watchlist) ? state.watchlist.map(normalizeAssetId).filter(id => id && assetIds.has(id)) : []),
    vermogen_alerts_v1: JSON.stringify(Array.isArray(state.alerts) ? state.alerts : []),
    vermogen_dca_v1: JSON.stringify(Array.isArray(state.dcaPlans) ? state.dcaPlans : []),
    vermogen_watchassets_v1: JSON.stringify(Array.isArray(state.watchAssets) ? state.watchAssets : []),
    vermogen_livehist_v1: JSON.stringify(state.liveHistory && typeof state.liveHistory === 'object' ? state.liveHistory : {}),
    vermogen_yahoo_v1: JSON.stringify(state.yahooMap && typeof state.yahooMap === 'object' ? state.yahooMap : {}),
    [NETWORK_CONSENT_KEY]: 'no',
  };
  commitStorage(updates, { clearNamespace: true });
  return { ok: true, txs: transactions, report };
}

/** Voert een generieke portfolio-import of een volledige backuprestore uit. */
function importPortfolioJSON(jsonText) {
  if (typeof jsonText !== 'string' || jsonText.length > MAX_IMPORT_BYTES) {
    return { ok: false, error: 'Importbestand is groter dan de veilige limiet van 8 MB.' };
  }
  let root;
  try { root = JSON.parse(jsonText); }
  catch (e) { return { ok: false, error: 'Het bestand is geen geldige JSON: ' + e.message }; }

  try {
    const restored = restoreBackup(root);
    if (restored) return restored;
  } catch (e) {
    return { ok: false, error: 'Backup herstellen mislukt: ' + e.message };
  }

  let txs, histories;
  try { ({ txs, histories } = scanJSON(root)); }
  catch (e) { return { ok: false, error: 'Importstructuur afgewezen: ' + e.message }; }
  if (!txs.length) {
    return { ok: false, error: 'Geen transacties of posities herkend in dit bestand. Verwacht: een array met datum, aantal, koers/bedrag en ticker.' };
  }
  if (txs.length > MAX_IMPORT_TRANSACTIONS) return { ok: false, error: `Te veel transacties; maximum is ${MAX_IMPORT_TRANSACTIONS}.` };

  const symbols = [...new Set(txs.map(t => t.asset).filter(Boolean))];
  if (symbols.length > MAX_IMPORT_ASSETS) return { ok: false, error: `Te veel assets; maximum is ${MAX_IMPORT_ASSETS}.` };
  const customAssets = [], customPrices = {}, customProvenance = {};
  let histMatched = 0, synthesized = 0;
  const snapshotIdx = Math.max(...txs.map(t => dateToIndex(t.date)));

  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    const symTxs = txs.filter(t => t.asset === sym);
    const name = cleanDisplayText(symTxs[0]?.assetName || sym, 80) || sym;
    const type = symTxs.find(t => t.assetClass)?.assetClass || guessType(sym, name);
    const existing = assetById(sym);
    const color = existing ? safeColor(existing.color) : CUSTOM_COLORS[i % CUSTOM_COLORS.length];

    let grid = null;
    let provenance = new Array(HISTORY_DAYS).fill(false);
    const histKey = Object.keys(histories).find(k => k === sym || k.startsWith(sym) || sym.startsWith(k));
    if (histKey && histories[histKey].length >= 20) {
      grid = historyToGrid(histories[histKey]);
      if (grid) {
        provenance = provenanceFromPoints(histories[histKey]);
        histMatched++;
      }
    }
    if (!grid) {
      const anchors = symTxs.filter(t => t.price > 0)
        .map(t => ({ idx: dateToIndex(t.date), price: t.price }))
        .sort((a, b) => a.idx - b.idx);
      const withCur = [...symTxs].reverse().find(t => t.currentPrice && t.currentPrice > 0);
      if (withCur) {
        const filtered = anchors.filter(a => a.idx < snapshotIdx);
        filtered.push({ idx: snapshotIdx, price: withCur.currentPrice });
        grid = synthesizeHistory(filtered, sym, volForType(type));
      } else grid = synthesizeHistory(anchors, sym, volForType(type));
      synthesized++;
    }

    const metadata = symTxs.find(t => t.isin || t.currency || t.venue || t.quoteSymbol) || {};
    const histSource = provenance.some(Boolean) ? 'import' : 'synth';
    const asset = {
      ...(existing || {}), id: sym, name, type, start: grid[0], drift: 0.08,
      vol: volForType(type), seed: existing?.seed || 1, color, custom: true, histSource,
      isin: metadata.isin || existing?.isin || '', currency: metadata.currency || existing?.currency || 'EUR',
      venue: metadata.venue || existing?.venue || '', yahoo: metadata.quoteSymbol || existing?.yahoo || '',
    };
    registerAsset(asset, grid, provenance);
    customAssets.push({ ...assetById(sym) });
    customPrices[sym] = grid.map(p => +p.toPrecision(10));
    customProvenance[sym] = provenance;
  }

  const usedTransactionIds = new Set();
  const cleanTxs = txs.map((t, i) => {
    const baseId = stableTransactionId(t, i);
    let id = baseId, suffix = 1;
    while (usedTransactionIds.has(id)) id = `${baseId}-${suffix++}`;
    usedTransactionIds.add(id);
    return { id, date: t.date, type: t.type, asset: t.asset, qty: t.qty, price: t.price };
  }).sort((a, b) => new Date(a.date) - new Date(b.date));
  const report = {
    txCount: cleanTxs.length, assetCount: symbols.length, symbols,
    histMatched, synthesized, restoredBackup: false, date: new Date().toISOString(),
  };
  try {
    commitStorage({
      [CUSTOM_KEY]: JSON.stringify({ schemaVersion: BACKUP_SCHEMA_VERSION, assets: customAssets, prices: customPrices, provenance: customProvenance, report }),
      [MODE_KEY]: 'import',
      [TX_KEY]: JSON.stringify(cleanTxs),
    });
  } catch (e) {
    return { ok: false, error: 'Opslaan mislukt; de vorige data is hersteld. ' + e.message };
  }
  return { ok: true, txs: cleanTxs, report };
}

/** Laadt eerder geïmporteerde data en herstelt legacy-state zonder assetdefinities. */
function loadCustomData() {
  if (localStorage.getItem(MODE_KEY) !== 'import') return null;
  try {
    const data = JSON.parse(localStorage.getItem(CUSTOM_KEY));
    if (!data || typeof data.prices !== 'object') return null;
    const definitions = new Map((data.assets || []).map(asset => [normalizeAssetId(asset.id), asset]));
    for (const [rawId, prices] of Object.entries(data.prices)) {
      const id = normalizeAssetId(rawId);
      if (!id) continue;
      const asset = definitions.get(id) || {
        id, name: id, type: guessType(id, id), color: CUSTOM_COLORS[ASSETS.length % CUSTOM_COLORS.length],
        custom: true, histSource: data.provenance?.[id]?.some(Boolean) ? 'import' : 'synth',
      };
      registerAsset(asset, prices, data.provenance?.[id]);
    }
    return data.report || null;
  } catch (e) {
    console.error('Opgeslagen portfoliodata is ongeldig:', e);
    return { error: 'Opgeslagen portfoliodata is beschadigd; importeer een backup om te herstellen.' };
  }
}

/** Wist álle app-data (transacties, assets, watchlist, alerts, historie). */
function clearAllData() {
  for (const key of storageKeys()) if (key.startsWith('vermogen_')) localStorage.removeItem(key);
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

function coinGeckoIdForAsset(asset) {
  if (!asset || asset.type !== 'Crypto') return '';
  return normalizeCoinGeckoId(asset.cg) || normalizeCoinGeckoId(COINGECKO_IDS[asset.id]);
}

function cryptoPriceTargets() {
  return ASSETS
    .map(asset => ({ asset, cgId: coinGeckoIdForAsset(asset) }))
    .filter(target => target.cgId && MARKET.prices[target.asset.id]);
}

async function fetchLivePrices() {
  if (!networkConsentEnabled()) return null;
  const wanted = cryptoPriceTargets();
  if (!wanted.length) return null;
  const ids = [...new Set(wanted.map(target => target.cgId))].join(',');
  let timer = null;
  try {
    const ctrl = new AbortController();
    timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=eur&include_last_updated_at=true`, {
      signal: ctrl.signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    clearTimeout(timer);
    timer = null;
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const now = Date.now();
    const store = loadLiveHistory();
    const pending = [];
    for (const { asset, cgId } of wanted) {
      const eur = Number(data[cgId]?.eur);
      if (!Number.isFinite(eur) || eur <= 0 || eur >= 1e12) continue;
      const providerAt = Number(data[cgId]?.last_updated_at) * 1000;
      const quoteAt = Number.isFinite(providerAt) && providerAt > 0 && providerAt <= now + 5 * 60 * 1000 ? providerAt : now;
      const current = store[asset.id] && typeof store[asset.id] === 'object' ? store[asset.id] : {};
      const spotOnly = current.spotOnly === true || !Array.isArray(current.points) || current.points.length <= 1;
      const compact = new Map((Array.isArray(current.points) ? current.points : [])
        .filter(point => Array.isArray(point) && Number.isInteger(Number(point[0]))
          && Number(point[0]) >= 0 && Number(point[0]) < HISTORY_DAYS
          && Number.isFinite(Number(point[1])) && Number(point[1]) > 0)
        .map(([idx, price]) => [Number(idx), Number(price)]));
      compact.set(HISTORY_DAYS - 1, +eur.toPrecision(10));
      store[asset.id] = {
        ...current,
        at: now,
        quoteAt,
        points: [...compact.entries()].sort((a, b) => a[0] - b[0]).slice(-2000),
        src: 'coingecko',
        cg: cgId,
        ...(spotOnly ? { spotOnly: true } : {}),
      };
      pending.push({ asset, cgId, eur });
    }
    if (!pending.length) return null;
    commitStorage({ [LIVEHIST_KEY]: JSON.stringify(store) });
    for (const { asset, cgId, eur } of pending) {
      asset.cg = cgId;
      // Alleen "vandaag" bijwerken; de historie blijft intact.
      MARKET.prices[asset.id][HISTORY_DAYS - 1] = eur;
      if (!MARKET.provenance[asset.id]) MARKET.provenance[asset.id] = new Array(HISTORY_DAYS).fill(false);
      MARKET.provenance[asset.id][HISTORY_DAYS - 1] = true;
    }
    return pending.map(item => item.asset.id);
  } catch (e) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ============================================================
   Echte koershistorie (CoinGecko, maximaal 1.095 dagen) + export
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
  if (!idxs.length) return false;
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
  if (!MARKET.provenance[assetId]) MARKET.provenance[assetId] = new Array(HISTORY_DAYS).fill(false);
  for (let i = first; i <= last; i++) MARKET.provenance[assetId][i] = true;
  return true;
}

/**
 * Haalt maximaal het volledige analysegrid op voor crypto-assets (CoinGecko),
 * sequentieel met pauze i.v.m. rate limits. onProgress(done, total, id).
 */
async function fetchLiveHistory(onProgress) {
  if (!networkConsentEnabled()) return { ok: false, error: 'Externe koersdata staat uit.', updated: [] };
  const wanted = cryptoPriceTargets();
  if (!wanted.length) return { ok: false, error: 'Geen crypto-assets met een bekende CoinGecko-koppeling.' };
  const store = loadLiveHistory();
  const updated = [];
  for (let i = 0; i < wanted.length; i++) {
    const { asset: a, cgId } = wanted[i];
    if (onProgress) onProgress(i, wanted.length, a.id);
    let timer = null;
    try {
      const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(cgId)}/market_chart?vs_currency=eur&days=${HISTORY_DAYS}&interval=daily`;
      const ctrl = new AbortController();
      timer = setTimeout(() => ctrl.abort(), 12000);
      const res = await fetch(url, { signal: ctrl.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
      clearTimeout(timer);
      timer = null;
      if (res.status === 429) continue;
      if (!res.ok) continue;
      const data = await res.json();
      if (Array.isArray(data.prices) && data.prices.length > 30 && data.prices.length <= 2000) {
        // compact opslaan: [dagindex, koers]
        const compact = data.prices
          .filter(point => Array.isArray(point) && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1])) && Number(point[1]) > 0)
          .map(([ts, p]) => [dateToIndex(new Date(Number(ts)).toISOString()), +Number(p).toPrecision(6)]);
        const dedup = new Map(compact);
        if (dedup.size > 30) {
          const sourceAt = Math.max(...data.prices.map(point => Number(point?.[0])).filter(Number.isFinite));
          store[a.id] = {
            at: Date.now(),
            quoteAt: Number.isFinite(sourceAt) ? sourceAt : Date.now(),
            points: [...dedup.entries()],
            src: 'coingecko',
            cg: cgId,
          };
          a.cg = cgId;
          updated.push(a.id);
        }
      }
    } catch (e) { /* netwerk: overslaan */ }
    finally { if (timer) clearTimeout(timer); }
    if (i < wanted.length - 1) await new Promise(r => setTimeout(r, 1500));
  }
  try { commitStorage({ [LIVEHIST_KEY]: JSON.stringify(store) }); }
  catch (e) { return { ok: false, error: 'Opslaan van koersdata mislukt.', updated: [] }; }
  applyLiveHistory();
  if (onProgress) onProgress(wanted.length, wanted.length, null);
  return { ok: updated.length > 0, updated };
}

/** Past opgeslagen echte historie toe op de reeksen in het geheugen. */
function applyLiveHistory() {
  const store = loadLiveHistory();
  for (const [id, entry] of Object.entries(store)) {
    if (!MARKET.prices[id] || !entry || !Array.isArray(entry.points)) continue;
    if (entry.spotOnly === true) {
      for (const point of entry.points.slice(-10)) {
        const idx = Number(point?.[0]), price = Number(point?.[1]);
        if (!Number.isInteger(idx) || idx < 0 || idx >= HISTORY_DAYS || !Number.isFinite(price) || price <= 0) continue;
        MARKET.prices[id][idx] = price;
        if (!MARKET.provenance[id]) MARKET.provenance[id] = new Array(HISTORY_DAYS).fill(false);
        MARKET.provenance[id][idx] = true;
      }
      const asset = assetById(id);
      if (asset) {
        if (asset.type === 'Crypto' && entry.cg) asset.cg = normalizeCoinGeckoId(entry.cg) || asset.cg;
        if (asset.histSource === 'synth') asset.histSource = 'live';
      }
      continue;
    }
    const points = entry.points
      .filter(point => Array.isArray(point) && Number.isInteger(Number(point[0])) && Number.isFinite(Number(point[1])) && Number(point[1]) > 0)
      .slice(0, 2000)
      .map(([idx, p]) => [MARKET.dates[Math.max(0, Math.min(HISTORY_DAYS - 1, Number(idx)))].getTime(), Number(p)]);
    if (!points.length) continue;
    mergeRealHistory(id, points);
    const a = assetById(id);
    if (a) {
      a.histSource = ['yahoo', 'alpha'].includes(entry.src) ? entry.src : 'live';
      if (a.type === 'Crypto' && entry.cg) a.cg = normalizeCoinGeckoId(entry.cg) || a.cg;
    }
  }
}

/** Status van de koershistorie per asset (voor de instellingen-pagina). */
function historyStatus(asset) {
  const coverage = marketCoverage(asset.id);
  const pct = Math.round(coverage * 100);
  if (asset.histSource === 'live') return { label: `CoinGecko · ${pct}% echt`, cls: coverage >= ANALYSIS_MIN_COVERAGE ? 'up' : 'muted' };
  if (asset.histSource === 'yahoo') return { label: `Yahoo · ${pct}% echt`, cls: coverage >= ANALYSIS_MIN_COVERAGE ? 'up' : 'muted' };
  if (asset.histSource === 'alpha') return { label: `Alpha Vantage · ${pct}% echt`, cls: coverage >= ANALYSIS_MIN_COVERAGE ? 'up' : 'muted' };
  if (asset.histSource === 'import') return { label: `import · ${pct}% echt`, cls: coverage >= ANALYSIS_MIN_COVERAGE ? 'up' : 'muted' };
  return { label: `gereconstrueerd · ${pct}% echt`, cls: 'muted' };
}

/** Oudste aandelen/ETF's eerst, begrensd om gratis providerquota te sparen. */
function autoStockRefreshIds(now = Date.now(), limit = AUTO_STOCK_BATCH_SIZE) {
  const current = validRefreshTimestamp(now) || Date.now();
  const max = Math.max(1, Math.min(25, Math.trunc(Number(limit)) || AUTO_STOCK_BATCH_SIZE));
  const store = loadLiveHistory();
  return ASSETS
    .filter(asset => asset.type !== 'Crypto' && MARKET.prices[asset.id])
    .map(asset => ({ id: asset.id, at: validRefreshTimestamp(store[asset.id]?.at) }))
    .filter(item => !item.at || current - item.at >= STOCK_AUTO_REFRESH_MS || item.at > current + 5 * 60 * 1000)
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
    .slice(0, max)
    .map(item => item.id);
}

/** Exporteert alle data als downloadbare JSON (zelfde formaat als import). */
function exportBackup(txs) {
  const assets = ASSETS.map(a => ({ ...a }));
  const prices = Object.fromEntries(ASSETS.map(a => [a.id, MARKET.prices[a.id].map(p => +p.toPrecision(10))]));
  const provenance = Object.fromEntries(ASSETS.map(a => [a.id, normalizeProvenance(MARKET.provenance[a.id])]));
  const payload = {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    meta: { app: 'Vermogen', kind: 'vermogen-backup', exportedAt: new Date().toISOString(), note: 'Volledige lokale backup' },
    state: {
      transactions: txs,
      assets,
      prices,
      provenance,
      watchlist: JSON.parse(localStorage.getItem('vermogen_watchlist_v1') || '[]'),
      alerts: loadAlerts().map(({ value, triggered, ...rule }) => rule),
      dcaPlans: JSON.parse(localStorage.getItem('vermogen_dca_v1') || '[]'),
      watchAssets: JSON.parse(localStorage.getItem('vermogen_watchassets_v1') || '[]'),
      liveHistory: loadLiveHistory(),
      yahooMap: JSON.parse(localStorage.getItem('vermogen_yahoo_v1') || '{}'),
    },
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
   Aandelen/ETF-koershistorie. Zonder eigen sleutel wordt Yahoo rechtstreeks
   geprobeerd. Met een Alpha Vantage-sleutel krijgt die CORS-vriendelijke
   browserroute voorrang en blijft Yahoo de beste-effort fallback.
   Generieke publieke CORS-proxy's blijven bewust uitgesloten.
   ============================================================ */
const YAHOO_MAP_KEY = 'vermogen_yahoo_v1'; // gevonden symbolen cachen
const ALPHA_VANTAGE_KEY = 'vermogen_alpha_vantage_key_v1';

function alphaVantageApiKey() {
  const key = String(localStorage.getItem(ALPHA_VANTAGE_KEY) || '').trim();
  return /^[A-Za-z0-9]{8,64}$/.test(key) ? key : '';
}

/** Bewaart een eigen API-sleutel alleen lokaal; een lege waarde wist hem. */
function setAlphaVantageApiKey(value) {
  const key = String(value || '').trim();
  if (!key) {
    try { localStorage.removeItem(ALPHA_VANTAGE_KEY); return true; }
    catch (e) { return false; }
  }
  if (!/^[A-Za-z0-9]{8,64}$/.test(key)) return false;
  try {
    localStorage.setItem(ALPHA_VANTAGE_KEY, key);
    return localStorage.getItem(ALPHA_VANTAGE_KEY) === key;
  } catch (e) { return false; }
}

async function fetchJSONDirect(url, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') || '';
    if (type && !/json|javascript|text\/plain/i.test(type)) return null;
    return await res.json();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** EUR-koersen per dagindex voor een vreemde valuta (forward-filled). */
async function fxToEurSeries(currency) {
  if (currency === 'EUR') return null;
  if (!/^[A-Z]{3}$/.test(currency)) return null;
  const from = MARKET.dates[0].toISOString().slice(0, 10);
  const to = MARKET.dates[HISTORY_DAYS - 1].toISOString().slice(0, 10);
  try {
    const res = await fetch(`https://api.frankfurter.dev/v1/${from}..${to}?base=${currency}&symbols=EUR`);
    if (!res.ok) return null;
    const data = await res.json();
    const series = new Array(HISTORY_DAYS).fill(null);
    for (const [date, rates] of Object.entries(data.rates || {})) {
      const rate = Number(rates.EUR);
      if (Number.isFinite(rate) && rate > 0 && rate < 1000) series[dateToIndex(date)] = rate;
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
  const id = normalizeAssetId(ticker);
  if (!id) return [];
  return [id, `${id}.DE`, `${id}.AS`, `${id}.MI`, `${id}.PA`, `${id}.L`];
}

async function fetchYahooChart(symbol) {
  if (!networkConsentEnabled() || typeof symbol !== 'string' || symbol.length > 32) return null;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=3y&interval=1d`;
  const data = await fetchJSONDirect(url);
  const r = data?.chart?.result?.[0];
  if (!r || !Array.isArray(r.timestamp) || !Array.isArray(r.indicators?.quote?.[0]?.close)) return null;
  const closes = r.indicators.quote[0].close;
  if (r.timestamp.length !== closes.length || r.timestamp.length > 2000) return null;
  const points = [];
  let previousTs = 0;
  for (let i = 0; i < r.timestamp.length; i++) {
    const ts = Number(r.timestamp[i]) * 1000, close = Number(closes[i]);
    if (!Number.isFinite(ts) || ts <= previousTs) return null;
    previousTs = ts;
    if (Number.isFinite(close) && close > 0 && close < 1e9) points.push([ts, close]);
  }
  const currency = cleanDisplayText(r.meta?.currency || '', 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return null;
  const name = cleanDisplayText(r.meta?.shortName || r.meta?.longName || symbol, 80);
  if (!points.length) return null;
  const quotePrice = Number(r.meta?.regularMarketPrice);
  const rawQuoteAt = Number(r.meta?.regularMarketTime) * 1000;
  const quoteAt = Number.isFinite(rawQuoteAt) && rawQuoteAt > 0 && rawQuoteAt <= Date.now() + 2 * 86400000
    ? rawQuoteAt
    : points.at(-1)[0];
  // Ook een pas genoteerd instrument kan geldige koersdata hebben, maar nog
  // geen 30 handelsdagen historie. De analyselaag bewaakt zelf de minimale
  // dekking; voor toevoegen aan de watchlist is een geldige slotkoers genoeg.
  return {
    points,
    currency,
    name,
    source: 'yahoo',
    quotePrice: Number.isFinite(quotePrice) && quotePrice > 0 && quotePrice < 1e9 ? quotePrice : null,
    quoteAt,
  };
}

/** Zet veelgebruikte Yahoo-beurssuffixen om naar Alpha Vantage-symbolen. */
function alphaVantageSymbol(symbol) {
  const clean = cleanDisplayText(symbol || '', 32).toUpperCase();
  const suffixes = { '.AS': '.AMS', '.DE': '.DEX', '.MI': '.MIL', '.PA': '.PAR', '.L': '.LON' };
  for (const [from, to] of Object.entries(suffixes)) {
    if (clean.endsWith(from)) return clean.slice(0, -from.length) + to;
  }
  return clean;
}

function inferredAlphaCurrency(symbol) {
  if (/\.(?:AMS|DEX|MIL|PAR)$/.test(symbol)) return 'EUR';
  if (!symbol.includes('.')) return 'USD';
  return null; // onbekende beurs; eerst metadata opvragen (o.a. GBP versus GBX)
}

/** Maximaal 100 recente dagkoersen via de gratis Alpha Vantage-fallback. */
async function fetchAlphaVantageChart(symbol) {
  const key = alphaVantageApiKey();
  const requested = alphaVantageSymbol(symbol);
  if (!networkConsentEnabled() || !key || !/^[A-Z0-9.-]{1,32}$/.test(requested)) return null;

  let resolved = requested;
  let currency = inferredAlphaCurrency(resolved);
  let name = cleanDisplayText(symbol, 80) || symbol;
  if (!currency) {
    const searchUrl = `https://www.alphavantage.co/query?function=SYMBOL_SEARCH&keywords=${encodeURIComponent(requested)}&apikey=${encodeURIComponent(key)}`;
    const search = await fetchJSONDirect(searchUrl, 12000);
    const matches = Array.isArray(search?.bestMatches) ? search.bestMatches : [];
    const exact = matches.find(match => cleanDisplayText(match?.['1. symbol'] || '', 32).toUpperCase() === requested);
    resolved = cleanDisplayText(exact?.['1. symbol'] || requested, 32).toUpperCase();
    currency = cleanDisplayText(exact?.['8. currency'] || '', 3).toUpperCase();
    name = cleanDisplayText(exact?.['2. name'] || symbol, 80) || symbol;
    // Gratis sleutels staan maximaal één request per seconde toe.
    if (currency) await new Promise(resolve => setTimeout(resolve, 1100));
  }
  if (!resolved || !currency || !/^[A-Z]{3}$/.test(currency)) return null;

  const seriesUrl = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(resolved)}&outputsize=compact&apikey=${encodeURIComponent(key)}`;
  const data = await fetchJSONDirect(seriesUrl, 12000);
  const series = data?.['Time Series (Daily)'];
  if (!series || typeof series !== 'object' || Array.isArray(series)) return null;
  let priceScale = 1;
  if (currency === 'GBX') { currency = 'GBP'; priceScale = 0.01; }
  const points = Object.entries(series)
    .slice(0, 100)
    .map(([date, row]) => {
      const ts = /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T12:00:00Z`) : NaN;
      const close = Number(row?.['4. close']) * priceScale;
      return [ts, close];
    })
    .filter(([ts, close]) => Number.isFinite(ts) && ts <= Date.now() + 2 * 86400000
      && Number.isFinite(close) && close > 0 && close < 1e9)
    .sort((a, b) => a[0] - b[0]);
  return points.length ? { points, currency, name, source: 'alpha', quoteAt: points.at(-1)[0] } : null;
}

/**
 * Haalt echte historie op voor aandelen/ETF's — beste-effort:
 * gebruikt met sleutel eerst Alpha Vantage en probeert anders Yahoo-beurzen.
 */
async function fetchStockHistory(onProgress, assetIds = null) {
  const selected = Array.isArray(assetIds)
    ? new Set(assetIds.map(normalizeAssetId).filter(Boolean))
    : null;
  const wanted = ASSETS.filter(a => a.type !== 'Crypto' && (!selected || selected.has(a.id)));
  if (!networkConsentEnabled()) return { ok: false, updated: [], failed: wanted.map(a => a.id), error: 'Externe koersdata staat uit.' };
  if (!wanted.length) return { ok: false, updated: [], failed: [] };
  let symMap;
  try { symMap = JSON.parse(localStorage.getItem(YAHOO_MAP_KEY)) || {}; } catch (e) { symMap = {}; }
  const store = loadLiveHistory();
  const fxCache = {};
  const updated = [], failed = [];

  for (let i = 0; i < wanted.length; i++) {
    const a = wanted[i];
    if (onProgress) onProgress(i, wanted.length, a.id);
    const preferred = a.yahoo || symMap[a.id];
    const candidates = [...new Set(preferred ? [preferred, ...yahooCandidates(a.id)] : yahooCandidates(a.id))];
    let gotSym = preferred || a.id;
    let got = await fetchAlphaVantageChart(gotSym);
    if (!got) {
      for (const sym of candidates) {
        got = await fetchYahooChart(sym);
        if (got) { gotSym = sym; break; }
      }
    }
    if (!got) { failed.push(a.id); continue; }
    symMap[a.id] = gotSym;

    let points = [...got.points];
    if (Number.isFinite(got.quotePrice) && Number.isFinite(got.quoteAt)) {
      points.push([got.quoteAt, got.quotePrice]);
    }
    const sourceAt = validRefreshTimestamp(got.quoteAt)
      || Math.max(...points.map(([ts]) => Number(ts)).filter(Number.isFinite));
    if (got.currency !== 'EUR') {
      if (!(got.currency in fxCache)) fxCache[got.currency] = await fxToEurSeries(got.currency);
      const fx = fxCache[got.currency];
      if (!fx) { failed.push(a.id); continue; }
      points = points.map(([ts, p]) => [ts, p * fx[dateToIndex(new Date(ts).toISOString())]]);
    }
    const compact = new Map(points.map(([ts, p]) => [dateToIndex(new Date(ts).toISOString()), +p.toPrecision(6)]));
    store[a.id] = {
      at: Date.now(),
      quoteAt: Number.isFinite(sourceAt) ? sourceAt : Date.now(),
      points: [...compact.entries()],
      src: got.source || 'yahoo',
    };
    updated.push(a.id);
    await new Promise(r => setTimeout(r, got.source === 'alpha' ? 1100 : 400));
  }
  try { commitStorage({ [YAHOO_MAP_KEY]: JSON.stringify(symMap), [LIVEHIST_KEY]: JSON.stringify(store) }); }
  catch (e) { return { ok: false, updated: [], failed: wanted.map(a => a.id), error: 'Opslaan van koersdata mislukt.' }; }
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
    const parsedDate = parseDateFlexible(o['Datum']);
    if (!parsedDate) continue;
    const dag = `${parsedDate.getFullYear()}-${String(parsedDate.getMonth() + 1).padStart(2, '0')}-${String(parsedDate.getDate()).padStart(2, '0')}`;
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
    const parsedDate = parseDateFlexible(o['Date']);
    if (!parsedDate) continue;
    const isTransfer = type === 'deposit' || type === 'withdrawal';
    if (!isTransfer && !['buy', 'sell', 'staking', 'fixed_staking', 'manually_assigned'].includes(type)) continue;
    const amt = parseNum(o['Amount']);
    if (!amt) continue;
    const price = parseNum(o['Quote Price']) || 0;
    if (isTransfer) transfers++;
    txs.push({
      id: o['Transaction ID'] ? `bv-${o['Transaction ID']}` : `bv-${o['Date']}-${cur}-${amt}`,
      day: `${parsedDate.getFullYear()}-${String(parsedDate.getMonth() + 1).padStart(2, '0')}-${String(parsedDate.getDate()).padStart(2, '0')}`,
      date: parsedDate.toISOString(),
      type: isTransfer ? (type === 'withdrawal' ? 'sell' : 'buy') : (amt < 0 ? 'sell' : 'buy'),
      asset: normalizeAssetId(cur),
      assetName: cleanDisplayText(cur, 12).toUpperCase(),
      qty: Math.abs(amt),
      price, // staking/rewards hebben prijs 0: aantal telt, kostprijs nul
      transfer: isTransfer,
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
  if (parsed.txs.length > MAX_IMPORT_TRANSACTIONS) return { ok: false, error: `Te veel transacties; maximum is ${MAX_IMPORT_TRANSACTIONS}.` };

  // Dedupe primair op broker-id; zonder betrouwbare id op de volledige
  // economische rij. Twee orders met hetzelfde aantal op dezelfde dag
  // blijven zo bestaan wanneer prijs of richting verschilt.
  const keys = new Set(), ids = new Set();
  const txKey = t => [
    t.asset, String(t.date || t.day).slice(0, 10), t.type,
    Math.abs(Number(t.qty)).toFixed(8), Number(t.price).toFixed(8), t.transfer ? 'transfer' : 'trade',
  ].join('|');
  for (const t of existingTxs) {
    keys.add(txKey(t));
    if (t.id) ids.add(t.id);
  }
  const known = new Set(ASSETS.map(a => a.id));

  const added = [], skippedAssets = new Set();
  let dedupe = 0;
  for (const t of parsed.txs) {
    if (!known.has(t.asset)) { skippedAssets.add(t.asset); continue; }
    if (t.transfer && t.price === 0 && MARKET.prices[t.asset]) {
      t.price = MARKET.prices[t.asset][dateToIndex(t.date)];
      t.estimatedTransferPrice = true;
    }
    const key = txKey(t);
    if ((t.id && ids.has(t.id)) || keys.has(key)) { dedupe++; continue; }
    keys.add(key); if (t.id) ids.add(t.id);
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
    estimatedTransfers: added.filter(t => t.estimatedTransferPrice).length,
    skippedAssets: [...skippedAssets],
    addedValue: added.reduce((s, t) => s + (t.type === 'buy' ? 1 : -1) * t.qty * t.price, 0),
  };
}
