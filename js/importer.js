/* ============================================================
   importer.js — JSON-import van portfolio/transactiegeschiedenis
   + live crypto-koersen (CoinGecko)

   De parser is bewust tolerant: hij scant het hele JSON-object op
   arrays die op transacties lijken (NL/EN veldnamen, DEGIRO-achtige
   exports, geneste structuren) en op koershistories. Onbekende assets
   worden geregistreerd; ontbrekende historie wordt gesynthetiseerd
   rond de bekende transactiekoersen.
   ============================================================ */

const CUSTOM_KEY = 'vermogen_custom_v2';
const LEGACY_CUSTOM_KEY = 'vermogen_custom_v1';
const MODE_KEY = 'vermogen_mode';
const BACKUP_SCHEMA_VERSION = 4;
const SUPPORTED_BACKUP_SCHEMA_VERSIONS = new Set([2, 3, BACKUP_SCHEMA_VERSION]);
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
const F_FEE = ['fee', 'fees', 'kosten', 'commission', 'commissie', 'transactionfee', 'transactiekosten'];
const F_TAX = ['tax', 'taxes', 'belasting', 'withholdingtax', 'bronbelasting'];
const F_FX = ['fxrate', 'eurfx', 'ratetoeur', 'wisselkoersnaareur', 'exchangeratetoeur'];
const MAX_IMPORT_DIAGNOSTIC_DETAILS = 50;

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

function analyzeTxCandidate(o) {
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return { candidate: false, tx: null, assumptions: [] };
  const rawDate = getField(o, F_DATE);
  const date = parseDateFlexible(rawDate);

  // Exact schema-v4-object: hiermee kunnen ook cash, dividend, splits en
  // transfers uit een generieke JSON-import worden herkend.
  const exactType = cleanDisplayText(o.type || '', 20).toLowerCase();
  if (TRANSACTION_TYPES.includes(exactType)) {
    if (!date) return { candidate: true, tx: null, reason: 'ongeldige of ontbrekende datum', assumptions: [] };
    const legacyTrade = TRADE_TYPES.has(exactType) && !Object.prototype.hasOwnProperty.call(o, 'external');
    const exact = normalizeStoredTransaction({ ...o, date: date.toISOString() }, { legacy: legacyTrade });
    if (!exact) return { candidate: true, tx: null, reason: `ongeldige schema-v4-boeking van type ${exactType}`, assumptions: [] };
    const rawName = getField(o, F_NAME);
    return {
      candidate: true,
      assumptions: legacyTrade ? ['trade zonder external-vlag als direct extern afgerekend geïnterpreteerd'] : [],
      tx: {
        ...exact,
        assetName: cleanDisplayText(rawName || exact.asset || 'Cashrekening', 80),
        assetClass: parseAssetClass(getField(o, F_ASSETCLASS)),
        currentPrice: parseNum(getField(o, ['currentprice', 'huidigekoers', 'lastprice', 'laatstekoers'])),
        isin: cleanDisplayText(getField(o, F_ISIN) || '', 16).toUpperCase(),
        assetCurrency: normalizeCurrency(getField(o, F_CURRENCY) || exact.currency) || 'EUR',
        venue: cleanDisplayText(getField(o, F_VENUE) || '', 16).toUpperCase(),
        quoteSymbol: cleanDisplayText(getField(o, F_QUOTE_SYMBOL) || '', 32),
        sourceId: cleanDisplayText(getField(o, F_SOURCE_ID) || '', 80),
      },
    };
  }

  const rawQty = getField(o, F_QTY);
  const rawPrice = getField(o, F_PRICE);
  const rawTotal = getField(o, F_TOTAL);
  const rawSymbol = getField(o, F_SYMBOL);
  const rawName = getField(o, F_NAME);
  if (rawQty === undefined || rawQty === null || rawQty === '') {
    return { candidate: false, tx: null, assumptions: [] };
  }
  const candidateSignals = [rawDate, rawQty, rawSymbol, rawPrice ?? rawTotal]
    .filter(value => value !== undefined && value !== null && value !== '').length;
  if (candidateSignals < 3) return { candidate: false, tx: null, assumptions: [] };

  let qty = parseNum(rawQty);
  let price = parseNum(rawPrice);
  const total = parseNum(rawTotal);
  if (!date) return { candidate: true, tx: null, reason: 'ongeldige of ontbrekende datum', assumptions: [] };
  if (!rawSymbol) return { candidate: true, tx: null, reason: 'asset/ticker ontbreekt', assumptions: [] };
  if (qty === null || qty === 0) return { candidate: true, tx: null, reason: 'aantal ontbreekt of is nul', assumptions: [] };
  const assumptions = [];
  const derivedPrice = price === null;
  if (derivedPrice && total !== null && qty !== 0) {
    price = Math.abs(total) / Math.abs(qty);
    assumptions.push('eenheidsprijs afgeleid uit totaalbedrag en aantal');
  }
  // price 0 is legitiem (staking rewards, airdrops, bonussen): aantal telt
  // mee, kostprijs is nul. Alleen ontbrekend/negatief afwijzen.
  if (price === null || price < 0) return { candidate: true, tx: null, reason: 'koers en bruikbaar totaalbedrag ontbreken', assumptions };

  // probeer álle type-velden tot er één een order-richting oplevert
  // (velden als type:"Crypto" zijn een asset-klasse, geen richting)
  let type = null, assetClass = null;
  const unknownDirectionValues = new Set();
  for (const name of F_TYPE) {
    const v = getField(o, [name]);
    if (v === undefined) continue;
    type = parseSide(v);
    if (type) break;
    if (!parseAssetClass(v)) unknownDirectionValues.add(cleanDisplayText(v, 40));
  }
  for (const name of F_ASSETCLASS) {
    const v = getField(o, [name]);
    if (v === undefined) continue;
    assetClass = parseAssetClass(v);
    if (assetClass) break;
  }
  if (!type && unknownDirectionValues.size) {
    return {
      candidate: true, tx: null, assumptions,
      reason: `onbekend transactietype: ${[...unknownDirectionValues].filter(Boolean).join(', ') || 'lege waarde'}`,
    };
  }
  if (!type && qty < 0) {
    type = 'sell';
    assumptions.push('verkooprichting afgeleid uit negatief aantal');
  }
  if (!type) return { candidate: true, tx: null, reason: 'koop/verkooprichting ontbreekt', assumptions };
  qty = Math.abs(qty);

  const symbol = normalizeAssetId(rawSymbol);
  if (!symbol) return { candidate: true, tx: null, reason: 'ongeldige asset/ticker', assumptions };
  const rawCurrency = getField(o, F_CURRENCY);
  const currency = normalizeCurrency(rawCurrency || 'EUR');
  if (!currency) return { candidate: true, tx: null, reason: 'ongeldige valuta', assumptions };
  let fxRate = parseNum(getField(o, F_FX));
  if (currency === 'EUR') fxRate = 1;
  else if (!(fxRate > 0 && fxRate < 1e6)) {
    return { candidate: true, tx: null, reason: `${currency}-boeking mist een geldige wisselkoers naar EUR`, assumptions };
  }
  if (!rawCurrency) assumptions.push('valuta ontbreekt; EUR aangenomen');
  const sourceId = cleanDisplayText(getField(o, F_SOURCE_ID) || '', 80);
  const parsedFee = Math.abs(parseNum(getField(o, F_FEE)) || 0);
  const parsedTax = Math.abs(parseNum(getField(o, F_TAX)) || 0);
  if (derivedPrice && (parsedFee > 0 || parsedTax > 0)) {
    assumptions.push('kosten-/belastingvelden niet dubbel geteld omdat de prijs uit het totaalbedrag is afgeleid');
  }
  const fee = derivedPrice ? 0 : parsedFee;
  const tax = derivedPrice ? 0 : parsedTax;
  return {
    candidate: true,
    assumptions,
    tx: {
      date: date.toISOString(), type, qty, price, fee, tax,
      currency, fxRate, external: true, source: 'json',
      asset: symbol,
      assetName: cleanDisplayText(rawName || symbol, 80) || symbol,
      assetClass,
      currentPrice: parseNum(getField(o, ['currentprice', 'huidigekoers', 'lastprice', 'laatstekoers'])),
      isin: cleanDisplayText(getField(o, F_ISIN) || '', 16).toUpperCase(),
      assetCurrency: currency,
      venue: cleanDisplayText(getField(o, F_VENUE) || '', 16).toUpperCase(),
      quoteSymbol: cleanDisplayText(getField(o, F_QUOTE_SYMBOL) || '', 32),
      sourceId,
    },
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
  let foundTransactionArray = false;
  const diagnostics = {
    candidateRows: 0,
    ignoredRows: 0,
    rejectedRows: 0,
    assumptionCount: 0,
    rejected: [],
    ignored: [],
    assumptions: [],
  };
  const remember = (list, value) => {
    if (list.length < MAX_IMPORT_DIAGNOSTIC_DETAILS) list.push(value);
  };

  function visit(node, keyHint, depth = 0) {
    if (node === null || typeof node !== 'object') return;
    if (depth > 64) throw new Error('JSON is te diep genest.');
    if (++scannedNodes > 100000) throw new Error('JSON bevat te veel objecten.');
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      if (node.length && typeof node[0] === 'object') {
        // Een array wordt pas als transactietabel behandeld als voldoende
        // rijen de kernvelden bevatten. Afgewezen of geïnterpreteerde rijen
        // worden daarna expliciet aan de importpreview doorgegeven.
        const analyzed = node.map(analyzeTxCandidate);
        const candidateCount = analyzed.filter(row => row.candidate).length;
        if (candidateCount >= Math.max(1, node.length * 0.3) || candidateCount >= 25) {
          foundTransactionArray = true;
          diagnostics.candidateRows += candidateCount;
          diagnostics.ignoredRows += node.length - candidateCount;
          analyzed.forEach((row, index) => {
            const location = `${keyHint || 'transacties'} rij ${index + 1}`;
            if (!row.candidate) {
              remember(diagnostics.ignored, `${location}: geen volledige transactievelden`);
              return;
            }
            if (!row.tx) {
              diagnostics.rejectedRows++;
              remember(diagnostics.rejected, `${location}: ${row.reason || 'niet veilig te interpreteren'}`);
              return;
            }
            txs.push(row.tx);
            for (const assumption of row.assumptions || []) {
              diagnostics.assumptionCount++;
              remember(diagnostics.assumptions, `${location}: ${assumption}`);
            }
          });
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
  if (txs.length === 0 && !foundTransactionArray) {
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
            const importedDate = parseDateFlexible(getField(o, ['purchasedate', 'aankoopdatum', 'since', 'firstbuy']));
            const d = importedDate || new Date(Date.now() - 365 * 86400000);
            txs.push({
              date: d.toISOString(), type: 'buy', qty, price: avg,
              fee: 0, tax: 0, currency: 'EUR', fxRate: 1, external: true, source: 'position-import',
              asset,
              assetName: cleanDisplayText(getField(o, F_NAME) || sym, 80),
              isin: cleanDisplayText(getField(o, F_ISIN) || '', 16).toUpperCase(),
              assetCurrency: cleanDisplayText(getField(o, F_CURRENCY) || 'EUR', 8).toUpperCase(),
              venue: cleanDisplayText(getField(o, F_VENUE) || '', 16).toUpperCase(),
            });
            diagnostics.candidateRows++;
            diagnostics.assumptionCount++;
            remember(diagnostics.assumptions, `${asset}: positie als synthetische koop met gemiddelde kostprijs geïnterpreteerd${importedDate ? '' : '; aankoopdatum op één jaar geleden gezet'}`);
          }
        }
        node.forEach(item => visitPositions(item, depth + 1));
        return;
      }
      Object.values(node).forEach(value => visitPositions(value, depth + 1));
    }
    visitPositions(root);
  }

  return { txs, histories, diagnostics };
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

/** Kwaliteit: bronpunten zijn observed; korte gaten worden per marktvenster carried. */
function qualityFromPoints(points, assetOrType = 'Aandeel') {
  const quality = new Array(HISTORY_DAYS).fill(PRICE_QUALITY.RECONSTRUCTED);
  if (!points.length) return quality;
  const indices = points.map(p => p.idx).filter(i => Number.isInteger(i)).sort((a, b) => a - b);
  if (!indices.length) return quality;
  const observed = new Set(indices);
  const first = Math.max(0, indices[0]), last = Math.min(HISTORY_DAYS - 1, indices[indices.length - 1]);
  for (let i = first; i <= last; i++) quality[i] = observed.has(i) ? PRICE_QUALITY.OBSERVED : PRICE_QUALITY.CARRIED;
  return sanitizePriceQuality(quality, assetOrType);
}

const QUALITY_TO_CODE = Object.freeze({
  [PRICE_QUALITY.OBSERVED]: 'o',
  [PRICE_QUALITY.CARRIED]: 'c',
  [PRICE_QUALITY.RECONSTRUCTED]: 'r',
});
const CODE_TO_QUALITY = Object.freeze({ o: PRICE_QUALITY.OBSERVED, c: PRICE_QUALITY.CARRIED, r: PRICE_QUALITY.RECONSTRUCTED });

function encodePriceQuality(quality) {
  return normalizePriceQuality(quality).map(value => QUALITY_TO_CODE[value]).join('');
}

function decodePriceQuality(value) {
  if (typeof value === 'string' && value.length === HISTORY_DAYS && /^[ocr]+$/.test(value)) {
    return [...value].map(code => CODE_TO_QUALITY[code]);
  }
  if (Array.isArray(value) && value.length === HISTORY_DAYS && value.every(item => PRICE_QUALITY_VALUES.has(item))) {
    return [...value];
  }
  return null;
}

function serializeMarketSeries(assetId) {
  const prices = normalizePriceSeries(MARKET.prices[assetId]);
  const quality = normalizePriceQuality(MARKET.quality[assetId], MARKET.provenance[assetId]);
  if (!prices) throw new Error(`Ongeldige marktdata voor ${assetId}.`);
  const meta = MARKET.meta[assetId] || {};
  const quoteAt = Number(meta.quoteAt), fetchedAt = Number(meta.fetchedAt);
  return {
    schemaVersion: MARKET_SERIES_SCHEMA_VERSION,
    startDate: localDateKey(MARKET.dates[0]),
    prices: prices.map(price => +price.toPrecision(10)),
    quality: encodePriceQuality(quality),
    source: cleanDisplayText(meta.source || assetById(assetId)?.histSource || '', 24),
    ...(Number.isFinite(quoteAt) && quoteAt > 0 ? { quoteAt } : {}),
    ...(Number.isFinite(fetchedAt) && fetchedAt > 0 ? { fetchedAt } : {}),
    anchorConfidence: meta.anchorConfidence === 'unverified' ? 'unverified' : 'verified',
  };
}

function normalizeMarketSeriesEntry(entry, assetId, assetOrType = assetById(assetId) || 'Aandeel') {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`Backup mist gedateerde marktdata voor ${assetId}.`);
  if (entry.schemaVersion !== MARKET_SERIES_SCHEMA_VERSION) throw new Error(`Onbekend marktdataformaat voor ${assetId}.`);
  const startDate = localDateFromKey(entry.startDate);
  const prices = normalizePriceSeries(entry.prices);
  const quality = decodePriceQuality(entry.quality);
  if (!startDate || !prices || !quality) throw new Error(`Ongeldige gedateerde marktdata voor ${assetId}.`);
  const quoteAt = Number(entry.quoteAt), fetchedAt = Number(entry.fetchedAt);
  const anchorConfidence = entry.anchorConfidence === 'verified' ? 'verified' : 'unverified';
  const effectiveQuality = sanitizePriceQuality(anchorConfidence === 'verified'
    ? quality
    : new Array(HISTORY_DAYS).fill(PRICE_QUALITY.RECONSTRUCTED), assetOrType);
  const stored = {
    schemaVersion: MARKET_SERIES_SCHEMA_VERSION,
    startDate: localDateKey(startDate),
    prices: prices.map(price => +price.toPrecision(10)),
    quality: encodePriceQuality(effectiveQuality),
    source: cleanDisplayText(entry.source || '', 24),
    ...(Number.isFinite(quoteAt) && quoteAt > 0 ? { quoteAt } : {}),
    ...(Number.isFinite(fetchedAt) && fetchedAt > 0 ? { fetchedAt } : {}),
    anchorConfidence,
  };

  const projectedPrices = new Array(HISTORY_DAYS);
  const projectedQuality = new Array(HISTORY_DAYS);
  for (let i = 0; i < HISTORY_DAYS; i++) {
    const sourceIndex = calendarDayDiff(startDate, MARKET.dates[i]);
    if (sourceIndex >= 0 && sourceIndex < HISTORY_DAYS) {
      projectedPrices[i] = prices[sourceIndex];
      projectedQuality[i] = effectiveQuality[sourceIndex];
    } else if (sourceIndex < 0) {
      projectedPrices[i] = prices[0];
      projectedQuality[i] = PRICE_QUALITY.RECONSTRUCTED;
    } else {
      projectedPrices[i] = i > 0 ? projectedPrices[i - 1] : prices[HISTORY_DAYS - 1];
      const previous = i > 0 ? projectedQuality[i - 1] : effectiveQuality[HISTORY_DAYS - 1];
      projectedQuality[i] = qualityIsReliable(previous) ? PRICE_QUALITY.CARRIED : PRICE_QUALITY.RECONSTRUCTED;
    }
  }
  return {
    stored,
    prices: projectedPrices,
    quality: projectedQuality,
    meta: {
      source: stored.source,
      quoteAt: stored.quoteAt || null,
      fetchedAt: stored.fetchedAt || null,
      storedStartDate: stored.startDate,
      anchorConfidence: stored.anchorConfidence,
    },
  };
}

/** Zet legacy positionele arrays fail-closed om naar een expliciet gedateerde reeks. */
function legacyMarketSeries(prices, candidateEndDate, source = '') {
  const normalized = normalizePriceSeries(prices);
  if (!normalized) return null;
  const candidate = new Date(candidateEndDate || '');
  const endDate = Number.isFinite(candidate.getTime()) ? localDateKey(candidate) : localDateKey(MARKET.dates[HISTORY_DAYS - 1]);
  return {
    schemaVersion: MARKET_SERIES_SCHEMA_VERSION,
    startDate: addCalendarDays(endDate, -(HISTORY_DAYS - 1)),
    prices: normalized.map(price => +price.toPrecision(10)),
    quality: encodePriceQuality(new Array(HISTORY_DAYS).fill(PRICE_QUALITY.RECONSTRUCTED)),
    source: cleanDisplayText(source || 'legacy-unverified', 24),
    anchorConfidence: 'unverified',
  };
}

function stableTransactionId(tx, index = 0) {
  if (tx.sourceId) return `src-${cleanDisplayText(tx.sourceId, 72).replace(/[^A-Za-z0-9._-]/g, '-')}`;
  const numeric = value => Number.isFinite(Number(value)) ? Number(value).toPrecision(12) : '';
  const raw = [
    tx.date, tx.type, tx.asset || '', numeric(tx.qty), numeric(tx.price), numeric(tx.amount),
    numeric(tx.ratio), numeric(tx.fee), numeric(tx.tax), numeric(tx.externalValue), tx.external === true ? 'external' : '',
  ].join('|');
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

function normalizeBackupTransaction(tx, index, { legacy = false } = {}) {
  if (!tx || typeof tx !== 'object' || Array.isArray(tx)) throw new Error(`Ongeldige transactie op positie ${index + 1}.`);
  const date = parseDateFlexible(tx.date);
  if (!date) throw new Error(`Ongeldige transactie op positie ${index + 1}.`);
  if (isFutureCalendarDate(date)) throw new Error(`Transactie op positie ${index + 1} ligt in de toekomst.`);
  const candidate = {
    ...tx,
    id: cleanDisplayText(tx.id || stableTransactionId({ ...tx, date: date.toISOString() }, index), 100),
    date: date.toISOString(),
  };
  const normalized = normalizeStoredTransaction(candidate, { legacy });
  if (!normalized) throw new Error(`Ongeldige transactie op positie ${index + 1}.`);
  return normalized;
}

function normalizeBackupReconciliation(snapshot, assetIds) {
  if (snapshot === null || snapshot === undefined) return null;
  if (typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('Backup bevat een ongeldige brokerreconciliatie.');
  const clean = { assets: {}, cash: null, date: null };
  if (snapshot.assets !== undefined && (typeof snapshot.assets !== 'object' || Array.isArray(snapshot.assets))) {
    throw new Error('Backup bevat ongeldige reconciliatieposities.');
  }
  for (const [rawId, rawQty] of Object.entries(snapshot.assets || {})) {
    const id = normalizeAssetId(rawId), qty = Number(rawQty);
    if (!id || !assetIds.has(id) || !Number.isFinite(qty) || qty < 0 || qty >= 1e15) {
      throw new Error(`Backup bevat een ongeldige brokerstand voor ${rawId}.`);
    }
    clean.assets[id] = qty;
  }
  if (snapshot.cash !== '' && snapshot.cash !== null && snapshot.cash !== undefined) {
    const cash = Number(snapshot.cash);
    if (!Number.isFinite(cash) || Math.abs(cash) >= 1e15) throw new Error('Backup bevat een ongeldig broker-cashsaldo.');
    clean.cash = cash;
  }
  if (snapshot.date) {
    const date = parseDateFlexible(snapshot.date);
    if (!date) throw new Error('Backup bevat een ongeldige reconciliatiedatum.');
    clean.date = date.toISOString();
  }
  return clean;
}

function restoreBackup(root, { commit = true } = {}) {
  if (root?.meta?.kind !== 'vermogen-backup') return null;
  if (!SUPPORTED_BACKUP_SCHEMA_VERSIONS.has(root?.schemaVersion)) throw new Error(`Backupversie ${root?.schemaVersion ?? 'onbekend'} wordt niet ondersteund.`);
  if (!root.state) throw new Error('Backupstructuur is incompleet.');
  const state = root.state;
  const datedMarket = root.schemaVersion === BACKUP_SCHEMA_VERSION;
  const hasMarketState = datedMarket
    ? state.market && typeof state.market === 'object' && !Array.isArray(state.market)
    : state.prices && typeof state.prices === 'object' && !Array.isArray(state.prices);
  if (!Array.isArray(state.transactions) || !Array.isArray(state.assets) || !hasMarketState) {
    throw new Error('Backupstructuur is incompleet.');
  }
  if (state.transactions.length > MAX_IMPORT_TRANSACTIONS || state.assets.length > MAX_IMPORT_ASSETS) {
    throw new Error('Backup overschrijdt de veilige importlimieten.');
  }
  const market = {};
  const assets = state.assets.map((asset, index) => {
    const id = normalizeAssetId(asset.id);
    if (!id) throw new Error(`Ongeldige asset op positie ${index + 1}.`);
    const assetType = ['Crypto', 'ETF', 'Aandeel'].includes(asset.type) ? asset.type : 'Aandeel';
    let entry;
    if (datedMarket) {
      entry = normalizeMarketSeriesEntry(state.market[id], id, assetType);
    } else {
      const prices = normalizePriceSeries(state.prices[id]);
      const sourceFlags = state.provenance?.[id];
      if (!prices || !Array.isArray(sourceFlags) || sourceFlags.length !== HISTORY_DAYS
          || !sourceFlags.every(value => typeof value === 'boolean')) {
        throw new Error(`Ongeldige legacy-koersreeks op positie ${index + 1}.`);
      }
      const legacyEntry = legacyMarketSeries(prices, root.meta?.exportedAt, asset.histSource);
      entry = normalizeMarketSeriesEntry(legacyEntry, id, assetType);
    }
    market[id] = entry.stored;
    return {
      ...asset, id,
      name: cleanDisplayText(asset.name || id, 80) || id,
      color: safeColor(asset.color, CUSTOM_COLORS[index % CUSTOM_COLORS.length]),
      type: assetType,
      histSource: datedMarket ? cleanDisplayText(asset.histSource || entry.meta.source || 'synth', 24) : 'synth',
      custom: true,
    };
  });
  const assetIds = new Set(assets.map(a => a.id));
  if (assetIds.size !== assets.length) throw new Error('Backup bevat dubbele asset-id’s.');
  const legacy = root.schemaVersion === 2;
  const transactions = state.transactions.map((tx, index) => normalizeBackupTransaction(tx, index, { legacy }));
  if (transactions.some(tx => tx.asset && !assetIds.has(tx.asset))) throw new Error('Backup bevat transacties zonder assetdefinitie.');
  const transactionIds = new Set(transactions.map(tx => tx.id));
  if (transactionIds.size !== transactions.length) throw new Error('Backup bevat dubbele transactie-id’s.');
  const reconciliation = normalizeBackupReconciliation(state.reconciliation, assetIds);

  const report = {
    txCount: transactions.length,
    assetCount: assets.length,
    symbols: assets.map(a => a.id),
    histMatched: datedMarket ? assets.filter(a => a.histSource !== 'synth').length : 0,
    synthesized: datedMarket ? assets.filter(a => a.histSource === 'synth').length : assets.length,
    restoredBackup: true,
    date: new Date().toISOString(),
    ...(datedMarket ? {} : { migrationWarning: 'Legacy-koersdatums konden niet hard worden bewezen; transacties zijn behouden en koerskwaliteit is fail-closed gemarkeerd.' }),
  };
  const updates = {
    [CUSTOM_KEY]: JSON.stringify({ schemaVersion: BACKUP_SCHEMA_VERSION, assets, market, report }),
    [LEGACY_CUSTOM_KEY]: null,
    [MODE_KEY]: 'import',
    [TX_KEY]: JSON.stringify(transactions),
    vermogen_watchlist_v1: JSON.stringify(Array.isArray(state.watchlist) ? state.watchlist.map(normalizeAssetId).filter(id => id && assetIds.has(id)) : []),
    vermogen_alerts_v1: JSON.stringify(Array.isArray(state.alerts) ? state.alerts : []),
    vermogen_dca_v1: JSON.stringify(Array.isArray(state.dcaPlans) ? state.dcaPlans : []),
    vermogen_watchassets_v1: JSON.stringify(Array.isArray(state.watchAssets) ? state.watchAssets : []),
    [LIVEHIST_KEY]: datedMarket ? JSON.stringify(state.liveHistory && typeof state.liveHistory === 'object' ? state.liveHistory : {}) : null,
    [LEGACY_LIVEHIST_KEY]: datedMarket ? null : JSON.stringify(state.liveHistory && typeof state.liveHistory === 'object' ? state.liveHistory : {}),
    vermogen_yahoo_v1: JSON.stringify(state.yahooMap && typeof state.yahooMap === 'object' ? state.yahooMap : {}),
    [RECONCILIATION_KEY]: reconciliation ? JSON.stringify(reconciliation) : null,
    [NETWORK_CONSENT_KEY]: 'no',
  };
  if (commit) commitStorage(updates, { clearNamespace: true });
  return { ok: true, txs: transactions, report };
}

function confirmationRequired(preview) {
  return {
    ok: false,
    needsConfirmation: true,
    error: 'Controleer en bevestig de importpreview voordat gegevens worden opgeslagen.',
    preview,
  };
}

/** Voert een generieke portfolio-import of een volledige backuprestore uit. */
function importPortfolioJSON(jsonText, { confirmed = false } = {}) {
  if (typeof jsonText !== 'string' || jsonText.length > MAX_IMPORT_BYTES) {
    return { ok: false, error: 'Importbestand is groter dan de veilige limiet van 8 MB.' };
  }
  let root;
  try { root = JSON.parse(jsonText); }
  catch (e) { return { ok: false, error: 'Het bestand is geen geldige JSON: ' + e.message }; }

  try {
    const restored = restoreBackup(root, { commit: confirmed });
    if (restored) {
      if (!confirmed) {
        return confirmationRequired({
          source: `Backup schema ${root.schemaVersion}`,
          mode: 'replace',
          recognized: restored.report.txCount,
          assets: restored.report.symbols,
          candidateRows: restored.report.txCount,
          ignoredRows: 0,
          rejectedRows: 0,
          assumptionCount: root.schemaVersion === BACKUP_SCHEMA_VERSION ? 0 : 1,
          rejected: [],
          assumptions: root.schemaVersion === BACKUP_SCHEMA_VERSION
            ? []
            : ['Ongedateerde legacy-koerskwaliteit wordt fail-closed als gereconstrueerd gemigreerd.'],
          warnings: ['Deze volledige restore vervangt alle lokale portefeuilledata en schakelt netwerkverversing uit.'],
        });
      }
      return restored;
    }
  } catch (e) {
    return { ok: false, error: 'Backup herstellen mislukt: ' + e.message };
  }

  let txs, histories, diagnostics;
  try { ({ txs, histories, diagnostics } = scanJSON(root)); }
  catch (e) { return { ok: false, error: 'Importstructuur afgewezen: ' + e.message }; }
  if (!txs.length) {
    const detail = diagnostics?.rejected?.[0] ? ` Eerste afgewezen rij: ${diagnostics.rejected[0]}.` : '';
    return { ok: false, error: `Geen veilige transacties of posities herkend in dit bestand.${detail} Verwacht: een array met datum, koop/verkooprichting, aantal, koers/bedrag en ticker.` };
  }
  const futureTransaction = txs.find(tx => isFutureCalendarDate(tx.date));
  if (futureTransaction) {
    return { ok: false, error: `Import bevat een toekomstige boeking (${localDateKey(new Date(futureTransaction.date))}); pas de boekingsdatum aan.` };
  }
  if (txs.length > MAX_IMPORT_TRANSACTIONS) return { ok: false, error: `Te veel transacties; maximum is ${MAX_IMPORT_TRANSACTIONS}.` };

  const symbols = [...new Set(txs.map(t => t.asset).filter(Boolean))];
  if (symbols.length > MAX_IMPORT_ASSETS) return { ok: false, error: `Te veel assets; maximum is ${MAX_IMPORT_ASSETS}.` };
  if (!confirmed) {
    return confirmationRequired({
      source: 'Portfolio-JSON',
      mode: 'replace',
      recognized: txs.length,
      assets: symbols,
      candidateRows: diagnostics.candidateRows,
      ignoredRows: diagnostics.ignoredRows,
      rejectedRows: diagnostics.rejectedRows,
      assumptionCount: diagnostics.assumptionCount,
      rejected: diagnostics.rejected,
      ignored: diagnostics.ignored,
      assumptions: diagnostics.assumptions,
      warnings: ['Deze import vervangt de huidige transacties, assets, reconciliatie en bijbehorende koersbasis.'],
    });
  }
  const customAssets = [], customMarket = {};
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
    let quality = new Array(HISTORY_DAYS).fill(PRICE_QUALITY.RECONSTRUCTED);
    const histKey = Object.keys(histories).find(k => k === sym || k.startsWith(sym) || sym.startsWith(k));
    if (histKey && histories[histKey].length >= 20) {
      grid = historyToGrid(histories[histKey]);
      if (grid) {
        quality = qualityFromPoints(histories[histKey], type);
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
    const provenance = quality.map(qualityIsReliable);
    const histSource = quality.some(value => value === PRICE_QUALITY.OBSERVED) ? 'import' : 'synth';
    const asset = {
      ...(existing || {}), id: sym, name, type, start: grid[0], drift: 0.08,
      vol: volForType(type), seed: existing?.seed || 1, color, custom: true, histSource,
      isin: metadata.isin || existing?.isin || '', currency: metadata.assetCurrency || existing?.currency || 'EUR',
      venue: metadata.venue || existing?.venue || '', yahoo: metadata.quoteSymbol || existing?.yahoo || '',
    };
    registerAsset(asset, grid, provenance, quality, { source: histSource, fetchedAt: Date.now() });
    customAssets.push({ ...assetById(sym) });
    customMarket[sym] = serializeMarketSeries(sym);
  }

  const usedTransactionIds = new Set();
  let cleanTxs;
  try {
    cleanTxs = txs.map((t, i) => {
      const baseId = stableTransactionId(t, i);
      let id = baseId, suffix = 1;
      while (usedTransactionIds.has(id)) id = `${baseId}-${suffix++}`;
      usedTransactionIds.add(id);
      const normalized = normalizeStoredTransaction({ ...t, id });
      if (!normalized) throw new Error(`Ongeldige herkende boeking op positie ${i + 1}.`);
      return normalized;
    }).sort((a, b) => new Date(a.date) - new Date(b.date));
  } catch (error) {
    return { ok: false, error: 'Herkende transacties konden niet veilig worden genormaliseerd: ' + error.message };
  }
  const report = {
    txCount: cleanTxs.length, assetCount: symbols.length, symbols,
    histMatched, synthesized, restoredBackup: false, date: new Date().toISOString(),
    importDiagnostics: {
      candidateRows: diagnostics.candidateRows,
      ignoredRows: diagnostics.ignoredRows,
      rejectedRows: diagnostics.rejectedRows,
      assumptionCount: diagnostics.assumptionCount,
    },
  };
  try {
    commitStorage({
      [CUSTOM_KEY]: JSON.stringify({ schemaVersion: BACKUP_SCHEMA_VERSION, assets: customAssets, market: customMarket, report }),
      [LEGACY_CUSTOM_KEY]: null,
      [MODE_KEY]: 'import',
      [TX_KEY]: JSON.stringify(cleanTxs),
      [LEGACY_TX_KEY]: null,
      [RECONCILIATION_KEY]: null,
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
    const currentRaw = localStorage.getItem(CUSTOM_KEY);
    const legacyRaw = currentRaw ? null : localStorage.getItem(LEGACY_CUSTOM_KEY);
    const data = JSON.parse(currentRaw || legacyRaw);
    if (!data || typeof data !== 'object') return null;
    const dated = data.schemaVersion === BACKUP_SCHEMA_VERSION && data.market && typeof data.market === 'object';
    const legacy = !dated && data.prices && typeof data.prices === 'object';
    if (!dated && !legacy) return null;
    const definitions = new Map((data.assets || []).map(asset => [normalizeAssetId(asset.id), asset]));
    const sourceEntries = dated ? data.market : data.prices;
    const migratedMarket = {};
    for (const [rawId, rawSeries] of Object.entries(sourceEntries)) {
      const id = normalizeAssetId(rawId);
      if (!id) continue;
      const definition = definitions.get(id);
      const assetType = ['Crypto', 'ETF', 'Aandeel'].includes(definition?.type)
        ? definition.type
        : guessType(id, id);
      const parsed = dated
        ? normalizeMarketSeriesEntry(rawSeries, id, assetType)
        : normalizeMarketSeriesEntry(legacyMarketSeries(rawSeries, data.report?.date, definition?.histSource), id, assetType);
      const asset = definition || {
        id, name: id, type: assetType, color: CUSTOM_COLORS[ASSETS.length % CUSTOM_COLORS.length],
        custom: true, histSource: dated && parsed.quality.some(value => value === PRICE_QUALITY.OBSERVED) ? 'import' : 'synth',
      };
      if (!dated) asset.histSource = 'synth';
      registerAsset(asset, parsed.prices, parsed.quality.map(qualityIsReliable), parsed.quality, parsed.meta);
      migratedMarket[id] = parsed.stored;
    }
    if (legacy) {
      const report = {
        ...(data.report || {}),
        migrationWarning: 'Legacy-koersdatums konden niet hard worden bewezen; transacties zijn behouden, koerskwaliteit is fail-closed gemarkeerd en de oude opslag blijft lokaal als rollbackkopie staan.',
      };
      commitStorage({
        [CUSTOM_KEY]: JSON.stringify({ schemaVersion: BACKUP_SCHEMA_VERSION, assets: ASSETS.filter(asset => asset.custom).map(asset => ({ ...asset })), market: migratedMarket, report }),
      });
      return report;
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
  ensureCurrentMarketGrid();
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
      const quoteDate = localDateKey(new Date(quoteAt));
      const current = store[asset.id] && typeof store[asset.id] === 'object' ? store[asset.id] : {};
      const spotOnly = current.spotOnly === true || !Array.isArray(current.points) || current.points.length <= 1;
      const compact = new Map((Array.isArray(current.points) ? current.points : [])
        .filter(point => Array.isArray(point) && localDateFromKey(point[0])
          && Number.isFinite(Number(point[1])) && Number(point[1]) > 0)
        .map(([date, price]) => [localDateKey(localDateFromKey(date)), Number(price)]));
      compact.set(quoteDate, +eur.toPrecision(10));
      store[asset.id] = {
        ...current,
        at: now,
        quoteAt,
        points: [...compact.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-2000),
        src: 'coingecko',
        cg: cgId,
        verified: true,
        ...(spotOnly ? { spotOnly: true } : {}),
      };
      pending.push({ asset, cgId, eur, quoteAt, quoteDate, now });
    }
    if (!pending.length) return null;
    commitStorage({ [LIVEHIST_KEY]: JSON.stringify(store) });
    for (const { asset, cgId, eur, quoteAt, quoteDate, now: fetchedAt } of pending) {
      asset.cg = cgId;
      applyObservedSpot(asset.id, quoteDate, eur, { source: 'coingecko', quoteAt, fetchedAt });
    }
    return pending.map(item => item.asset.id);
  } catch (e) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ============================================================
   Gedateerde koershistorie (CoinGecko, maximaal 1.095 dagen) + export
   ============================================================ */
const LIVEHIST_KEY = 'vermogen_livehist_v2';
const LEGACY_LIVEHIST_KEY = 'vermogen_livehist_v1';

function normalizeLiveHistoryStore(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const clean = {};
  for (const [rawId, rawEntry] of Object.entries(raw).slice(0, MAX_IMPORT_ASSETS)) {
    const id = normalizeAssetId(rawId);
    if (!id || !rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) continue;
    const points = new Map();
    for (const point of Array.isArray(rawEntry.points) ? rawEntry.points.slice(0, 2500) : []) {
      const date = localDateFromKey(point?.[0]), price = Number(point?.[1]);
      if (!date || !Number.isFinite(price) || price <= 0 || price >= 1e12) continue;
      points.set(localDateKey(date), +price.toPrecision(10));
    }
    if (!points.size) continue;
    const at = Number(rawEntry.at), quoteAt = Number(rawEntry.quoteAt);
    clean[id] = {
      at: Number.isFinite(at) && at > 0 ? at : 0,
      quoteAt: Number.isFinite(quoteAt) && quoteAt > 0 ? quoteAt : 0,
      points: [...points.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-2000),
      src: cleanDisplayText(rawEntry.src || '', 24),
      ...(normalizeCoinGeckoId(rawEntry.cg) ? { cg: normalizeCoinGeckoId(rawEntry.cg) } : {}),
      ...(rawEntry.verified === false ? { verified: false } : {}),
      ...(rawEntry.spotOnly === true ? { spotOnly: true } : {}),
    };
  }
  return clean;
}

function migrateLegacyLiveHistory(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const migrated = {};
  for (const [rawId, entry] of Object.entries(raw).slice(0, MAX_IMPORT_ASSETS)) {
    const id = normalizeAssetId(rawId);
    if (!id || !entry || typeof entry !== 'object' || !Array.isArray(entry.points)) continue;
    const legacyPoints = entry.points
      .map(point => [Number(point?.[0]), Number(point?.[1])])
      .filter(([index, price]) => Number.isInteger(index) && index >= 0 && index < HISTORY_DAYS
        && Number.isFinite(price) && price > 0 && price < 1e12);
    if (!legacyPoints.length) continue;
    const maxIndex = Math.max(...legacyPoints.map(([index]) => index));
    const quoteAt = Number(entry.quoteAt), fetchedAt = Number(entry.at);
    const hasQuoteAnchor = Number.isFinite(quoteAt) && quoteAt > 0;
    const anchorTimestamp = hasQuoteAnchor ? quoteAt : fetchedAt;
    const anchorDate = localDateKey(new Date(anchorTimestamp));
    if (!anchorDate) continue;
    const points = legacyPoints.map(([index, price]) => [addCalendarDays(anchorDate, index - maxIndex), +price.toPrecision(10)]);
    migrated[id] = {
      at: Number.isFinite(fetchedAt) && fetchedAt > 0 ? fetchedAt : 0,
      quoteAt: hasQuoteAnchor ? quoteAt : 0,
      points,
      src: cleanDisplayText(entry.src || '', 24),
      ...(normalizeCoinGeckoId(entry.cg) ? { cg: normalizeCoinGeckoId(entry.cg) } : {}),
      ...(hasQuoteAnchor ? {} : { verified: false }),
      ...(entry.spotOnly === true ? { spotOnly: true } : {}),
    };
  }
  return normalizeLiveHistoryStore(migrated);
}

function loadLiveHistory() {
  try {
    const current = localStorage.getItem(LIVEHIST_KEY);
    if (current) return normalizeLiveHistoryStore(JSON.parse(current));
    const legacy = localStorage.getItem(LEGACY_LIVEHIST_KEY);
    if (!legacy) return {};
    const migrated = migrateLegacyLiveHistory(JSON.parse(legacy));
    // De legacybron blijft als lokale rollbackkopie staan totdat de gebruiker
    // bewust nieuwe data importeert of alles wist.
    commitStorage({ [LIVEHIST_KEY]: JSON.stringify(migrated) });
    return migrated;
  } catch (e) { return {}; }
}

/** Voegt gedateerde bronkoersen samen met de bestaande reeks (bronvenster wint;
    het stuk ervóór wordt geschaald zodat er geen sprong op de naad zit). */
function mergeRealHistory(assetId, points, { verified = true, source = '', quoteAt = null, fetchedAt = null } = {}) {
  const series = MARKET.prices[assetId];
  if (!series || !points.length) return false;
  const byIdx = new Map();
  for (const [ts, price] of points) {
    const pointDate = typeof ts === 'string' && localDateFromKey(ts) ? localDateFromKey(ts) : (ts instanceof Date ? ts : new Date(ts));
    const idx = dateToIndexUnclamped(pointDate);
    if (!Number.isInteger(idx) || idx < 0 || idx >= HISTORY_DAYS) continue;
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
  if (!MARKET.quality[assetId]) MARKET.quality[assetId] = new Array(HISTORY_DAYS).fill(PRICE_QUALITY.RECONSTRUCTED);
  // Bronvenster invullen: directe punten observed, gaten carried. Een
  // legacyreeks zonder betrouwbaar anker blijft volledig reconstructed.
  let cur = byIdx.get(first);
  for (let i = first; i <= last; i++) {
    if (byIdx.has(i)) cur = byIdx.get(i);
    series[i] = cur;
    MARKET.quality[assetId][i] = verified
      ? (byIdx.has(i) ? PRICE_QUALITY.OBSERVED : PRICE_QUALITY.CARRIED)
      : PRICE_QUALITY.RECONSTRUCTED;
  }
  // Na het venster doortrekken, maar niet als nieuwe waarneming markeren.
  for (let i = last + 1; i < HISTORY_DAYS; i++) {
    series[i] = cur;
    MARKET.quality[assetId][i] = verified ? PRICE_QUALITY.CARRIED : PRICE_QUALITY.RECONSTRUCTED;
  }
  MARKET.quality[assetId] = sanitizePriceQuality(MARKET.quality[assetId], assetById(assetId));
  MARKET.provenance[assetId] = MARKET.quality[assetId].map(qualityIsReliable);
  MARKET.meta[assetId] = {
    ...(MARKET.meta[assetId] || {}),
    source: cleanDisplayText(source || MARKET.meta[assetId]?.source || '', 24),
    quoteAt: Number.isFinite(Number(quoteAt)) ? Number(quoteAt) : MARKET.meta[assetId]?.quoteAt || null,
    fetchedAt: Number.isFinite(Number(fetchedAt)) ? Number(fetchedAt) : MARKET.meta[assetId]?.fetchedAt || null,
    gridStartDate: localDateKey(MARKET.dates[0]),
    gridEndDate: localDateKey(MARKET.dates[HISTORY_DAYS - 1]),
  };
  return true;
}

function applyObservedSpot(assetId, dateValue, price, { verified = true, source = '', quoteAt = null, fetchedAt = null } = {}) {
  const series = MARKET.prices[assetId];
  const pointDate = typeof dateValue === 'string' && localDateFromKey(dateValue)
    ? localDateFromKey(dateValue)
    : new Date(dateValue);
  const idx = dateToIndexUnclamped(pointDate);
  const value = Number(price);
  if (!series || !Number.isInteger(idx) || idx < 0 || idx >= HISTORY_DAYS || !Number.isFinite(value) || value <= 0) return false;
  if (!MARKET.quality[assetId]) MARKET.quality[assetId] = new Array(HISTORY_DAYS).fill(PRICE_QUALITY.RECONSTRUCTED);
  series[idx] = value;
  MARKET.quality[assetId][idx] = verified ? PRICE_QUALITY.OBSERVED : PRICE_QUALITY.RECONSTRUCTED;
  for (let i = idx + 1; i < HISTORY_DAYS; i++) {
    series[i] = value;
    MARKET.quality[assetId][i] = verified ? PRICE_QUALITY.CARRIED : PRICE_QUALITY.RECONSTRUCTED;
  }
  MARKET.quality[assetId] = sanitizePriceQuality(MARKET.quality[assetId], assetById(assetId));
  MARKET.provenance[assetId] = MARKET.quality[assetId].map(qualityIsReliable);
  MARKET.meta[assetId] = {
    ...(MARKET.meta[assetId] || {}),
    source: cleanDisplayText(source || MARKET.meta[assetId]?.source || '', 24),
    quoteAt: Number.isFinite(Number(quoteAt)) ? Number(quoteAt) : MARKET.meta[assetId]?.quoteAt || null,
    fetchedAt: Number.isFinite(Number(fetchedAt)) ? Number(fetchedAt) : MARKET.meta[assetId]?.fetchedAt || null,
    gridStartDate: localDateKey(MARKET.dates[0]),
    gridEndDate: localDateKey(MARKET.dates[HISTORY_DAYS - 1]),
  };
  return true;
}

/**
 * Haalt maximaal het volledige analysegrid op voor crypto-assets (CoinGecko),
 * sequentieel met pauze i.v.m. rate limits. onProgress(done, total, id).
 */
async function fetchLiveHistory(onProgress) {
  if (!networkConsentEnabled()) return { ok: false, error: 'Externe koersdata staat uit.', updated: [] };
  ensureCurrentMarketGrid();
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
        // Compact en datumvast opslaan: [lokale ISO-datum, koers].
        const compact = data.prices
          .filter(point => Array.isArray(point) && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1])) && Number(point[1]) > 0)
          .map(([ts, p]) => [localDateKey(new Date(Number(ts))), +Number(p).toPrecision(6)]);
        const dedup = new Map(compact);
        if (dedup.size > 30) {
          const sourceAt = Math.max(...data.prices.map(point => Number(point?.[0])).filter(Number.isFinite));
          store[a.id] = {
            at: Date.now(),
            quoteAt: Number.isFinite(sourceAt) ? sourceAt : Date.now(),
            points: [...dedup.entries()],
            src: 'coingecko',
            cg: cgId,
            verified: true,
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

/** Past opgeslagen gedateerde bronhistorie toe op de reeksen in het geheugen. */
function applyLiveHistory() {
  ensureCurrentMarketGrid();
  const store = loadLiveHistory();
  for (const [id, entry] of Object.entries(store)) {
    if (!MARKET.prices[id] || !entry || !Array.isArray(entry.points)) continue;
    if (entry.spotOnly === true) {
      for (const point of entry.points.slice(-10)) {
        applyObservedSpot(id, point?.[0], point?.[1], {
          verified: entry.verified !== false,
          source: entry.src,
          quoteAt: entry.quoteAt,
          fetchedAt: entry.at,
        });
      }
      const asset = assetById(id);
      if (asset) {
        if (asset.type === 'Crypto' && entry.cg) asset.cg = normalizeCoinGeckoId(entry.cg) || asset.cg;
        if (asset.histSource === 'synth' && entry.verified !== false) asset.histSource = 'live';
      }
      continue;
    }
    const points = entry.points
      .filter(point => Array.isArray(point) && localDateFromKey(point[0]) && Number.isFinite(Number(point[1])) && Number(point[1]) > 0)
      .slice(0, 2000)
      .map(([date, price]) => [localDateKey(localDateFromKey(date)), Number(price)]);
    if (!points.length) continue;
    mergeRealHistory(id, points, {
      verified: entry.verified !== false,
      source: entry.src,
      quoteAt: entry.quoteAt,
      fetchedAt: entry.at,
    });
    const a = assetById(id);
    if (a) {
      if (entry.verified !== false) a.histSource = ['yahoo', 'alpha'].includes(entry.src) ? entry.src : 'live';
      if (a.type === 'Crypto' && entry.cg) a.cg = normalizeCoinGeckoId(entry.cg) || a.cg;
    }
  }
}

/** Status van de koershistorie per asset (voor de instellingen-pagina). */
function historyStatus(asset) {
  const coverage = marketCoverage(asset.id);
  const covered = Math.round(coverage * 100);
  const observed = Math.round(observedCoverage(asset.id) * 100);
  const freshness = marketFreshness(asset.id);
  const sourceDate = freshness.observedDate ? ` · bron t/m ${freshness.observedDate}` : ' · geen waargenomen bronkoers';
  const suffix = `${covered}% gedekt · ${observed}% waargenomen${sourceDate}${freshness.fresh ? '' : ' · verouderd'}`;
  const cls = coverage >= ANALYSIS_MIN_COVERAGE && freshness.fresh ? 'up' : 'muted';
  if (asset.histSource === 'live') return { label: `CoinGecko · ${suffix}`, cls };
  if (asset.histSource === 'yahoo') return { label: `Yahoo · ${suffix}`, cls };
  if (asset.histSource === 'alpha') return { label: `Alpha Vantage · ${suffix}`, cls };
  if (asset.histSource === 'import') return { label: `import · ${suffix}`, cls };
  return { label: `gereconstrueerd · ${suffix}`, cls: 'muted' };
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
  ensureCurrentMarketGrid();
  const assets = ASSETS.map(a => ({ ...a }));
  const market = Object.fromEntries(ASSETS.map(a => [a.id, serializeMarketSeries(a.id)]));
  const payload = {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    meta: {
      app: 'Vermogen', kind: 'vermogen-backup', exportedAt: new Date().toISOString(),
      gridStartDate: localDateKey(MARKET.dates[0]), gridEndDate: localDateKey(MARKET.dates[HISTORY_DAYS - 1]),
      note: 'Volledige lokale backup',
    },
    state: {
      transactions: txs,
      assets,
      market,
      watchlist: JSON.parse(localStorage.getItem('vermogen_watchlist_v1') || '[]'),
      alerts: loadAlerts().map(({ value, triggered, ...rule }) => rule),
      dcaPlans: JSON.parse(localStorage.getItem('vermogen_dca_v1') || '[]'),
      watchAssets: JSON.parse(localStorage.getItem('vermogen_watchassets_v1') || '[]'),
      liveHistory: loadLiveHistory(),
      yahooMap: JSON.parse(localStorage.getItem('vermogen_yahoo_v1') || '{}'),
      reconciliation: loadReconciliation(),
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
    const data = await fetchJSONDirect(`https://api.frankfurter.dev/v1/${from}..${to}?base=${currency}&symbols=EUR`);
    if (!data) return null;
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
 * Haalt gedateerde bronhistorie op voor aandelen/ETF's — beste-effort:
 * gebruikt met sleutel eerst Alpha Vantage en probeert anders Yahoo-beurzen.
 */
async function fetchStockHistory(onProgress, assetIds = null) {
  const selected = Array.isArray(assetIds)
    ? new Set(assetIds.map(normalizeAssetId).filter(Boolean))
    : null;
  const wanted = ASSETS.filter(a => a.type !== 'Crypto' && (!selected || selected.has(a.id)));
  if (!networkConsentEnabled()) return { ok: false, updated: [], failed: wanted.map(a => a.id), error: 'Externe koersdata staat uit.' };
  if (!wanted.length) return { ok: false, updated: [], failed: [] };
  ensureCurrentMarketGrid();
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
    const compact = new Map(points.map(([ts, p]) => [localDateKey(new Date(ts)), +p.toPrecision(6)]));
    store[a.id] = {
      at: Date.now(),
      quoteAt: Number.isFinite(sourceAt) ? sourceAt : Date.now(),
      points: [...compact.entries()],
      src: got.source || 'yahoo',
      verified: true,
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

function createBrokerDiagnostics(inputRows) {
  return {
    inputRows,
    ignoredRows: 0,
    rejectedRows: 0,
    assumptionCount: 0,
    rejected: [],
    ignored: [],
    assumptions: [],
  };
}

function rememberBrokerDiagnostic(diagnostics, kind, message) {
  if (kind === 'rejected') diagnostics.rejectedRows++;
  else if (kind === 'assumptions') diagnostics.assumptionCount++;
  else if (kind === 'ignored') diagnostics.ignoredRows++;
  if (diagnostics[kind].length < MAX_IMPORT_DIAGNOSTIC_DETAILS) diagnostics[kind].push(message);
}

function assetIdForImportedIsin(isin) {
  const cleanIsin = cleanDisplayText(isin || '', 16).toUpperCase();
  const existing = ASSETS.find(asset => cleanDisplayText(asset.isin || '', 16).toUpperCase() === cleanIsin);
  return existing?.id || normalizeAssetId(cleanIsin);
}

/** DEGIRO Transactions.csv → genormaliseerde transacties. */
function parseDegiroCSV(objs) {
  const txs = [];
  const diagnostics = createBrokerDiagnostics(objs.length);
  objs.forEach((o, index) => {
    const row = `rij ${index + 2}`;
    const rawDate = getField(o, ['datum', 'date', 'transactiondate']);
    const isin = cleanDisplayText(getField(o, ['isin']) || '', 16).toUpperCase();
    const rawQty = getField(o, ['aantal', 'quantity', 'qty', 'shares']);
    if (!rawDate && !isin && rawQty === undefined) {
      rememberBrokerDiagnostic(diagnostics, 'ignored', `${row}: lege of niet-transactionele rij`);
      return;
    }
    const aantal = parseNum(rawQty);
    if (aantal === 0) {
      rememberBrokerDiagnostic(diagnostics, 'ignored', `${row}: nul-aantal (waarschijnlijke conversieregel)`);
      return; // nulrijen zijn doorgaans CUSIP-/symboolconversies
    }
    if (!isin || aantal === null) {
      rememberBrokerDiagnostic(diagnostics, 'rejected', `${row}: ISIN of geldig aantal ontbreekt`);
      return;
    }
    const parsedDate = parseDateFlexible(rawDate);
    if (!parsedDate) {
      rememberBrokerDiagnostic(diagnostics, 'rejected', `${row}: ongeldige of ontbrekende datum`);
      return;
    }
    const dag = `${parsedDate.getFullYear()}-${String(parsedDate.getMonth() + 1).padStart(2, '0')}-${String(parsedDate.getDate()).padStart(2, '0')}`;
    const waardeEur = Math.abs(parseNum(getField(o, ['waardeeur', 'valueeur', 'totalvalueeur', 'totaleur'])) ?? 0);
    const quotePrice = Math.abs(parseNum(getField(o, ['koers', 'price', 'executionprice'])) || 0);
    const currency = normalizeCurrency(getField(o, ['currency', 'valuta', 'pricecurrency', 'koersvaluta']) || '');
    const explicitFx = parseNum(getField(o, ['eurfx', 'ratetoeur', 'wisselkoersnaareur', 'exchangeratetoeur']));
    let price = 0;
    if (waardeEur > 0) price = waardeEur / Math.abs(aantal);
    else if (quotePrice > 0 && currency === 'EUR') price = quotePrice;
    else if (quotePrice > 0 && currency && currency !== 'EUR' && explicitFx > 0) {
      price = quotePrice * explicitFx;
      rememberBrokerDiagnostic(diagnostics, 'assumptions', `${row}: ${currency}-koers omgerekend met expliciete EUR-factor ${explicitFx}`);
    } else {
      rememberBrokerDiagnostic(diagnostics, 'rejected', `${row}: geen expliciete EUR-waarde of veilige koersomrekening beschikbaar`);
      return;
    }

    const chargeEur = (eurNames, nativeNames, label) => {
      const eur = parseNum(getField(o, eurNames));
      if (eur !== null) return Math.abs(eur);
      const native = parseNum(getField(o, nativeNames));
      if (native === null || native === 0) return 0;
      if (currency === 'EUR') return Math.abs(native);
      if (currency && explicitFx > 0) {
        rememberBrokerDiagnostic(diagnostics, 'assumptions', `${row}: ${label} vanuit ${currency} naar EUR omgerekend`);
        return Math.abs(native * explicitFx);
      }
      return null;
    };
    const fee = chargeEur(
      ['transactiekosteneur', 'transactioncostseur', 'commissioneur', 'feeeur', 'kosteneur'],
      ['transactiekosten', 'transactioncosts', 'commission', 'fee', 'kosten'],
      'transactiekosten',
    );
    const tax = chargeEur(
      ['belastingeur', 'taxeur', 'withholdingtaxeur'],
      ['belasting', 'tax', 'withholdingtax'],
      'belasting',
    );
    if (fee === null || tax === null) {
      rememberBrokerDiagnostic(diagnostics, 'rejected', `${row}: kosten of belasting missen een veilige EUR-omrekening`);
      return;
    }

    const asset = assetIdForImportedIsin(isin);
    if (!asset) {
      rememberBrokerDiagnostic(diagnostics, 'rejected', `${row}: ongeldige ISIN`);
      return;
    }
    const orderId = cleanDisplayText(getField(o, ['orderid', 'transactionid']) || o._raw[o._raw.length - 1] || '', 80);
    txs.push({
      id: orderId ? `dg-${orderId}` : `dg-${dag}-${asset}-${aantal}`,
      day: dag,
      date: new Date(`${dag}T12:00:00`).toISOString(),
      type: aantal < 0 ? 'sell' : 'buy',
      asset,
      assetName: cleanDisplayText(getField(o, ['product', 'instrument', 'name']) || asset, 40),
      qty: Math.abs(aantal),
      price, fee, tax, currency: 'EUR', fxRate: 1, external: true, source: 'degiro',
    });
  });
  return { txs, transfers: 0, diagnostics };
}

/** Bitvavo Volledige geschiedenis.csv → genormaliseerde transacties. */
function parseBitvavoCSV(objs, existingTxs = []) {
  const txs = [];
  let transfers = 0;
  let hasTrades = false;
  const diagnostics = createBrokerDiagnostics(objs.length);
  const hasCashFundingInFile = objs.some(o => {
    const type = String(getField(o, ['type']) || '').toLowerCase();
    return String(getField(o, ['currency', 'valuta']) || '').toUpperCase() === 'EUR'
      && ['deposit', 'withdrawal'].includes(type)
      && Boolean(parseDateFlexible(getField(o, ['date', 'datum', 'timestamp'])))
      && Math.abs(parseNum(getField(o, ['amount', 'aantal'])) || 0) > 0;
  });
  const hasExistingCashFunding = existingTxs.some(tx => tx.source === 'bitvavo'
    && ['deposit', 'withdrawal'].includes(tx.type) && Number(tx.amount) > 0 && !isFutureCalendarDate(tx.date));
  const hasCashFunding = hasCashFundingInFile || hasExistingCashFunding;
  objs.forEach((o, index) => {
    const row = `rij ${index + 2}`;
    const type = cleanDisplayText(getField(o, ['type']) || '', 32).toLowerCase();
    const cur = String(getField(o, ['currency', 'valuta']) || '').toUpperCase();
    const assetId = cur === 'EUR' ? null : normalizeAssetId(cur);
    const rawDate = getField(o, ['date', 'datum', 'timestamp']);
    const rawAmount = getField(o, ['amount', 'aantal', 'quantity']);
    if (!type && !cur && rawDate === undefined && rawAmount === undefined) {
      rememberBrokerDiagnostic(diagnostics, 'ignored', `${row}: lege of niet-transactionele rij`);
      return;
    }
    if (!cur || (cur !== 'EUR' && !assetId)) {
      rememberBrokerDiagnostic(diagnostics, 'rejected', `${row}: ongeldige of ontbrekende valuta`);
      return;
    }
    const parsedDate = parseDateFlexible(rawDate);
    if (!parsedDate) {
      rememberBrokerDiagnostic(diagnostics, 'rejected', `${row}: ongeldige of ontbrekende datum`);
      return;
    }
    const amt = parseNum(rawAmount);
    if (!amt) {
      rememberBrokerDiagnostic(diagnostics, 'rejected', `${row}: bedrag/aantal ontbreekt of is nul`);
      return;
    }
    const day = `${parsedDate.getFullYear()}-${String(parsedDate.getMonth() + 1).padStart(2, '0')}-${String(parsedDate.getDate()).padStart(2, '0')}`;
    const transactionId = cleanDisplayText(getField(o, ['transactionid', 'id']) || '', 80);
    const id = transactionId ? `bv-${transactionId}` : `bv-${rawDate}-${cur}-${amt}`;

    if (cur === 'EUR') {
      if (!['deposit', 'withdrawal'].includes(type)) {
        rememberBrokerDiagnostic(diagnostics, 'ignored', `${row}: EUR-${type || 'regel'} is geen fundingboeking`);
        return;
      }
      transfers++;
      txs.push({
        id, day, date: parsedDate.toISOString(), type: type === 'withdrawal' ? 'withdrawal' : 'deposit',
        amount: Math.abs(amt), currency: 'EUR', fxRate: 1, source: 'bitvavo',
      });
      return;
    }

    const isAssetTransfer = type === 'deposit' || type === 'withdrawal';
    const isReward = ['staking', 'fixed_staking', 'manually_assigned'].includes(type);
    const isTrade = ['buy', 'sell'].includes(type);
    if (!isAssetTransfer && !isReward && !isTrade) {
      rememberBrokerDiagnostic(diagnostics, 'ignored', `${row}: niet-ondersteund Bitvavo-type ${type || 'onbekend'}`);
      return;
    }
    const price = parseNum(getField(o, ['quoteprice', 'price', 'koers'])) || 0;
    if (isTrade && !(price > 0)) {
      rememberBrokerDiagnostic(diagnostics, 'rejected', `${row}: trade mist een geldige EUR-quoteprijs`);
      return;
    }
    const feeAmount = Math.abs(parseNum(getField(o, ['fee', 'kosten'])) || 0);
    const feeCurrency = String(getField(o, ['feecurrency', 'kostenvaluta']) || '').toUpperCase();
    let qty = Math.abs(amt), fee = 0;
    if (isTrade && feeAmount > 0) {
      if (feeCurrency === 'EUR') fee = feeAmount;
      else if (feeCurrency === cur) {
        fee = feeAmount * price;
        qty = type === 'sell' || amt < 0 ? qty + feeAmount : qty - feeAmount;
        if (!(qty > 0)) {
          rememberBrokerDiagnostic(diagnostics, 'rejected', `${row}: crypto-fee is groter dan of gelijk aan het gekochte aantal`);
          return;
        }
        rememberBrokerDiagnostic(diagnostics, 'assumptions', `${row}: ${feeAmount} ${cur} fee in aantal én EUR-kost verwerkt`);
      } else {
        rememberBrokerDiagnostic(diagnostics, 'rejected', `${row}: fee in ${feeCurrency || 'onbekende valuta'} kan niet veilig aan ${cur} worden toegerekend`);
        return;
      }
    }
    const base = {
      id, day, date: parsedDate.toISOString(), asset: assetId,
      assetName: cleanDisplayText(cur, 12).toUpperCase(), qty, price,
      currency: 'EUR', fxRate: 1, source: 'bitvavo',
    };
    if (isAssetTransfer) {
      transfers++;
      txs.push({ ...base, type: type === 'withdrawal' ? 'transfer_out' : 'transfer_in' });
    } else if (isReward) {
      txs.push({
        ...base, type: amt < 0 ? 'transfer_out' : 'transfer_in',
        costBasis: 0, externalValue: 0, source: 'bitvavo-reward',
      });
    } else {
      hasTrades = true;
      txs.push({
        ...base, type: type === 'sell' || amt < 0 ? 'sell' : 'buy',
        fee, tax: 0, external: false,
      });
    }
  });
  if (hasTrades && hasExistingCashFunding && !hasCashFundingInFile) {
    rememberBrokerDiagnostic(diagnostics, 'assumptions', 'EUR-funding uit eerder geïmporteerde Bitvavo-boekingen gebruikt; trades zijn intern afgerekend');
  }
  return { txs, transfers, diagnostics, requiresFunding: hasTrades && !hasCashFunding };
}

/**
 * Importeert een transactie-CSV (DEGIRO of Bitvavo) in merge-modus:
 * bestaande transacties blijven staan, alleen nieuwe rijen komen erbij.
 */
function importTransactionCSV(text, existingTxs, { confirmed = false } = {}) {
  const rows = parseCSVText(text);
  if (rows.length < 2) return { ok: false, error: 'CSV is leeg of onleesbaar.' };
  const header = rows[0].join(',').toLowerCase();
  const objs = csvRowsToObjects(rows);

  let parsed, bron;
  if (header.includes('isin') && (header.includes('order') || header.includes('quantity') || header.includes('aantal'))) { parsed = parseDegiroCSV(objs); bron = 'DEGIRO'; }
  else if (header.includes('quote price') || header.includes('timezone')) { parsed = parseBitvavoCSV(objs, existingTxs); bron = 'Bitvavo'; }
  else return { ok: false, error: 'CSV-formaat niet herkend. Ondersteund: DEGIRO Transactions.csv en Bitvavo Volledige geschiedenis.csv.' };

  if (parsed.requiresFunding) {
    return { ok: false, error: 'Bitvavo-trades zijn niet geïmporteerd: in dit bestand én de bestaande ledger ontbreekt EUR-funding. Importeer eerst of tegelijk de volledige geschiedenis met EUR-stortingen/opnames om dubbele inleg te voorkomen.' };
  }
  if (!parsed.txs.length) {
    const detail = parsed.diagnostics?.rejected?.[0] ? ` Eerste afgewezen rij: ${parsed.diagnostics.rejected[0]}.` : '';
    return { ok: false, error: `Geen veilige transacties gevonden in deze ${bron}-export.${detail}` };
  }
  if (parsed.txs.length > MAX_IMPORT_TRANSACTIONS) return { ok: false, error: `Te veel transacties; maximum is ${MAX_IMPORT_TRANSACTIONS}.` };

  // Dedupe primair op broker-id; zonder betrouwbare id op de volledige
  // economische rij. Twee orders met hetzelfde aantal op dezelfde dag
  // blijven zo bestaan wanneer prijs of richting verschilt.
  const keys = new Set(), ids = new Set();
  const numericKey = value => Number.isFinite(Number(value)) ? Number(value).toFixed(8) : '';
  const txKey = t => [
    t.asset || 'CASH', String(t.date || t.day).slice(0, 10), t.type,
    numericKey(t.qty), numericKey(t.price), numericKey(t.amount), numericKey(t.fee), numericKey(t.tax),
    numericKey(t.externalValue), TRANSFER_TYPES.has(t.type) || t.transfer ? 'transfer' : 'event',
  ].join('|');
  for (const t of existingTxs) {
    keys.add(txKey(t));
    if (t.id) ids.add(t.id);
  }
  const known = new Set(ASSETS.map(a => a.id));

  const added = [], skippedAssets = new Set(), importAssumptions = [...(parsed.diagnostics?.assumptions || [])];
  let dedupe = 0, estimatedTransfers = 0, skippedAssetRows = 0, addedTransfers = 0;
  for (const t of parsed.txs) {
    if (isFutureCalendarDate(t.date)) {
      return { ok: false, error: `${bron}-export bevat een toekomstige boeking (${localDateKey(new Date(t.date))}); import is niet toegepast.` };
    }
    if (t.asset && !known.has(t.asset)) {
      skippedAssets.add(t.asset);
      skippedAssetRows++;
      continue;
    }
    let estimatedTransfer = false;
    if (TRANSFER_TYPES.has(t.type) && t.price === 0 && t.externalValue === undefined) {
      const index = dateToIndexUnclamped(t.date);
      if (!Number.isInteger(index) || index < 0 || index >= HISTORY_DAYS || !isObservedPrice(t.asset, index)) {
        return {
          ok: false,
          error: `${bron}-transfer ${t.id || t.asset} mist een eigen waarde en heeft op ${localDateKey(new Date(t.date))} geen waargenomen bronkoers. Voeg de marktwaarde handmatig toe of importeer eerst betrouwbare historie.`,
        };
      }
      t.price = MARKET.prices[t.asset][index];
      estimatedTransfer = true;
      importAssumptions.push(`${t.id || t.asset}: transfer gewaardeerd op waargenomen bronkoers van ${localDateKey(new Date(t.date))}`);
    }
    const key = txKey(t);
    if ((t.id && ids.has(t.id)) || keys.has(key)) { dedupe++; continue; }
    keys.add(key); if (t.id) ids.add(t.id);
    delete t.day;
    const normalized = normalizeStoredTransaction(t);
    if (!normalized) return { ok: false, error: `Ongeldige ${bron}-boeking aangetroffen (${t.id || t.type}).` };
    added.push(normalized);
    if (estimatedTransfer) estimatedTransfers++;
    if ((TRANSFER_TYPES.has(normalized.type) && normalized.source !== 'bitvavo-reward')
        || ['deposit', 'withdrawal'].includes(normalized.type)) addedTransfers++;
  }
  const beforeInvested = totalInvested(existingTxs);
  const hasBitvavoFunding = bron === 'Bitvavo' && [...existingTxs, ...added].some(tx => tx.source === 'bitvavo'
    && ['deposit', 'withdrawal'].includes(tx.type) && Number(tx.amount) > 0 && !isFutureCalendarDate(tx.date));
  let reclassifiedTrades = 0;
  const safeExisting = existingTxs.map(tx => {
    if (hasBitvavoFunding && tx.source === 'bitvavo' && TRADE_TYPES.has(tx.type) && tx.external === true) {
      reclassifiedTrades++;
      return { ...tx, external: false };
    }
    return tx;
  });
  if (reclassifiedTrades) {
    importAssumptions.push(`${reclassifiedTrades} eerder direct afgerekende Bitvavo-trade(s) als intern geclassificeerd vanwege aanwezige EUR-funding`);
  }
  const merged = [...safeExisting, ...added].sort((a, b) => new Date(a.date) - new Date(b.date));
  const preview = {
    source: `${bron}-CSV`,
    mode: 'merge',
    recognized: parsed.txs.length,
    added: added.length,
    duplicateRows: dedupe,
    assets: [...new Set(parsed.txs.map(tx => tx.asset).filter(Boolean))],
    candidateRows: parsed.txs.length + (parsed.diagnostics?.rejectedRows || 0),
    ignoredRows: parsed.diagnostics?.ignoredRows || 0,
    rejectedRows: (parsed.diagnostics?.rejectedRows || 0) + skippedAssetRows,
    assumptionCount: (parsed.diagnostics?.assumptionCount || 0) + estimatedTransfers + reclassifiedTrades,
    rejected: [
      ...(parsed.diagnostics?.rejected || []),
      ...[...skippedAssets].map(asset => `onbekende asset ${asset}: bijbehorende rij(en) worden overgeslagen`),
    ].slice(0, MAX_IMPORT_DIAGNOSTIC_DETAILS),
    ignored: (parsed.diagnostics?.ignored || []).slice(0, MAX_IMPORT_DIAGNOSTIC_DETAILS),
    assumptions: importAssumptions.slice(0, MAX_IMPORT_DIAGNOSTIC_DETAILS),
    warnings: ['CSV wordt samengevoegd met de bestaande ledger; alleen nieuwe economische rijen worden toegevoegd.'],
  };
  if (!confirmed) return confirmationRequired(preview);
  try { saveTransactions(merged); }
  catch (error) { return { ok: false, error: 'CSV kon niet veilig worden opgeslagen: ' + error.message }; }
  existingTxs.splice(0, existingTxs.length, ...merged.map(tx => normalizeStoredTransaction(tx)));

  return {
    ok: true, bron,
    added: added.length,
    dedupe,
    transfers: addedTransfers,
    estimatedTransfers,
    reclassifiedTrades,
    skippedAssets: [...skippedAssets],
    addedValue: totalInvested(merged) - beforeInvested,
    preview,
  };
}
