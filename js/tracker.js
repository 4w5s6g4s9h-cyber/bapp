const STORAGE_KEY = "portfolio-tracker-v1";
const currency = new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" });
const number = new Intl.NumberFormat("nl-NL", { maximumFractionDigits: 6 });
const pct = new Intl.NumberFormat("nl-NL", { style: "percent", maximumFractionDigits: 2 });
const todayISO = () => new Date().toISOString().slice(0, 10);
const CRYPTO_SNAPSHOT_DATE = "";
const CRYPTO_SNAPSHOT_QUANTITIES = {};
const CRYPTO_SNAPSHOT_PRICES = {};
const DEGIRO_SNAPSHOT_DATE = "";
const DEGIRO_SNAPSHOT_POSITIONS = [];
const COINGECKO_IDS = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  ZK: "zksync",
  OP: "optimism",
  TIA: "celestia",
  ADA: "cardano",
  DOGE: "dogecoin",
  LINK: "chainlink",
  DOT: "polkadot",
  ATOM: "cosmos",
  ARB: "arbitrum",
  BCH: "bitcoin-cash",
  XLM: "stellar",
  VET: "vechain",
  MIOTA: "iota",
  LTC: "litecoin",
  MATIC: "matic-network",
  POL: "polygon-ecosystem-token"
};
const EQUITY_QUOTE_SYMBOLS = {
  VWCE: "VWCE.DE",
  VWRL: "VWRL.AS",
  ISPA: "ISPA.DE",
  WTAI: "WTAI.MI"
};
const YAHOO_CHART_PROXY = "https://api.allorigins.win/raw?url=";
const USD_EUR_RATE_URL = "https://open.er-api.com/v6/latest/USD";
const DEFAULT_UI = {
  positionSearch: "",
  positionSort: "value",
  positionDir: "desc",
  positionSpecialFilter: "all",
  hideSmallPositions: false,
  hideSmallTransactions: false,
  transactionSearch: "",
  transactionTypeFilter: "all",
  transactionSideFilter: "all",
  transactionLimit: "100",
  transactionGroup: "month",
  transactionSpecialFilter: "all",
  sidebarCollapsed: false
};
const DEFAULT_PURCHASE_PLANS = [];

const demoState = {
  settings: {
    defaultHideSmallPositions: false,
    defaultHideSmallTransactions: false
  },
  avgPrices: {},
  avgPriceCorrections: {},
  priceMeta: {
    VWCE: { source: "demo", updatedAt: "2026-06-07T00:00:00.000Z" },
    ASML: { source: "demo", updatedAt: "2026-06-07T00:00:00.000Z" },
    BTC: { source: "demo", updatedAt: "2026-06-07T00:00:00.000Z" },
    ETH: { source: "demo", updatedAt: "2026-06-07T00:00:00.000Z" }
  },
  prices: {
    VWCE: 113.4,
    ASML: 705,
    BTC: 68500,
    ETH: 3220
  },
  transactions: [
    tx("VWCE", "Vanguard FTSE All-World", "ETF", "buy", "2025-01-15", 8, 99.2, 113.4, false),
    tx("VWCE", "Vanguard FTSE All-World", "ETF", "buy", "2025-04-15", 6, 104.8, 113.4, false),
    tx("ASML", "ASML Holding", "Aandeel", "buy", "2025-03-04", 2, 640, 705, false),
    tx("BTC", "Bitcoin", "Crypto", "buy", "2025-02-01", 0.035, 62000, 68500, false),
    tx("ETH", "Ethereum", "Crypto", "buy", "2025-05-10", 0.7, 2850, 3220, false)
  ],
  dcas: [
    {
      id: uid(),
      name: "VWCE maandelijks",
      ticker: "VWCE",
      type: "ETF",
      quantity: 2.2,
      price: 113.4,
      frequency: "monthly",
      startDate: "2025-08-01",
      active: true
    }
  ],
  purchasePlans: structuredClone(DEFAULT_PURCHASE_PLANS),
  watchlist: [],
  targetAllocation: { ETF: 55, Aandeel: 25, Crypto: 20, Gemengd: 0 },
  incomeItems: [],
  alerts: [],
  tags: {},
  salePlans: {},
  snapshots: [],
  processedMonths: [],
  ui: { ...DEFAULT_UI },
  chartRange: 12
};

// --- Thin wrappers around shared functions in portfolioMath.js ---
function parsePriceNumber(value) {
  return window.parsePriceNumber(value);
}
function parsePriceCsv(text) {
  return window.parsePriceCsv(text);
}
function resolveEquityQuoteSymbol(ticker) {
  return window.resolveEquityQuoteSymbol(ticker);
}
function parseYahooChartQuote(payload) {
  return window.parseYahooChartQuote(payload);
}
function convertQuoteToEur(quote, usdEurRate) {
  return window.convertQuoteToEur(quote, { USD_EUR: usdEurRate });
}
function dcaDates(start, frequency, end) {
  return window.dcaDates(start, frequency, end);
}
function priceOf(ticker, fallback) {
  return window.priceOf(state, ticker, fallback);
}
function positions() {
  return window.positions(state);
}
function totals() {
  return window.totals(state);
}
// -----------------------------------------------------------------

let state = loadState();
let valueChartHoverIndex = null;
let allocationHoverIndex = null;
let allocationSegments = [];
autoFixDegiroIfNeeded();
autoFixCryptoIfNeeded();
applyDcaPlans();
applySidebarState();
render();
renderDcaAssetDraft();

document.querySelectorAll(".nav-btn").forEach((button) => {
  button.addEventListener("click", () => switchView(button.dataset.view));
});

document.getElementById("sidebarToggle").addEventListener("click", toggleSidebar);

document.querySelectorAll("[data-range]").forEach((button) => {
  button.addEventListener("click", () => {
    state.chartRange = Number(button.dataset.range);
    persist();
    render();
  });
});

document.querySelectorAll("[data-mover-mode]").forEach((button) => {
  button.addEventListener("click", () => {
    state.ui.analysisMoverMode = button.dataset.moverMode;
    persist();
    render();
  });
});

document.addEventListener("input", (event) => {
  if (!event.target.matches("[data-analysis-sim]")) return;
  state.ui[event.target.dataset.analysisSim] = Number(event.target.value);
  persist();
  render();
});

document.getElementById("addTxBtn").addEventListener("click", openModal);
document.getElementById("refreshPricesBtn").addEventListener("click", refreshAssetPrices);
document.getElementById("addDcaAssetBtn").addEventListener("click", addDcaAssetDraft);
document.getElementById("pricesBtn").addEventListener("click", openPricesModal);
document.getElementById("closeModal").addEventListener("click", closeModal);
document.getElementById("closePricesModal").addEventListener("click", closePricesModal);
document.getElementById("closePositionModal").addEventListener("click", closePositionModal);
document.getElementById("txModal").addEventListener("click", (event) => {
  if (event.target.id === "txModal") closeModal();
});
document.getElementById("pricesModal").addEventListener("click", (event) => {
  if (event.target.id === "pricesModal") closePricesModal();
});
document.getElementById("positionModal").addEventListener("click", (event) => {
  if (event.target.id === "positionModal") closePositionModal();
});

["positionSearch", "positionSort", "positionDir", "transactionSearch", "transactionTypeFilter", "transactionSideFilter", "transactionLimit", "transactionGroup"].forEach((id) => {
  const control = document.getElementById(id);
  if (!control) return;
  control.addEventListener("input", (event) => {
    state.ui[id] = event.target.value;
    if (id === "transactionSearch" || id === "transactionTypeFilter") state.ui.transactionSpecialFilter = "all";
    persist();
    render();
  });
});
document.getElementById("defaultHideSmall").addEventListener("change", (event) => {
  state.settings.defaultHideSmallPositions = event.target.checked;
  state.ui.hideSmallPositions = event.target.checked;
  persist();
  render();
});
document.getElementById("defaultHideSmallTransactions").addEventListener("change", (event) => {
  state.settings.defaultHideSmallTransactions = event.target.checked;
  state.ui.hideSmallTransactions = event.target.checked;
  persist();
  render();
});
document.getElementById("removeSmallPositionsBtn").addEventListener("click", removeSmallPositions);
["simMonthly", "simReturn", "simGoal"].forEach((id) => {
  document.getElementById(id).addEventListener("input", (event) => {
    state.ui[id] = event.target.value;
    persist();
    render();
  });
});

document.getElementById("txForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  state.transactions.push(tx(
    data.ticker.toUpperCase(),
    data.name,
    data.type,
    data.side,
    data.date,
    parsePriceNumber(data.quantity),
    parsePriceNumber(data.price),
    parsePriceNumber(data.currentPrice),
    false
  ));
  state.prices = state.prices || {};
  state.prices[data.ticker.toUpperCase()] = parsePriceNumber(data.currentPrice);
  state.priceMeta = state.priceMeta || {};
  state.priceMeta[data.ticker.toUpperCase()] = { source: "Handmatig", updatedAt: new Date().toISOString() };
  persist();
  event.target.reset();
  closeModal();
  render();
});

document.getElementById("dcaForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  const assets = parseDcaAssets(data.assets, data.type);
  if (!assets.length) {
    alert("Voeg minimaal één assetregel toe, bijvoorbeeld: VWCE,1,ETF");
    return;
  }
  state.dcas.push({
    id: uid(),
    name: data.name,
    type: data.type,
    ticker: assets[0]?.ticker || "",
    quantity: assets[0]?.quantity || 0,
    price: assets[0] ? currentAssetPrice(assets[0].ticker, 0) : 0,
    assets,
    frequency: data.frequency,
    startDate: data.startDate,
    active: data.active === "true"
  });
  state.prices = state.prices || {};
  state.priceMeta = state.priceMeta || {};
  assets.forEach((asset) => {
    const price = currentAssetPrice(asset.ticker, 0);
    if (price > 0 && !state.prices[asset.ticker]) {
      state.prices[asset.ticker] = price;
      state.priceMeta[asset.ticker] = { source: "DCA-plan", updatedAt: new Date().toISOString() };
    }
  });
  applyDcaPlans();
  persist();
  event.target.reset();
  event.target.startDate.value = todayISO();
  setDcaDraftAssets([]);
  render();
});

document.getElementById("pricesForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  state.transactions = state.transactions.map((item) => {
    const price = parsePriceNumber(data[`price-${item.ticker}`]);
    return Number.isFinite(price) && price > 0 ? { ...item, currentPrice: price } : item;
  });
  state.prices = state.prices || {};
  state.priceMeta = state.priceMeta || {};
  const updatedAt = new Date().toISOString();
  positions().forEach((item) => {
    const price = parsePriceNumber(data[`price-${item.ticker}`]);
    if (Number.isFinite(price) && price > 0) {
      state.prices[item.ticker] = price;
      state.priceMeta[item.ticker] = { source: "Handmatig", updatedAt };
    }
  });
  persist();
  closePricesModal();
  render();
});

document.getElementById("exportBtn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `portfolio-tracker-${todayISO()}.json`;
  link.click();
  URL.revokeObjectURL(url);
});

document.getElementById("importBtn").addEventListener("click", () => document.getElementById("fileInput").click());
document.getElementById("fileInput").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  const imported = JSON.parse(await file.text());
  createBackup(`voor import ${file.name}`);
  state = normalizeState(imported);
  state.meta = { ...(state.meta || {}), lastImportAt: new Date().toISOString(), lastImportFile: file.name };
  sanitizeCryptoAdjustments();
  applyDcaPlans();
  persist();
  render();
  showImportStatus(file.name);
  event.target.value = "";
});
document.getElementById("priceFileInput").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const updates = parsePriceCsv(await file.text());
    const result = applyPriceUpdates(updates, `CSV ${file.name}`);
    openPricesModal();
    showPriceStatus(`${result.updated} prijzen bijgewerkt uit ${esc(file.name)}.`);
  } catch (error) {
    showPriceStatus(error.message || "Prijsbestand kon niet worden gelezen.", true);
  }
  event.target.value = "";
});
document.getElementById("resetAllDataBtn").addEventListener("click", resetAllData);
document.getElementById("watchlistForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  const ticker = data.ticker.toUpperCase();
  state.watchlist = [
    ...(state.watchlist || []).filter((item) => item.ticker !== ticker),
    {
      id: uid(),
      ticker,
      name: data.name,
      type: data.type,
      currentPrice: parsePriceNumber(data.currentPrice),
      targetPrice: parsePriceNumber(data.targetPrice),
      note: data.note || "",
      createdAt: new Date().toISOString()
    }
  ];
  persist();
  event.target.reset();
  render();
});
document.getElementById("allocationForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  state.targetAllocation = normalizeTargetAllocation(data);
  persist();
  render();
});
document.getElementById("incomeForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  state.incomeItems = [...(state.incomeItems || []), {
    id: uid(),
    date: data.date,
    ticker: data.ticker.toUpperCase(),
    kind: data.kind,
    amount: parsePriceNumber(data.amount),
    tax: parsePriceNumber(data.tax),
    source: data.source || ""
  }];
  persist();
  event.target.reset();
  event.target.date.value = todayISO();
  render();
});
document.getElementById("tagForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  const ticker = data.ticker.toUpperCase();
  state.tags = { ...(state.tags || {}), [ticker]: { tags: data.tags || "", thesis: data.thesis || "", risk: data.risk || "" } };
  persist();
  render();
});
document.getElementById("salePlanForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  const ticker = data.ticker.toUpperCase();
  state.salePlans = { ...(state.salePlans || {}), [ticker]: { targetPrice: parsePriceNumber(data.targetPrice), stopPrice: parsePriceNumber(data.stopPrice), note: data.note || "" } };
  persist();
  render();
});
document.getElementById("alertForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  state.alerts = [...(state.alerts || []), {
    id: uid(),
    ticker: data.ticker.toUpperCase(),
    direction: data.direction,
    price: parsePriceNumber(data.price),
    note: data.note || ""
  }];
  persist();
  event.target.reset();
  render();
});
document.getElementById("taxYear").addEventListener("input", (event) => {
  state.ui.taxYear = event.target.value;
  persist();
  render();
});

function tx(ticker, name, type, side, date, quantity, price, currentPrice, auto, dcaId = null) {
  return {
    id: uid(),
    ticker,
    name,
    type,
    side,
    date,
    quantity,
    price,
    currentPrice,
    auto,
    dcaId
  };
}

function uid() {
  return typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    const copy = defaultImportState() || structuredClone(demoState);
    document.addEventListener("DOMContentLoaded", () => {
      const dcaDate = document.querySelector("#dcaForm [name=startDate]");
      const txDate = document.querySelector("#txForm [name=date]");
      const incomeDate = document.querySelector("#incomeForm [name=date]");
      const taxYear = document.getElementById("taxYear");
      if (dcaDate) dcaDate.value = todayISO();
      if (txDate) txDate.value = todayISO();
      if (incomeDate) incomeDate.value = todayISO();
      if (taxYear) taxYear.value = new Date().getFullYear();
    });
    return copy;
  }
  try {
    const parsed = JSON.parse(raw);
    const upgraded = upgradedBundledImport(parsed);
    if (upgraded) return upgraded;
    return normalizeState(parsed);
  } catch {
    return defaultImportState() || structuredClone(demoState);
  }
}

function defaultImportState() {
  return window.DEFAULT_IMPORT_STATE ? normalizeState(structuredClone(window.DEFAULT_IMPORT_STATE)) : null;
}

function upgradedBundledImport(parsed) {
  const bundled = window.DEFAULT_IMPORT_STATE;
  if (!bundled || !parsed || typeof parsed !== "object") return null;
  const currentVersion = parsed.meta?.sourceVersion || "";
  const bundledVersion = bundled.meta?.sourceVersion || "";
  const hasExcelHistory = Array.isArray(parsed.transactions) && parsed.transactions.some((item) => item.source === "Bitvavo Excel");
  if (currentVersion === bundledVersion) return null;
  if (hasExcelHistory) {
    const bundledAvg = bundled.avgPrices && typeof bundled.avgPrices === "object" ? bundled.avgPrices : {};
    const parsedAvg = parsed.avgPrices && typeof parsed.avgPrices === "object" ? parsed.avgPrices : {};
    const missingAvg = Object.keys(bundledAvg).some((ticker) => !Number(parsedAvg[ticker]));
    if (!missingAvg) return null;
    const upgraded = normalizeState({
      ...parsed,
      avgPrices: { ...bundledAvg, ...parsedAvg },
      meta: { ...(parsed.meta || {}), sourceVersion: bundledVersion }
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(upgraded));
    return upgraded;
  }
  const looksLikeOldSnapshot = Array.isArray(parsed.transactions) && parsed.transactions.some((item) => /Bitvavo screenshot|Crypto screenshot reconciliation/i.test(item.source || ""));
  if (!looksLikeOldSnapshot) return null;
  try {
    localStorage.setItem("portfolio-tracker-backup-before-excel-upgrade", JSON.stringify({
      reason: "voor automatische Bitvavo Excel upgrade",
      createdAt: new Date().toISOString(),
      state: parsed
    }));
  } catch {
    // Best effort backup; failing here should not block the corrected import.
  }
  const upgraded = normalizeState(structuredClone(bundled));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(upgraded));
  return upgraded;
}

function emptyState() {
  return {
    settings: { defaultHideSmallPositions: false, defaultHideSmallTransactions: false },
    avgPrices: {},
    avgPriceCorrections: {},
    priceMeta: {},
    prices: {},
    transactions: [],
    dcas: [],
    purchasePlans: structuredClone(DEFAULT_PURCHASE_PLANS),
    watchlist: [],
    targetAllocation: { ETF: 55, Aandeel: 25, Crypto: 20, Gemengd: 0 },
    incomeItems: [],
    alerts: [],
    tags: {},
    salePlans: {},
    snapshots: [],
    processedMonths: [],
    ui: { ...DEFAULT_UI },
    chartRange: 12,
    notes: [],
    meta: {}
  };
}

function normalizeState(input) {
  const settings = { defaultHideSmallPositions: false, defaultHideSmallTransactions: false, ...(input.settings || {}) };
  const prices = input.prices && typeof input.prices === "object" ? input.prices : {};
  const priceMeta = input.priceMeta && typeof input.priceMeta === "object" ? { ...input.priceMeta } : {};
  const fallbackUpdatedAt = input.meta?.lastImportAt || input.meta?.generatedAt || new Date().toISOString();
  Object.keys(prices).forEach((ticker) => {
    if (!priceMeta[ticker]) priceMeta[ticker] = { source: "Import", updatedAt: fallbackUpdatedAt };
  });
  return {
    settings,
    avgPrices: input.avgPrices && typeof input.avgPrices === "object" ? input.avgPrices : {},
    avgPriceCorrections: input.avgPriceCorrections && typeof input.avgPriceCorrections === "object" ? input.avgPriceCorrections : {},
    priceMeta,
    prices,
    transactions: Array.isArray(input.transactions) ? input.transactions : [],
    dcas: Array.isArray(input.dcas) ? input.dcas.map((plan) => ({ ...plan, assets: normalizeDcaAssets(plan) })) : [],
    purchasePlans: normalizePurchasePlans(input.purchasePlans),
    watchlist: Array.isArray(input.watchlist) ? input.watchlist : [],
    targetAllocation: normalizeTargetAllocation(input.targetAllocation),
    incomeItems: Array.isArray(input.incomeItems) ? input.incomeItems : [],
    alerts: Array.isArray(input.alerts) ? input.alerts : [],
    tags: input.tags && typeof input.tags === "object" ? input.tags : {},
    salePlans: input.salePlans && typeof input.salePlans === "object" ? input.salePlans : {},
    snapshots: Array.isArray(input.snapshots) ? input.snapshots : [],
    processedMonths: Array.isArray(input.processedMonths) ? input.processedMonths : [],
    ui: {
      ...DEFAULT_UI,
      hideSmallPositions: settings.defaultHideSmallPositions,
      hideSmallTransactions: settings.defaultHideSmallTransactions,
      ...(input.ui || {})
    },
    chartRange: Number(input.chartRange) || 12,
    notes: Array.isArray(input.notes) ? input.notes : [],
    meta: input.meta && typeof input.meta === "object" ? input.meta : {}
  };
}

function normalizePurchasePlans(input) {
  const source = Array.isArray(input) && input.length ? input : DEFAULT_PURCHASE_PLANS;
  return source.map((plan, index) => ({
    id: plan.id || `purchase-plan-${index}`,
    name: plan.name || "Maandplan",
    broker: plan.broker || "Handmatig",
    tickers: Array.isArray(plan.tickers) && plan.tickers.length ? plan.tickers.map((ticker) => String(ticker).toUpperCase()) : [String(plan.ticker || "VWCE").toUpperCase()],
    type: plan.type || "Gemengd",
    amount: Number(plan.amount) || 0,
    frequency: plan.frequency || "monthly",
    active: plan.active !== false
  }));
}

function normalizeDcaAssets(plan) {
  if (Array.isArray(plan.assets) && plan.assets.length) {
    return plan.assets.map((asset) => ({
      ticker: String(asset.ticker || "").toUpperCase(),
      name: asset.name || "",
      type: asset.type || plan.type || "ETF",
      quantity: Number(asset.quantity) || 0
    })).filter((asset) => asset.ticker && asset.quantity > 0);
  }
  const ticker = String(plan.ticker || "").toUpperCase();
  const quantity = dcaPlanQuantity(plan);
  return ticker && quantity > 0 ? [{ ticker, name: plan.name || ticker, type: plan.type || "ETF", quantity }] : [];
}

function parseDcaAssets(text, fallbackType) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [ticker, quantity, type] = line.split(/[;,]/).map((part) => part.trim());
      return {
        ticker: String(ticker || "").toUpperCase(),
        name: String(ticker || "").toUpperCase(),
        quantity: parsePriceNumber(quantity),
        type: type || fallbackType || "ETF"
      };
    })
    .filter((asset) => asset.ticker && Number.isFinite(asset.quantity) && asset.quantity > 0);
}

function dcaAssetsToText(assets) {
  return assets.map((asset) => `${asset.ticker},${formatCsvNumber(asset.quantity)},${asset.type}`).join("\n");
}

function dcaDraftAssets() {
  return parseDcaAssets(document.querySelector("#dcaForm [name=assets]")?.value || "", document.getElementById("dcaAssetType")?.value || "ETF");
}

function setDcaDraftAssets(assets) {
  const input = document.querySelector("#dcaForm [name=assets]");
  if (input) input.value = dcaAssetsToText(assets);
  renderDcaAssetDraft();
}

function addDcaAssetDraft() {
  const tickerInput = document.getElementById("dcaAssetTicker");
  const quantityInput = document.getElementById("dcaAssetQuantity");
  const typeInput = document.getElementById("dcaAssetType");
  const ticker = tickerInput.value.trim().toUpperCase();
  const quantity = parsePriceNumber(quantityInput.value);
  const type = typeInput.value || "ETF";
  if (!ticker || !Number.isFinite(quantity) || quantity <= 0) return;
  const assets = dcaDraftAssets().filter((asset) => asset.ticker !== ticker);
  assets.push({ ticker, name: ticker, quantity, type });
  setDcaDraftAssets(assets);
  tickerInput.value = "";
  quantityInput.value = "";
  tickerInput.focus();
}

function renderDcaAssetDraft() {
  const target = document.getElementById("dcaAssetDraftList");
  if (!target) return;
  const assets = dcaDraftAssets();
  target.innerHTML = assets.length
    ? assets.map((asset) => `<div class="asset-draft-row">
      <strong>${esc(asset.ticker)}</strong>
      <span>${number.format(asset.quantity)} stuks</span>
      <span>${esc(asset.type)} · ${currency.format(currentAssetPrice(asset.ticker, 0))}</span>
      <button class="icon-btn danger" type="button" title="Verwijder" onclick="removeDcaAssetDraft('${escAttr(asset.ticker)}')">×</button>
    </div>`).join("")
    : `<div class="empty">Nog geen assets toegevoegd.</div>`;
}

function normalizeTargetAllocation(input) {
  const defaults = { ETF: 55, Aandeel: 25, Crypto: 20, Gemengd: 0 };
  const source = input && typeof input === "object" ? input : {};
  return Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, Number(source[key] ?? value) || 0]));
}

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function resetAllData() {
  const confirmed = confirm("Weet je zeker dat je alle lokale app-data wilt wissen? Dit verwijdert transacties, DCA-plannen, prijzen en gemiddelde prijs-correcties uit deze browser.");
  if (!confirmed) return;
  createBackup("voor reset");
  Object.keys(localStorage)
    .filter((key) => key.startsWith("portfolio-tracker"))
    .filter((key) => !key.startsWith("portfolio-tracker-backup"))
    .forEach((key) => localStorage.removeItem(key));
  state = emptyState();
  persist();
  render();
  switchView("settings");
  showImportStatus("alle lokale app-data gewist");
}

function createBackup(reason) {
  try {
    const payload = {
      reason,
      createdAt: new Date().toISOString(),
      state
    };
    localStorage.setItem("portfolio-tracker-backup-latest", JSON.stringify(payload));
  } catch {
    // Backups are best-effort because localStorage can be full or unavailable.
  }
}

function restoreBackup() {
  const raw = localStorage.getItem("portfolio-tracker-backup-latest");
  if (!raw) {
    showImportStatus("geen backup gevonden");
    return;
  }
  const backup = JSON.parse(raw);
  state = normalizeState(backup.state || {});
  persist();
  render();
  switchView("settings");
  showImportStatus(`backup hersteld (${backup.reason || "onbekend"})`);
}

function sanitizeCryptoAdjustments() {
  const visibleCryptoTickers = new Set(Object.keys(CRYPTO_SNAPSHOT_QUANTITIES));
  state.transactions = state.transactions.filter((item) => {
    if (item.source !== "Crypto screenshot reconciliation") return true;
    return visibleCryptoTickers.has(item.ticker);
  });
  removeZeroCryptoTargets();
}

function removeZeroCryptoTargets() {
  const visibleCryptoTickers = new Set(Object.keys(CRYPTO_SNAPSHOT_QUANTITIES));
  state.transactions = state.transactions.filter((item) => item.type !== "Crypto" || visibleCryptoTickers.has(item.ticker));
  Object.keys(state.prices || {}).forEach((ticker) => {
    if (!visibleCryptoTickers.has(ticker) && COINGECKO_IDS[ticker]) delete state.prices[ticker];
  });
  Object.keys(state.priceMeta || {}).forEach((ticker) => {
    if (!visibleCryptoTickers.has(ticker) && COINGECKO_IDS[ticker]) delete state.priceMeta[ticker];
  });
  Object.keys(state.avgPrices || {}).forEach((ticker) => {
    if (!visibleCryptoTickers.has(ticker) && COINGECKO_IDS[ticker]) delete state.avgPrices[ticker];
  });
}

function applyDcaPlans() {
  const manual = state.transactions.filter((item) => !item.auto);
  const generated = [];
  state.dcas.filter((plan) => plan.active).forEach((plan) => {
    const dates = dcaDates(plan.startDate, plan.frequency, todayISO());
    const assets = normalizeDcaAssets(plan);
    dates.forEach((date) => {
      assets.forEach((asset) => {
        const price = priceOf(asset.ticker, currentAssetPrice(asset.ticker, Number(plan.price) || 0));
        generated.push(tx(
          asset.ticker,
          asset.name || asset.ticker,
          asset.type || plan.type,
          "buy",
          date,
          asset.quantity,
          price,
          price,
          true,
          plan.id
        ));
      });
    });
  });
  state.transactions = [...manual, ...generated].sort((a, b) => new Date(b.date) - new Date(a.date));
}

function dcaPlanQuantity(plan) {
  const assets = Array.isArray(plan.assets) ? plan.assets : [];
  if (assets.length) return assets.reduce((sum, asset) => sum + Number(asset.quantity || 0), 0);
  const quantity = Number(plan.quantity);
  if (Number.isFinite(quantity) && quantity > 0) return quantity;
  const amount = Number(plan.amount);
  const price = Number(plan.price);
  return Number.isFinite(amount) && Number.isFinite(price) && price > 0 ? amount / price : 0;
}

function dcaPlanValue(plan) {
  const assets = normalizeDcaAssets(plan);
  if (assets.length) {
    return assets.reduce((sum, asset) => sum + asset.quantity * currentAssetPrice(asset.ticker, Number(plan.price) || 0), 0);
  }
  return dcaPlanQuantity(plan) * (Number(plan.price) || 0);
}

function applySidebarState() {
  const collapsed = Boolean(state.ui.sidebarCollapsed);
  const app = document.querySelector(".app");
  const toggle = document.getElementById("sidebarToggle");
  app.classList.toggle("sidebar-collapsed", collapsed);
  toggle.setAttribute("aria-expanded", String(!collapsed));
  toggle.setAttribute("aria-label", collapsed ? "Paneel uitklappen" : "Paneel inklappen");
  toggle.title = collapsed ? "Paneel uitklappen" : "Paneel inklappen";
}

function toggleSidebar() {
  state.ui.sidebarCollapsed = !state.ui.sidebarCollapsed;
  applySidebarState();
  persist();
}

function switchView(view) {
  document.querySelectorAll(".nav-btn").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  document.querySelectorAll(".view").forEach((section) => section.classList.toggle("active", section.id === view));
  const titles = {
    dashboard: ["Dashboard", "Waarde, rendement en spreiding van je portefeuille."],
    positions: ["Posities", "Bekijk je holdings, gemiddelde prijs en winst/verlies."],
    transactions: ["Transacties", "Alle aankopen, verkopen en DCA-regels op één plek."],
    analysis: ["Analyse", "Verdieping op rendement, spreiding, concentratie en transactiegedrag."],
    plans: ["Plannen", "Maandworkflow, scenario's, risicoscore en actievoorstellen."],
    audit: ["Controle", "Datakwaliteit, importbronnen en correctieregels."],
    dca: ["DCA", "Plan automatische periodieke aankopen in."],
    watchlist: ["Watchlist", "Kandidaten, koopzones en koerssignalen."],
    allocation: ["Allocatie", "Doelweging, afwijkingen en rebalance-acties."],
    income: ["Inkomsten", "Dividend, staking en belastingrapportage."],
    strategy: ["Strategie", "Tags, thesis, verkoopplannen, alerts en snapshots."],
    settings: ["Instellingen", "Import, export, koersupdates en opschonen."]
  };
  document.getElementById("pageTitle").textContent = titles[view][0];
  document.getElementById("pageSubtitle").textContent = titles[view][1];
  requestAnimationFrame(() => drawChartsForView(view));
}

function render() {
  const total = totals();
  document.querySelectorAll("[data-range]").forEach((button) => {
    button.classList.toggle("active", Number(button.dataset.range) === Number(state.chartRange || 12));
  });
  renderMetrics(total);
  renderPriceStatusCards(total);
  renderPositions(total.list);
  renderTransactions();
  renderDcaCards();
  renderDcaSuggestions(total);
  renderInsights(total);
  renderValueChartSummary(total);
  renderAllocationLegend(total.list);
  renderAnalysis(total);
  renderPlans(total);
  renderWatchlist(total);
  renderAllocation(total);
  renderIncome(total);
  renderStrategy(total);
  renderAudit(total);
  renderSettings();
  syncControls();
  drawChartsForView(activeView());
  persist();
}

function activeView() {
  return document.querySelector(".view.active")?.id || "dashboard";
}

function drawChartsForView(view) {
  const total = totals();
  if (view === "dashboard") {
    drawLineChart(document.getElementById("valueChart"), portfolioHistory(Number(state.chartRange || 12)));
    drawAllocationChart(document.getElementById("allocationChart"), total.list);
  }
  if (view === "analysis") {
    const visible = total.list.filter((item) => item.value >= 1);
    drawTopHoldingsChart(document.getElementById("topHoldingsChart"), visible);
    drawTypePerformanceChart(document.getElementById("typePerformanceChart"), analysisByType(visible));
  }
}

function renderMetrics(total) {
  const activeDca = state.dcas.filter((plan) => plan.active).length;
  document.getElementById("metrics").innerHTML = [
    metric("Actuele waarde", currency.format(total.value), `${total.list.length} open posities`),
    metric("Ingelegd", currency.format(total.cost), "Inclusief automatische DCA's"),
    metric("Rendement", `${currency.format(total.gain)} (${pct.format(total.gainPct)})`, total.gain >= 0 ? "Boven aankoopwaarde" : "Onder aankoopwaarde"),
    metric("Maandelijkse DCA", currency.format(total.dcaMonthly), `${activeDca} actief`)
  ].join("");
}

function metric(label, value, note) {
  return `<article class="metric"><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`;
}

function renderPriceStatusCards(total) {
  const diagnostics = portfolioDiagnostics(total);
  const gainTone = total.gain >= 0 ? "good" : "bad";
  const concentrationTone = diagnostics.topThreeWeight > .7 ? "warn" : "good";
  const priceTone = diagnostics.priceInfo.stale.length ? "warn" : "good";
  const dcaTone = total.dcaMonthly > 0 ? "info" : "warn";
  const rows = [
    healthTile("Rendement", `${currency.format(total.gain)} · ${pct.format(total.gainPct)}`, total.gain >= 0 ? "Boven aankoopwaarde" : "Onder aankoopwaarde", gainTone),
    healthTile("Top 3 gewicht", pct.format(diagnostics.topThreeWeight), concentrationTone === "warn" ? "Concentratie bewaken" : "Spreiding oogt gezond", concentrationTone),
    healthTile("Koersdata", diagnostics.priceInfo.stale.length ? `${diagnostics.priceInfo.stale.length} oud` : "Recent", diagnostics.priceInfo.liveCryptoAt ? `Crypto live ${dateNl(diagnostics.priceInfo.liveCryptoAt.slice(0, 10))}` : "Import/handmatig", priceTone),
    healthTile("DCA-status", total.dcaMonthly ? currency.format(total.dcaMonthly) : "Geen actief plan", total.dcaMonthly ? "Automatische maandinleg" : "Plan nog niet actief", dcaTone)
  ].join("");
  ["dashboardPriceStatus", "positionsPriceStatus"].forEach((id) => {
    const target = document.getElementById(id);
    if (!target) return;
    target.innerHTML = rows;
    target.hidden = false;
  });
}

function healthTile(label, value, note, tone = "info") {
  const color = tone === "good" ? "var(--good)" : tone === "bad" ? "var(--bad)" : tone === "warn" ? "var(--warn)" : "var(--accent)";
  const bg = tone === "good" ? "var(--good-soft)" : tone === "bad" ? "var(--bad-soft)" : tone === "warn" ? "var(--warn-soft)" : "var(--info-soft)";
  return `<article class="status-tile" style="--tile-color:${color};--tile-bg:${bg}">
    <span>${esc(label)}</span>
    <strong>${esc(value)}</strong>
    <small class="muted">${esc(note)}</small>
  </article>`;
}

function renderValueChartSummary(total) {
  const list = total.list.filter((item) => item.value >= 1);
  const biggest = list[0];
  const crypto = list.filter((item) => item.type === "Crypto").reduce((sum, item) => sum + item.value, 0);
  document.getElementById("valueChartSummary").innerHTML = [
    `<div><span>Waarde</span><strong>${currency.format(total.value)}</strong></div>`,
    `<div><span>Rendement</span><strong class="${total.gain >= 0 ? "gain" : "loss"}">${currency.format(total.gain)} · ${pct.format(total.gainPct)}</strong></div>`,
    `<div><span>Grootste positie</span><strong>${biggest ? `${esc(biggest.ticker)} · ${pct.format(biggest.value / Math.max(total.value, 1))}` : "Geen"}</strong></div>`,
    `<div><span>Crypto-weging</span><strong>${pct.format(crypto / Math.max(total.value, 1))}</strong></div>`
  ].join("");
}

function renderAllocationLegend(list) {
  const grouped = groupByType(list.filter((item) => item.value >= 1));
  const total = grouped.reduce((sum, item) => sum + item.value, 0);
  const colors = chartColors();
  document.getElementById("allocationLegend").innerHTML = grouped.map((item, index) => `
    <button class="legend-btn" onclick="filterPositionsByType('${escAttr(item.type)}')">
      <span class="legend-dot" style="background:${colors[index % colors.length]}"></span>
      <strong>${esc(item.type)}</strong>
      <span>${currency.format(item.value)} · ${pct.format(item.value / Math.max(total, 1))}</span>
    </button>
  `).join("");
}

window.filterPositionsByType = (type) => {
  state.ui.positionSearch = type;
  state.ui.positionSpecialFilter = "all";
  switchView("positions");
  persist();
  render();
};

function renderPositions(list) {
  const target = document.getElementById("positionsTable");
  const filtered = sortedPositions(filteredPositions(list));
  renderPositionChips(list, filtered);
  if (!filtered.length) {
    target.innerHTML = `<div class="empty">Nog geen posities.</div>`;
    return;
  }
  target.innerHTML = `<table class="data-table positions-table">
    <thead><tr>
      <th class="asset-col">${sortHeader("Asset", "ticker")}</th>
      <th class="num-col quantity-col">${sortHeader("Aantal", "quantity")}</th>
      <th class="num-col price-col">${sortHeader("Gem. prijs", "avgPrice")}</th>
      <th class="num-col price-col">${sortHeader("Actuele prijs", "currentPrice")}</th>
      <th class="num-col value-col">${sortHeader("Waarde", "value")}</th>
      <th class="num-col result-col">${sortHeader("Rendement", "gainPct")}</th>
    </tr></thead>
    <tbody>${filtered.map((item) => `<tr class="clickable-row" onclick="openPosition('${escAttr(item.ticker)}')">
      <td class="asset-col">${assetCell(item)}</td>
      <td class="num-col quantity-col">${number.format(item.quantity)}</td>
      <td class="num-col price-col">${currency.format(item.avgPrice)}</td>
      <td class="num-col price-col">${priceInline(item)}</td>
      <td class="num-col value-col">${positionValueCell(item, list)}</td>
      <td class="num-col result-col">${resultPill(item.gain, item.gainPct)}</td>
    </tr>`).join("")}</tbody>
  </table>`;
}

function renderTransactions() {
  const target = document.getElementById("transactionsTable");
  const filtered = filteredTransactions();
  renderTransactionChips(filteredTransactions(true));
  if (!filtered.length) {
    target.innerHTML = `<div class="empty">Nog geen transacties.</div>`;
    return;
  }
  const limit = state.ui.transactionLimit === "all" ? filtered.length : Number(state.ui.transactionLimit || 100);
  const visible = filtered.slice(0, limit);
  const rows = transactionRows(visible);
  target.innerHTML = `<table class="data-table transactions-table">
    <thead><tr>
      <th class="date-col">Datum</th>
      <th class="asset-col">Asset</th>
      <th class="type-col">Actie</th>
      <th class="num-col">Aantal</th>
      <th class="num-col">Prijs</th>
      <th class="num-col">Totaal</th>
      <th class="action-col"></th>
    </tr></thead>
    <tbody>${rows.map((row) => row.group ? `<tr class="group-row"><td colspan="7"><span>${esc(row.label)}</span><small>${esc(row.summary)}</small></td></tr>` : transactionRowHtml(row.item)).join("")}</tbody>
  </table>${visible.length < filtered.length ? `<div class="load-more"><button class="ghost-btn" onclick="showMoreTransactions()">Toon meer (${filtered.length - visible.length})</button></div>` : ""}`;
}

function transactionRowHtml(item) {
  return `<tr>
    <td class="date-col">${dateNl(item.date)}</td>
    <td class="asset-col">${assetCell(item)}</td>
    <td class="type-col">${sideBadge(item.side)}${item.auto ? `<div class="asset-meta"><span class="tag-badge">DCA</span></div>` : ""}</td>
    <td class="num-col">${number.format(item.quantity)}</td>
    <td class="num-col">${currency.format(item.price)}</td>
    <td class="num-col">${transactionValueCell(item)}</td>
    <td class="action-col"><button class="icon-btn danger" title="Verwijderen" onclick="removeTransaction('${escAttr(item.id)}')" ${item.auto ? "disabled" : ""}>
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/></svg>
    </button></td>
  </tr>`;
}

function transactionRows(items) {
  const mode = state.ui.transactionGroup || "month";
  if (mode === "none") return items.map((item) => ({ item }));
  const rows = [];
  let current = "";
  let currentGroup = null;
  items.forEach((item) => {
    const key = transactionGroupLabel(item, mode);
    if (key !== current) {
      current = key;
      currentGroup = { group: true, label: key, items: [] };
      rows.push(currentGroup);
    }
    currentGroup.items.push(item);
    rows.push({ item });
  });
  rows.filter((row) => row.group).forEach((row) => {
    row.summary = transactionGroupSummary(row.items);
    delete row.items;
  });
  return rows;
}

function transactionGroupLabel(item, mode) {
  if (mode === "asset") return `${item.ticker} · ${item.name}`;
  if (mode === "source") return item.source || (item.auto ? "DCA" : "Handmatig");
  return new Intl.DateTimeFormat("nl-NL", { month: "long", year: "numeric" }).format(new Date(`${item.date}T00:00:00`));
}

function transactionGroupSummary(items) {
  const buys = items.filter((item) => item.side === "buy").length;
  const sells = items.length - buys;
  const total = items.reduce((sum, item) => sum + Math.abs(item.quantity * item.price), 0);
  const parts = [`${items.length} transacties`, `${currency.format(total)} bruto`];
  if (buys) parts.push(`${buys} aankopen`);
  if (sells) parts.push(`${sells} verkopen`);
  return parts.join(" · ");
}

function filteredPositions(list) {
  const query = (state.ui.positionSearch || "").trim().toLowerCase();
  return list.filter((item) => {
    const matchesQuery = !query || `${item.ticker} ${item.name} ${item.type}`.toLowerCase().includes(query);
    const matchesSmall = !state.ui.hideSmallPositions || item.value >= 1;
    const special = state.ui.positionSpecialFilter || "all";
    const matchesSpecial = special === "overrides" ? !!state.avgPrices?.[item.ticker] : special === "small" ? item.value < 1 : true;
    return matchesQuery && matchesSmall && matchesSpecial;
  });
}

function sortedPositions(list) {
  const validKeys = new Set(["value", "gainPct", "gain", "ticker", "type", "quantity", "avgPrice", "currentPrice"]);
  const key = validKeys.has(state.ui.positionSort) ? state.ui.positionSort : "value";
  const dir = state.ui.positionDir === "asc" ? 1 : -1;
  return [...list].sort((a, b) => {
    const left = a[key];
    const right = b[key];
    if (typeof left === "string" || typeof right === "string") return String(left).localeCompare(String(right)) * dir;
    return ((left || 0) - (right || 0)) * dir;
  });
}

function filteredTransactions(ignoreSide = false) {
  const query = (state.ui.transactionSearch || "").trim().toLowerCase();
  return [...state.transactions]
    .filter((item) => {
      const haystack = `${item.ticker} ${item.name} ${item.type} ${item.source || ""}`.toLowerCase();
      const queryOk = !query || haystack.includes(query);
      const typeOk = state.ui.transactionTypeFilter === "all" || item.type === state.ui.transactionTypeFilter;
      const sideOk = ignoreSide || state.ui.transactionSideFilter === "all" || item.side === state.ui.transactionSideFilter;
      const amountOk = !state.ui.hideSmallTransactions || Math.abs(item.quantity * item.price) >= 1;
      const special = state.ui.transactionSpecialFilter || "all";
      const specialOk = special === "corrections" ? /correctie|reconciliation/i.test(item.source || "") : true;
      return queryOk && typeOk && sideOk && amountOk && specialOk;
    })
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}

function renderPositionChips(all, filtered) {
  const target = document.getElementById("positionChips");
  const visibleValue = filtered.reduce((sum, item) => sum + item.value, 0);
  const winners = filtered.filter((item) => item.gain >= 0).length;
  const small = all.filter((item) => item.value < 1).length;
  const typeRows = analysisByType(filtered.filter((item) => item.value >= 1));
  target.innerHTML = [
    `<button class="chip ${state.ui.positionSpecialFilter === "all" && !(state.ui.positionSearch || "") ? "active" : ""}" onclick="clearPositionFilters()">${filtered.length} posities · ${currency.format(visibleValue)}</button>`,
    `<span class="chip">${winners} positief</span>`,
    ...typeRows.map((item) => `<button class="chip" onclick="filterPositionsByType('${escAttr(item.type)}')">${esc(item.type)} ${pct.format(item.weight)}</button>`),
    small ? `<button class="chip ${state.ui.positionSpecialFilter === "small" ? "active" : ""}" onclick="showSmallPositions()">${small} klein</button>` : ""
  ].filter(Boolean).join("");
  target.hidden = false;
}

function renderTransactionChips(filtered) {
  const buys = filtered.filter((item) => item.side === "buy").length;
  const sells = filtered.filter((item) => item.side === "sell").length;
  const automated = filtered.filter((item) => item.auto).length;
  const corrections = filtered.filter((item) => /correctie|reconciliation/i.test(item.source || "")).length;
  const side = state.ui.transactionSideFilter || "all";
  const special = state.ui.transactionSpecialFilter || "all";
  document.getElementById("transactionChips").innerHTML = [
    `<button class="chip ${side === "all" && special === "all" ? "active" : ""}" onclick="setTransactionSide('all')">${filtered.length} transacties</button>`,
    `<button class="chip ${side === "buy" && special === "all" ? "active" : ""}" onclick="setTransactionSide('buy')">${buys} aankopen</button>`,
    `<button class="chip ${side === "sell" && special === "all" ? "active" : ""}" onclick="setTransactionSide('sell')">${sells} verkopen</button>`,
    corrections ? `<button class="chip ${special === "corrections" ? "active" : ""}" onclick="setTransactionCorrections()">${corrections} correcties</button>` : "",
    automated ? `<button class="chip" onclick="setTransactionSearch('DCA')">${automated} DCA</button>` : "",
    `<button class="chip" onclick="resetTransactionFilters()">Reset filters</button>`
  ].filter(Boolean).join("");
}

function sortHeader(label, key) {
  const active = state.ui.positionSort === key;
  const dir = active && state.ui.positionDir === "asc" ? "↑" : "↓";
  return `<button class="sort-th ${active ? "active" : ""}" onclick="sortPositionsBy('${key}')">${esc(label)} ${active ? dir : ""}</button>`;
}

window.sortPositionsBy = (key) => {
  if (state.ui.positionSort === key) {
    state.ui.positionDir = state.ui.positionDir === "asc" ? "desc" : "asc";
  } else {
    state.ui.positionSort = key;
    state.ui.positionDir = ["ticker", "type"].includes(key) ? "asc" : "desc";
  }
  persist();
  render();
};

window.clearPositionFilters = () => {
  state.ui.positionSearch = "";
  state.ui.hideSmallPositions = !!state.settings.defaultHideSmallPositions;
  state.ui.positionSpecialFilter = "all";
  persist();
  render();
};

window.showAllPositions = () => {
  state.ui.positionSearch = "";
  state.ui.hideSmallPositions = false;
  state.ui.positionSpecialFilter = "all";
  persist();
  render();
};

window.showSmallPositions = () => {
  state.ui.positionSearch = "";
  state.ui.hideSmallPositions = false;
  state.ui.positionSpecialFilter = "small";
  state.ui.positionSort = "value";
  state.ui.positionDir = "asc";
  persist();
  render();
};

window.showAverageOverrides = () => {
  state.ui.positionSearch = "";
  state.ui.hideSmallPositions = false;
  state.ui.positionSpecialFilter = "overrides";
  persist();
  render();
};

window.setTransactionSide = (side) => {
  state.ui.transactionSideFilter = side;
  state.ui.transactionSearch = "";
  state.ui.transactionSpecialFilter = "all";
  persist();
  render();
};

window.setTransactionSearch = (query) => {
  state.ui.transactionSearch = query;
  state.ui.transactionSpecialFilter = "all";
  persist();
  render();
};

window.setTransactionCorrections = () => {
  state.ui.transactionSearch = "";
  state.ui.transactionSpecialFilter = "corrections";
  persist();
  render();
};

function renderAnalysis(total) {
  const list = total.list.filter((item) => item.value >= 1);
  const visibleValue = list.reduce((sum, item) => sum + item.value, 0);
  const typeRows = analysisByType(list);
  const top = list[0];
  const topFiveWeight = list.slice(0, 5).reduce((sum, item) => sum + item.value, 0) / Math.max(visibleValue, 1);
  const cryptoWeight = typeRows.find((item) => item.type === "Crypto")?.weight || 0;
  const correctionCount = state.transactions.filter((item) => item.source === "Crypto screenshot reconciliation").length;
  const firstDate = state.transactions.reduce((min, item) => !min || item.date < min ? item.date : min, "");
  const monthlyBuys = averageMonthlyBuys();

  document.getElementById("analysisMetrics").innerHTML = [
    metric("Zichtbare waarde", currency.format(visibleValue), `${list.length} posities boven €1`),
    metric("Toppositie", top ? `${top.ticker} · ${pct.format(top.value / visibleValue)}` : "Geen", top ? currency.format(top.value) : "Nog geen data"),
    metric("Top 5 gewicht", pct.format(topFiveWeight), topFiveWeight > .75 ? "Sterk geconcentreerd" : "Redelijk gespreid"),
    metric("Gem. maandinleg", currency.format(monthlyBuys), firstDate ? `Sinds ${dateNl(firstDate)}` : "Geen transacties")
  ].join("");

  renderAnalysisTypeTable(typeRows);
  renderAnalysisMoversTable(list, visibleValue);
  renderAnalysisTransactionTable();
  renderAnalysisSignals({ list, visibleValue, top, topFiveWeight, cryptoWeight, correctionCount, typeRows, monthlyBuys });
  renderScenarioCards(total, typeRows);
  renderMarketContext(total);
  renderRiskCashflow(total);
  renderConcentrationHeatmap(list, visibleValue);
  renderAnalysisAllocationCompare(total);
  renderAnalysisWaterfall(total, typeRows);
  renderAnalysisRiskDrivers(total);
  renderAssetScatter(list, visibleValue);
  renderAnalysisDcaSimulator(total);
  renderAnalysisTimeline(total);
  renderAnalysisRebalancePlanner(total);
  renderAnalysisMoverPerspective(total);
  renderAnalysisDataMatrix(total);
}

function analysisByType(list) {
  const totalValue = list.reduce((sum, item) => sum + item.value, 0);
  const map = new Map();
  list.forEach((item) => {
    const row = map.get(item.type) || { type: item.type, count: 0, value: 0, cost: 0, gain: 0 };
    row.count += 1;
    row.value += item.value;
    row.cost += item.cost;
    row.gain += item.gain;
    map.set(item.type, row);
  });
  return [...map.values()].map((row) => ({
    ...row,
    gainPct: row.cost ? row.gain / row.cost : 0,
    weight: totalValue ? row.value / totalValue : 0
  })).sort((a, b) => b.value - a.value);
}

function renderAnalysisTypeTable(rows) {
  const target = document.getElementById("analysisTypeTable");
  if (!rows.length) {
    target.innerHTML = `<div class="empty">Nog geen analyse beschikbaar.</div>`;
    return;
  }
  target.innerHTML = `<table>
    <thead><tr><th>Categorie</th><th>Pos.</th><th>Waarde</th><th>Weging</th><th>Rend.</th></tr></thead>
    <tbody>${rows.map((item) => `<tr>
      <td><strong>${esc(item.type)}</strong></td>
      <td>${number.format(item.count)}</td>
      <td>${currency.format(item.value)}</td>
      <td>${weightCell(item.weight)}</td>
      <td>${resultPill(item.gain, item.gainPct)}</td>
    </tr>`).join("")}</tbody>
  </table>`;
}

function weightCell(value) {
  const width = Math.max(1, Math.min(100, value * 100));
  return `<div class="weight-cell">
    <strong>${pct.format(value)}</strong>
    <span class="weight-track"><span class="weight-fill" style="width:${width.toFixed(1)}%"></span></span>
  </div>`;
}

function renderAnalysisMoversTable(list, totalValue) {
  const winners = [...list].sort((a, b) => b.gain - a.gain).slice(0, 3);
  const losers = [...list].sort((a, b) => a.gain - b.gain).slice(0, 3);
  const rows = [...winners, ...losers.filter((item) => !winners.some((winner) => winner.ticker === item.ticker))];
  const target = document.getElementById("analysisMoversTable");
  if (!rows.length) {
    target.innerHTML = `<div class="empty">Nog geen winnaars of verliezers.</div>`;
    return;
  }
  target.innerHTML = `<div class="mover-grid">${rows.map((item) => moverCard(item, totalValue)).join("")}</div>`;
}

function moverCard(item, totalValue) {
  const positive = item.gain >= 0;
  return `<button class="mover-card" type="button" onclick="openPosition('${escAttr(item.ticker)}')">
    <div class="badge" style="--badge-color:${typeColor(item.type)}22">${esc(String(item.ticker || "?").slice(0, 2))}</div>
    <div class="mover-main">
      <strong>${esc(item.ticker)}</strong>
      <span>${esc(item.name)}</span>
    </div>
    <div class="mover-meta">
      <strong class="${positive ? "gain" : "loss"}">${positive ? "+" : ""}${currency.format(item.gain)}</strong>
      <span>${pct.format(item.value / Math.max(totalValue, 1))} · ${pct.format(item.gainPct)}</span>
    </div>
  </button>`;
}

function renderAnalysisTransactionTable() {
  const sources = sourceStats();
  const byType = transactionTypeStats();
  const corrections = state.transactions.filter((item) => item.source === "Crypto screenshot reconciliation").length;
  const buys = state.transactions.filter((item) => item.side === "buy").length;
  const sells = state.transactions.length - buys;
  const rows = [
    { tone: "info", label: "Totaal", value: number.format(state.transactions.length), tag: "regels", note: `${number.format(buys)} koop · ${number.format(sells)} verkoop` },
    { tone: corrections ? "info" : "good", label: "Correcties", value: number.format(corrections), tag: "reconciled", note: "Crypto snapshot" },
    ...byType.map((item) => ({ tone: "info", label: item.type, value: number.format(item.count), tag: pct.format(item.count / Math.max(state.transactions.length, 1)), note: currency.format(item.notional) })),
    ...sources.slice(0, 4).map((item) => ({ tone: "info", label: item.source, value: number.format(item.count), tag: pct.format(item.count / Math.max(state.transactions.length, 1)), note: "bron" }))
  ];
  document.getElementById("analysisTransactionTable").innerHTML = `<div class="stat-grid">${rows.map(analysisStatTile).join("")}</div>`;
}

function renderAnalysisSignals(context) {
  const signals = [];
  if (context.top) {
    const topWeight = context.top.value / Math.max(context.visibleValue, 1);
    signals.push({
      tone: topWeight > .45 ? "warn" : "good",
      title: "Concentratie",
      value: `${context.top.ticker} · ${pct.format(topWeight)}`,
      status: topWeight > .45 ? "Let op" : "Gezond",
      note: topWeight > .45 ? "Grootste positie domineert" : "Binnen bandbreedte"
    });
  }
  signals.push({
    tone: context.cryptoWeight > .35 ? "warn" : "info",
    title: "Crypto-weging",
    value: pct.format(context.cryptoWeight),
    status: context.cryptoWeight > .35 ? "Let op" : "Monitor",
    note: "Aandeel in zichtbare waarde"
  });
  const bestType = [...context.typeRows].sort((a, b) => b.gainPct - a.gainPct)[0];
  const worstType = [...context.typeRows].sort((a, b) => a.gainPct - b.gainPct)[0];
  if (bestType) {
    signals.push({
      tone: bestType.gain >= 0 ? "good" : "bad",
      title: "Sterkste categorie",
      value: bestType.type,
      status: pct.format(bestType.gainPct),
      note: currency.format(bestType.gain)
    });
  }
  if (worstType && worstType.type !== bestType?.type) {
    signals.push({
      tone: worstType.gain < 0 ? "bad" : "info",
      title: "Zwakste categorie",
      value: worstType.type,
      status: pct.format(worstType.gainPct),
      note: currency.format(worstType.gain)
    });
  }
  signals.push({
    tone: context.correctionCount ? "info" : "good",
    title: "Datakwaliteit",
    value: number.format(context.correctionCount),
    status: context.correctionCount ? "Correcties" : "Schoon",
    note: context.correctionCount ? "Crypto-regels actief" : "Geen correctieregels"
  });
  signals.push({
    tone: context.monthlyBuys > 0 ? "info" : "warn",
    title: "Inlegtempo",
    value: currency.format(context.monthlyBuys),
    status: context.monthlyBuys > 0 ? "Maand" : "Geen data",
    note: context.monthlyBuys > 0 ? "Gemiddelde aankoopflow" : "Geen koopgemiddelde"
  });
  portfolioRecommendations(context).slice(0, 2).forEach((item) => {
    signals.push({
      tone: item.tone,
      title: "Aanbeveling",
      value: item.title,
      status: "Actie",
      note: item.text
    });
  });

  document.getElementById("analysisSignals").innerHTML = signals.map(analysisChip).join("");
}

function renderScenarioCards(total, typeRows) {
  const monthly = Math.max(total.dcaMonthly, averageMonthlyBuys(), 0);
  const oneYear = total.value + monthly * 12;
  const threeYear = total.value + monthly * 36;
  const gainPerMonth = monthly ? total.gain / Math.max(monthsSinceFirstTransaction(), 1) : 0;
  const trendOneYear = total.value + (monthly + gainPerMonth) * 12;
  const maxValue = Math.max(oneYear, threeYear, trendOneYear, total.value, 1);
  const rows = [
    { tone: "info", title: "1 jaar", value: oneYear, delta: oneYear - total.value, note: "alleen inleg" },
    { tone: "info", title: "3 jaar", value: threeYear, delta: threeYear - total.value, note: "zelfde tempo" },
    { tone: trendOneYear >= oneYear ? "good" : "warn", title: "Trend", value: trendOneYear, delta: trendOneYear - total.value, note: "rendement + inleg" }
  ];
  const balance = typeRows.length
    ? `<div class="balance-list">${typeRows.map((row, index) => compactWeightBar(row.type, row.weight, chartColors()[index % chartColors().length])).join("")}</div>`
    : `<div class="empty">Nog geen categoriedata.</div>`;
  document.getElementById("scenarioCards").innerHTML = `<div class="scenario-grid">${rows.map((row) => scenarioVisualCard(row, maxValue)).join("")}</div>${balance}`;
}

function renderMarketContext(total) {
  const diagnostics = portfolioDiagnostics(total);
  const cryptoCount = diagnostics.list.filter((item) => item.type === "Crypto").length;
  const rows = [
    { tone: "info", title: "Crypto bron", value: cryptoCount ? "CoinGecko" : "Geen crypto", status: cryptoCount ? "Live-ready" : "N.v.t.", note: `${cryptoCount} posities` },
    { tone: "warn", title: "Aandelen/ETF", value: "Import/CSV", status: "Handmatig", note: "Live provider later" },
    { tone: diagnostics.priceInfo.liveCryptoAt ? "good" : "info", title: "Live crypto", value: diagnostics.priceInfo.liveCryptoAt ? dateNl(diagnostics.priceInfo.liveCryptoAt.slice(0, 10)) : "Geen update", status: diagnostics.priceInfo.liveCryptoAt ? "Recent" : "Import", note: diagnostics.priceInfo.liveCryptoAt ? dateTimeNl(diagnostics.priceInfo.liveCryptoAt) : "Lokale dataset" },
    { tone: "info", title: "Macro", value: "Adapter", status: "Voorbereid", note: "Nog niet automatisch" }
  ];
  document.getElementById("marketContextCards").innerHTML = rows.map(analysisChip).join("");
}

function renderRiskCashflow(total) {
  const diagnostics = portfolioDiagnostics(total);
  const stakingRows = state.transactions.filter((item) => item.price === 0 && item.side === "buy" && item.type === "Crypto").length;
  const rows = [
    { tone: diagnostics.riskScore > 65 ? "bad" : diagnostics.riskScore > 40 ? "warn" : "good", title: "Risicoscore", value: `${diagnostics.riskScore}/100`, status: diagnostics.riskScore > 65 ? "Hoog" : diagnostics.riskScore > 40 ? "Middel" : "Rustig", note: "Concentratie + data" },
    { tone: diagnostics.topThreeWeight > .7 ? "warn" : "info", title: "Top 3", value: pct.format(diagnostics.topThreeWeight), status: diagnostics.topThreeWeight > .7 ? "Let op" : "Monitor", note: "Grootste posities" },
    { tone: stakingRows ? "good" : "info", title: "Cashflow", value: number.format(stakingRows), status: stakingRows ? "Gevonden" : "Ready", note: "Staking/dividend regels" },
    { tone: "info", title: "Bronnen", value: number.format(sourceStats().length), status: "Actief", note: "Controle in Instellingen" }
  ];
  document.getElementById("riskCashflowCards").innerHTML = rows.map(analysisChip).join("");
}

function renderConcentrationHeatmap(list, visibleValue) {
  const rows = list.slice(0, 12);
  const max = Math.max(...rows.map((item) => item.value), 1);
  document.getElementById("analysisHeatmap").innerHTML = rows.length ? rows.map((item) => {
    const positive = item.gain >= 0;
    const color = positive ? "var(--good)" : "var(--bad)";
    const bg = positive ? "var(--good-soft)" : "var(--bad-soft)";
    const size = 62 + Math.min(76, item.value / max * 76);
    return `<button class="heat-tile" type="button" onclick="openPosition('${escAttr(item.ticker)}')" style="--heat-color:${color};--heat-bg:${bg};--heat-size:${size.toFixed(0)}px">
      <strong>${esc(item.ticker)}</strong>
      <span>${currency.format(item.value)} · ${pct.format(item.value / Math.max(visibleValue, 1))}</span>
      <span class="${positive ? "gain" : "loss"}">${positive ? "+" : ""}${pct.format(item.gainPct)}</span>
    </button>`;
  }).join("") : `<div class="empty">Nog geen posities voor heatmap.</div>`;
}

function renderAnalysisAllocationCompare(total) {
  const rows = allocationRows(total);
  const under = [...rows].filter((item) => item.diffPct < -1).sort((a, b) => a.diffPct - b.diffPct);
  const monthly = Math.max(planDiagnostics(total).planned, averageMonthlyBuys(), total.dcaMonthly, 0);
  const plan = rebalanceAllocations(rows, monthly);
  document.getElementById("analysisAllocationCompare").innerHTML = [
    ...rows.map((item) => `<article class="compare-row">
      <div class="compare-head"><strong>${esc(item.type)}</strong>${diffBadge(item.diffPct)}</div>
      <div class="dual-bars">
        ${analysisDualBar("Huidig", item.currentPct, typeColor(item.type))}
        ${analysisDualBar("Doel", item.targetPct, "var(--accent-5)")}
      </div>
    </article>`),
    `<article class="compare-row">
      <div class="compare-head"><strong>Nieuwe inleg</strong><span>${currency.format(monthly)}</span></div>
      <span class="muted">${under.length ? under.map((item) => item.type).slice(0, 2).join(" + ") : "Allocatie is rond doel."}</span>
      ${plan.slice(0, 3).map((item) => analysisDualBar(item.type, item.amount / Math.max(monthly, 1) * 100, typeColor(item.type), currency.format(item.amount))).join("")}
    </article>`
  ].join("");
}

function renderAnalysisWaterfall(total, typeRows) {
  const maxGain = Math.max(...typeRows.map((item) => Math.abs(item.gain)), Math.abs(total.gain), 1);
  const rows = [
    { label: "Kostprijs", value: total.cost, meta: "basis", color: "var(--muted)", width: total.cost / Math.max(total.value, total.cost, 1) * 100 },
    ...typeRows.map((item) => ({
      label: item.type,
      value: item.gain,
      meta: `${item.gain >= 0 ? "+" : ""}${pct.format(item.gainPct)}`,
      color: item.gain >= 0 ? "var(--good)" : "var(--bad)",
      width: Math.abs(item.gain) / maxGain * 100
    })),
    { label: "Actuele waarde", value: total.value, meta: total.gain >= 0 ? "boven kostprijs" : "onder kostprijs", color: "var(--accent)", width: 100 }
  ];
  document.getElementById("analysisWaterfall").innerHTML = rows.map((item) => `<div class="waterfall-row">
    <div class="waterfall-head"><strong>${esc(item.label)}</strong></div>
    <div class="waterfall-track"><span class="waterfall-fill" style="--bar-width:${Math.max(2, Math.min(100, item.width)).toFixed(1)}%;--bar-color:${item.color};--bar-color-2:${item.color}"></span></div>
    <div class="waterfall-head"><strong class="${item.value >= 0 ? "gain" : "loss"}">${item.value >= 0 && item.label !== "Kostprijs" && item.label !== "Actuele waarde" ? "+" : ""}${currency.format(item.value)}</strong><span>${esc(item.meta)}</span></div>
  </div>`).join("");
}

function renderAnalysisRiskDrivers(total) {
  const diagnostics = portfolioDiagnostics(total);
  const topWeight = diagnostics.top ? diagnostics.top.value / Math.max(diagnostics.visibleValue, 1) : 0;
  const rows = [
    { label: "Toppositie", value: topWeight, max: .6, note: diagnostics.top ? diagnostics.top.ticker : "Geen", tone: topWeight > .45 ? "warn" : "good" },
    { label: "Top 5", value: diagnostics.topFiveWeight, max: 1, note: pct.format(diagnostics.topFiveWeight), tone: diagnostics.topFiveWeight > .75 ? "warn" : "good" },
    { label: "Crypto", value: diagnostics.cryptoWeight, max: .6, note: pct.format(diagnostics.cryptoWeight), tone: diagnostics.cryptoWeight > .35 ? "warn" : "info" },
    { label: "Oude koersen", value: diagnostics.priceInfo.stale.length, max: Math.max(8, diagnostics.list.length), note: `${diagnostics.priceInfo.stale.length} posities`, tone: diagnostics.priceInfo.stale.length ? "warn" : "good" },
    { label: "Correcties", value: correctionTransactions().length, max: Math.max(12, state.transactions.length / 20), note: `${correctionTransactions().length} regels`, tone: correctionTransactions().length ? "info" : "good" }
  ];
  document.getElementById("analysisRiskDrivers").innerHTML = rows.map((item) => {
    const width = Math.max(2, Math.min(100, Number(item.value || 0) / Math.max(item.max, 1) * 100));
    const color = item.tone === "good" ? "var(--good)" : item.tone === "warn" ? "var(--warn)" : "var(--accent)";
    return `<article class="risk-driver">
      <div class="risk-head"><strong>${esc(item.label)}</strong><span>${esc(item.note)}</span></div>
      <div class="risk-track"><span class="risk-fill" style="--bar-width:${width.toFixed(1)}%;--bar-color:${color};--bar-color-2:${color}"></span></div>
    </article>`;
  }).join("");
}

function renderAssetScatter(list, visibleValue) {
  if (!list.length) {
    document.getElementById("analysisScatter").innerHTML = `<div class="empty">Nog geen scatterdata.</div>`;
    return;
  }
  const rows = list.slice(0, 18);
  const maxWeight = Math.max(...rows.map((item) => item.value / Math.max(visibleValue, 1)), .01);
  const gains = rows.map((item) => item.gainPct);
  const minGain = Math.min(...gains, -.25);
  const maxGain = Math.max(...gains, .25);
  const maxValue = Math.max(...rows.map((item) => item.value), 1);
  document.getElementById("analysisScatter").innerHTML = [
    `<span class="scatter-axis y">rendement</span><span class="scatter-axis x">weging</span>`,
    ...rows.map((item) => {
      const weight = item.value / Math.max(visibleValue, 1);
      const x = Math.max(6, Math.min(94, weight / maxWeight * 88 + 6));
      const y = Math.max(8, Math.min(92, (item.gainPct - minGain) / Math.max(maxGain - minGain, .01) * 84 + 8));
      const size = 16 + item.value / maxValue * 22;
      const color = item.gain >= 0 ? "var(--good)" : "var(--bad)";
      return `<button class="scatter-point" type="button" title="${escAttr(`${item.ticker}: ${pct.format(weight)} · ${pct.format(item.gainPct)}`)}" onclick="openPosition('${escAttr(item.ticker)}')" style="--x:${x.toFixed(1)}%;--y:${y.toFixed(1)}%;--size:${size.toFixed(0)}px;--point-color:${color}">${esc(item.ticker.slice(0, 2))}</button>`;
    })
  ].join("");
}

function renderAnalysisDcaSimulator(total) {
  const monthly = Number(state.ui.analysisSimMonthly || Math.max(planDiagnostics(total).planned, averageMonthlyBuys(), total.dcaMonthly, 500));
  const annualPct = Number(state.ui.analysisSimReturn || 6);
  const annual = annualPct / 100;
  const one = projectValue(total.value, monthly, annual, 1);
  const three = projectValue(total.value, monthly, annual, 3);
  const five = projectValue(total.value, monthly, annual, 5);
  const max = Math.max(one, three, five, 1);
  document.getElementById("analysisDcaSimulator").innerHTML = `<div class="analysis-sim-controls">
    <label>Maandinleg <strong>${currency.format(monthly)}</strong><input type="range" min="0" max="2500" step="50" value="${monthly}" data-analysis-sim="analysisSimMonthly"></label>
    <label>Rendement <strong>${number.format(annualPct)}%</strong><input type="range" min="-20" max="20" step="0.5" value="${annualPct}" data-analysis-sim="analysisSimReturn"></label>
  </div>
  <div class="sim-result-grid">
    ${analysisSimResult("1 jaar", one, total.value, max)}
    ${analysisSimResult("3 jaar", three, total.value, max)}
    ${analysisSimResult("5 jaar", five, total.value, max)}
  </div>`;
}

function renderAnalysisTimeline(total) {
  const months = recentMonthKeys(8);
  const buysByMonth = new Map();
  state.transactions.filter((item) => item.side === "buy").forEach((item) => {
    const key = monthKey(item.date);
    buysByMonth.set(key, (buysByMonth.get(key) || 0) + Math.abs(item.quantity * item.price));
  });
  const history = portfolioHistory(12);
  const valueByMonth = new Map(history.map((item) => [monthKey(item.date), item.value]));
  const maxBuy = Math.max(...months.map((key) => buysByMonth.get(key) || 0), 1);
  const maxValue = Math.max(...history.map((item) => item.value), total.value, 1);
  document.getElementById("analysisTimeline").innerHTML = months.map((key) => {
    const buy = buysByMonth.get(key) || 0;
    const value = valueByMonth.get(key) || total.value;
    return `<div class="timeline-row">
      <strong>${esc(shortMonthLabel(key))}</strong>
      <div class="timeline-line">
        <div class="timeline-track"><span class="timeline-fill" style="--bar-width:${(buy / maxBuy * 100).toFixed(1)}%;--bar-color:var(--accent);--bar-color-2:var(--accent-3)"></span></div>
        <span class="timeline-value" style="--value-left:${Math.max(0, Math.min(100, value / maxValue * 100)).toFixed(1)}%"></span>
      </div>
      <span class="muted">${currency.format(buy)}</span>
    </div>`;
  }).join("");
}

function renderAnalysisRebalancePlanner(total) {
  const rows = allocationRows(total);
  const monthly = Math.max(planDiagnostics(total).planned, averageMonthlyBuys(), total.dcaMonthly, 500);
  const plan = rebalanceAllocations(rows, monthly);
  document.getElementById("analysisRebalancePlanner").innerHTML = `<div class="rebalance-summary">
    ${plan.slice(0, 3).map((item) => analysisStatTile({ tone: item.amount > 0 ? "info" : "good", label: item.type, value: currency.format(item.amount), tag: pct.format(item.share), note: item.diffPct < 0 ? "onder doel" : "op koers" })).join("")}
  </div>
  ${plan.map((item) => `<article class="rebalance-row">
    <div class="rebalance-head"><strong>${esc(item.type)}</strong><span>${currency.format(item.amount)}</span></div>
    <div class="rebalance-track"><span class="rebalance-fill" style="--bar-width:${Math.max(2, item.share * 100).toFixed(1)}%;--bar-color:${typeColor(item.type)};--bar-color-2:${typeColor(item.type)}"></span></div>
  </article>`).join("")}`;
}

function renderAnalysisMoverPerspective(total) {
  const mode = state.ui.analysisMoverMode || "gain";
  document.querySelectorAll("#analysisMoverTabs [data-mover-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.moverMode === mode);
  });
  const rows = moverPerspectiveRows(total, mode).slice(0, 6);
  document.getElementById("analysisMoverPerspective").innerHTML = rows.length ? rows.map((row) => `<button class="mover-card" type="button" onclick="openPosition('${escAttr(row.item.ticker)}')">
    <div class="badge" style="--badge-color:${typeColor(row.item.type)}22">${esc(row.item.ticker.slice(0, 2))}</div>
    <div class="mover-main"><strong>${esc(row.item.ticker)}</strong><span>${esc(row.label)}</span></div>
    <div class="mover-meta"><strong class="${row.tone === "bad" ? "loss" : "gain"}">${esc(row.value)}</strong><span>${esc(row.meta)}</span></div>
  </button>`).join("") : `<div class="empty">Nog geen movers.</div>`;
}

function renderAnalysisDataMatrix(total) {
  const diagnostics = portfolioDiagnostics(total);
  const corrections = correctionTransactions().length;
  const rows = [
    { source: "Portfolio import", mode: state.meta?.lastImportAt ? dateNl(state.meta.lastImportAt.slice(0, 10)) : "Onbekend", status: state.meta?.lastImportAt ? "OK" : "Check", tone: state.meta?.lastImportAt ? "good" : "warn", count: state.transactions.length },
    { source: "Crypto live", mode: diagnostics.priceInfo.liveCryptoAt ? dateNl(diagnostics.priceInfo.liveCryptoAt.slice(0, 10)) : "Geen", status: diagnostics.priceInfo.liveCryptoAt ? "OK" : "Import", tone: diagnostics.priceInfo.liveCryptoAt ? "good" : "info", count: diagnostics.list.filter((item) => item.type === "Crypto").length },
    { source: "Oude koersen", mode: `${diagnostics.priceInfo.stale.length} posities`, status: diagnostics.priceInfo.stale.length ? "Let op" : "OK", tone: diagnostics.priceInfo.stale.length ? "warn" : "good", count: diagnostics.priceInfo.stale.length },
    { source: "Correcties", mode: `${corrections} regels`, status: corrections ? "Actief" : "Schoon", tone: corrections ? "info" : "good", count: corrections },
    ...sourceStats().slice(0, 4).map((item) => ({ source: item.source, mode: dateNl(item.latest), status: "Bron", tone: "info", count: item.count }))
  ];
  document.getElementById("analysisDataMatrix").innerHTML = rows.map((item) => `<article class="matrix-row signal-${item.tone}">
    <div class="matrix-head"><strong>${esc(item.source)}</strong></div>
    <span class="muted">${esc(item.mode)}</span>
    <span class="analysis-tag">${esc(item.status)}</span>
    <strong>${number.format(item.count)}</strong>
  </article>`).join("");
}

function analysisDualBar(label, value, color, overrideValue = "") {
  const width = Math.max(2, Math.min(100, value));
  return `<div class="dual-bar">
    <span>${esc(label)}</span>
    <span class="mini-track"><span class="mini-fill" style="--bar-width:${width.toFixed(1)}%;--bar-color:${color};--bar-color-2:${color}"></span></span>
    <strong>${esc(overrideValue || pct.format(value / 100))}</strong>
  </div>`;
}

function analysisSimResult(label, value, startValue, maxValue) {
  const width = Math.max(2, Math.min(100, value / Math.max(maxValue, 1) * 100));
  const delta = value - startValue;
  return `<article class="analysis-stat-tile signal-${delta >= 0 ? "good" : "bad"}">
    <div class="stat-tile-top"><span class="stat-label">${esc(label)}</span><span class="analysis-tag">${delta >= 0 ? "+" : ""}${currency.format(delta)}</span></div>
    <strong class="stat-main">${currency.format(value)}</strong>
    <span class="sim-track"><span class="sim-fill" style="--bar-width:${width.toFixed(1)}%"></span></span>
  </article>`;
}

function rebalanceAllocations(rows, amount) {
  const under = rows.filter((item) => item.diffPct < -1);
  const totalGap = under.reduce((sum, item) => sum + Math.abs(item.diffPct), 0);
  if (!under.length || amount <= 0) {
    return rows.map((item) => ({ ...item, amount: 0, share: 0 })).sort((a, b) => a.diffPct - b.diffPct);
  }
  return rows.map((item) => {
    const gap = item.diffPct < -1 ? Math.abs(item.diffPct) : 0;
    const share = totalGap ? gap / totalGap : 0;
    return { ...item, amount: amount * share, share };
  }).sort((a, b) => b.amount - a.amount);
}

function recentMonthKeys(count) {
  const end = new Date(`${todayISO()}T00:00:00`);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(end);
    date.setMonth(end.getMonth() - (count - 1 - index));
    return date.toISOString().slice(0, 7);
  });
}

function shortMonthLabel(key) {
  return new Intl.DateTimeFormat("nl-NL", { month: "short" }).format(new Date(`${key}-01T00:00:00`));
}

function moverPerspectiveRows(total, mode) {
  const value = Math.max(total.value, 1);
  const volume = new Map();
  state.transactions.forEach((item) => {
    volume.set(item.ticker, (volume.get(item.ticker) || 0) + Math.abs(item.quantity * item.price));
  });
  return total.list.filter((item) => item.value >= 1).map((item) => {
    if (mode === "pct") return { item, score: item.gainPct, value: `${item.gainPct >= 0 ? "+" : ""}${pct.format(item.gainPct)}`, label: "Rendement", meta: currency.format(item.gain), tone: item.gain >= 0 ? "good" : "bad" };
    if (mode === "weight") return { item, score: item.value / value, value: pct.format(item.value / value), label: "Portefeuilleweging", meta: currency.format(item.value), tone: "good" };
    if (mode === "volume") return { item, score: volume.get(item.ticker) || 0, value: currency.format(volume.get(item.ticker) || 0), label: "Transactievolume", meta: `${item.transactions} tx`, tone: "good" };
    return { item, score: item.gain, value: `${item.gain >= 0 ? "+" : ""}${currency.format(item.gain)}`, label: "Winst/verlies", meta: pct.format(item.gainPct), tone: item.gain >= 0 ? "good" : "bad" };
  }).sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
}

function setAnalysisSim(key, value) {
  state.ui[key] = Number(value);
  persist();
  render();
}

window.setAnalysisSim = setAnalysisSim;

function analysisChip(item) {
  return `<article class="analysis-chip signal-${item.tone || "info"}">
    <div class="chip-top">
      <span class="chip-title">${esc(item.title)}</span>
      <span class="chip-status">${esc(item.status || toneLabel(item.tone))}</span>
    </div>
    <strong class="chip-value">${esc(item.value || "")}</strong>
    <div class="chip-bottom">
      <span class="chip-note">${esc(item.note || "")}</span>
    </div>
  </article>`;
}

function analysisStatTile(item) {
  return `<article class="analysis-stat-tile signal-${item.tone || "info"}">
    <div class="stat-tile-top">
      <span class="stat-label">${esc(item.label)}</span>
      <span class="analysis-tag">${esc(item.tag || toneLabel(item.tone))}</span>
    </div>
    <strong class="stat-main">${esc(item.value)}</strong>
    <span class="stat-note">${esc(item.note || "")}</span>
  </article>`;
}

function scenarioVisualCard(row, maxValue) {
  const width = Math.max(4, Math.min(100, row.value / Math.max(maxValue, 1) * 100));
  return `<article class="scenario-card signal-${row.tone || "info"}">
    <div class="scenario-head">
      <strong>${esc(row.title)}</strong>
      <span class="analysis-tag">${esc(row.note)}</span>
    </div>
    <div class="scenario-value">
      <strong>${currency.format(row.value)}</strong>
      <span>${row.delta >= 0 ? "+" : ""}${currency.format(row.delta)}</span>
    </div>
    <div class="mini-track"><span class="mini-fill" style="--bar-width:${width.toFixed(1)}%"></span></div>
  </article>`;
}

function compactWeightBar(label, value, color) {
  const width = Math.max(1, Math.min(100, value * 100));
  return `<div class="balance-row">
    <strong>${esc(label)}</strong>
    <span class="weight-track"><span class="weight-fill" style="width:${width.toFixed(1)}%;background:${escAttr(color)}"></span></span>
    <span>${pct.format(value)}</span>
  </div>`;
}

function toneLabel(tone) {
  if (tone === "good") return "Gezond";
  if (tone === "warn") return "Let op";
  if (tone === "bad") return "Risico";
  return "Info";
}

function renderPlans(total) {
  const diagnostics = portfolioDiagnostics(total);
  const planInfo = diagnostics.planInfo;
  const remaining = planInfo.remaining;
  document.getElementById("planMetrics").innerHTML = [
    metric("Deze maand gepland", currency.format(planInfo.planned), planInfo.label),
    metric("Werkelijk gekocht", currency.format(planInfo.actual), `${planInfo.matches.reduce((sum, item) => sum + item.transactions.length, 0)} matchende transacties`),
    metric("Nog te verwerken", currency.format(remaining), remaining > 0 ? "Importeer aankopen of controleer broker" : "Maand ligt op schema"),
    metric("Risicoscore", `${diagnostics.riskScore}/100`, diagnostics.riskScore > 65 ? "Hoog aandachtspunt" : diagnostics.riskScore > 40 ? "Middelmatig" : "Rustig")
  ].join("");
  renderMonthlyPlanCards(planInfo);
  renderRiskScoreCards(diagnostics);
  renderShortTermPlan(diagnostics);
  renderLongTermPlan(total, diagnostics);
  renderScenarioSimulator(total);
  renderRebalancePlan(diagnostics);
  syncSimulatorInputs(total);
}

function renderMonthlyPlanCards(planInfo) {
  document.getElementById("monthlyPlanCards").innerHTML = planInfo.matches.map((item) => {
    const tone = item.status === "bevestigd" || item.status === "geimporteerd" ? "good" : item.status === "afwijking" ? "warn" : "bad";
    const progress = item.plan.amount ? Math.min(100, Math.max(0, item.actual / item.plan.amount * 100)) : 0;
    const progressLabel = item.plan.amount ? `${number.format(Math.round(progress))}% van plan` : "Geen bedrag ingesteld";
    return `<article class="monthly-plan-card ${tone}">
      <div class="plan-head">
        <div><h3>${esc(item.plan.name)}</h3><p>${esc(item.plan.broker)} · ${item.plan.tickers.map(esc).join(", ")}</p></div>
        <span class="status-pill ${tone}">${esc(item.status)}</span>
      </div>
      <div class="plan-mini-grid">
        <div class="plan-mini"><span>Gepland</span><strong>${currency.format(item.plan.amount)}</strong></div>
        <div class="plan-mini"><span>Werkelijk</span><strong>${currency.format(item.actual)}</strong></div>
        <div class="plan-mini"><span>Verschil</span><strong>${currency.format(item.diff)}</strong></div>
      </div>
      <div class="plan-progress" aria-label="${escAttr(progressLabel)}">
        <div class="plan-progress-label"><span>${esc(monthLabel(planInfo.key))}</span><span>${esc(progressLabel)} · ${number.format(item.transactions.length)} transacties</span></div>
        <div class="progress-track"><span class="progress-fill ${tone}" style="width:${progress.toFixed(1)}%"></span></div>
      </div>
    </article>`;
  }).join("");
}

function renderRiskScoreCards(diagnostics) {
  const topWeight = diagnostics.top ? diagnostics.top.value / Math.max(diagnostics.visibleValue, 1) : 0;
  const rows = [
    { tone: diagnostics.riskScore > 65 ? "bad" : diagnostics.riskScore > 40 ? "warn" : "good", title: `Score ${diagnostics.riskScore}/100`, text: "Regelgebaseerde score op concentratie, crypto-weging, top 5 en koersleeftijd." },
    { tone: topWeight > .45 ? "warn" : "good", title: "Toppositie", text: diagnostics.top ? `${diagnostics.top.ticker} weegt ${pct.format(topWeight)}.` : "Geen toppositie." },
    { tone: diagnostics.cryptoWeight > .35 ? "warn" : "info", title: "Crypto", text: `Crypto weegt ${pct.format(diagnostics.cryptoWeight)}.` },
    { tone: diagnostics.priceInfo.stale.length ? "warn" : "good", title: "Koersen", text: `${diagnostics.priceInfo.stale.length} koersen zijn ouder dan 7 dagen.` }
  ];
  document.getElementById("riskScoreCards").innerHTML = riskGauge(diagnostics) + rows.map(signalCard).join("");
}

function riskGauge(diagnostics) {
  const score = Math.max(0, Math.min(100, diagnostics.riskScore));
  const color = score > 65 ? "var(--bad)" : score > 40 ? "var(--warn)" : "var(--good)";
  const label = score > 65 ? "Hoog aandachtspunt" : score > 40 ? "Middelmatig" : "Rustig";
  return `<div class="risk-gauge">
    <div class="gauge-ring" style="background: conic-gradient(${color} ${(score * 3.6).toFixed(1)}deg, #e8edf3 0deg)">
      <span><strong>${score}</strong><small>/100</small></span>
    </div>
    <div class="risk-gauge-copy">
      <strong>${esc(label)}</strong>
      <p>Score op concentratie, crypto-weging, top 5, koersleeftijd en datakwaliteit.</p>
    </div>
  </div>`;
}

function renderShortTermPlan(diagnostics) {
  const rows = [
    diagnostics.planInfo.remaining > 0
      ? { tone: "warn", title: "Aankoopronde afronden", text: `Er staat nog ${currency.format(diagnostics.planInfo.remaining)} open volgens je maandplan.` }
      : { tone: "good", title: "Aankoopronde op schema", text: "De geïmporteerde aankopen dekken het maandplan." },
    diagnostics.priceInfo.stale.length
      ? { tone: "warn", title: "Koersen verversen", text: `${diagnostics.priceInfo.stale.length} koersen zijn ouder dan 7 dagen. Werk crypto live bij en aandelen/ETF via CSV/import.` }
      : { tone: "good", title: "Koersen recent", text: "Geen opvallend oude koersdata." },
    { tone: "info", title: "Nieuwe inlegadvies", text: rebalanceSuggestionText(diagnostics) }
  ];
  document.getElementById("shortTermPlan").innerHTML = rows.map(signalCard).join("");
}

function renderLongTermPlan(total, diagnostics) {
  const monthly = Math.max(diagnostics.planInfo.planned, total.dcaMonthly, averageMonthlyBuys(), 0);
  const conservative = projectValue(total.value, monthly, .03, 5);
  const base = projectValue(total.value, monthly, .06, 5);
  const optimistic = projectValue(total.value, monthly, .10, 5);
  const rows = [
    { tone: "info", title: "1 jaar", text: `Bij ${currency.format(monthly)} per maand en 6%/jaar: ${currency.format(projectValue(total.value, monthly, .06, 1))}.` },
    { tone: "info", title: "5 jaar scenario's", text: `Conservatief ${currency.format(conservative)} · basis ${currency.format(base)} · optimistisch ${currency.format(optimistic)}.` },
    { tone: diagnostics.topFiveWeight > .75 ? "warn" : "good", title: "Spreiding", text: `Top 5 weegt ${pct.format(diagnostics.topFiveWeight)}. Gebruik nieuwe inleg om concentratie te sturen.` }
  ];
  document.getElementById("longTermPlan").innerHTML = rows.map(signalCard).join("");
}

function renderScenarioSimulator(total) {
  const monthly = Number(state.ui.simMonthly || Math.max(planDiagnostics(total).planned, averageMonthlyBuys(), 0));
  const annual = Number(state.ui.simReturn || 6) / 100;
  const goal = Number(state.ui.simGoal || 50000);
  const one = projectValue(total.value, monthly, annual, 1);
  const five = projectValue(total.value, monthly, annual, 5);
  const monthsToGoal = monthsUntilGoal(total.value, monthly, annual, goal);
  const rows = [
    { tone: "info", title: "Projectie 1 jaar", text: `${currency.format(one)} bij ${currency.format(monthly)} per maand en ${pct.format(annual)} per jaar.` },
    { tone: "info", title: "Projectie 5 jaar", text: `${currency.format(five)} met dezelfde aannames.` },
    { tone: monthsToGoal ? "good" : "warn", title: "Doelwaarde", text: monthsToGoal ? `${currency.format(goal)} bereikt in circa ${monthsToGoal} maanden.` : "Doelwaarde niet bereikt binnen 30 jaar met deze aannames." }
  ];
  document.getElementById("scenarioSimulator").innerHTML = rows.map(signalCard).join("");
}

function renderRebalancePlan(diagnostics) {
  const rows = [
    { tone: "info", title: "Nieuwe inleg", text: rebalanceSuggestionText(diagnostics) },
    { tone: diagnostics.cryptoWeight > .35 ? "warn" : "good", title: "Crypto-bandbreedte", text: diagnostics.cryptoWeight > .35 ? "Stuur nieuwe DEGIRO-inleg naar ETF/aandelen tot crypto onder 35% komt." : "Crypto zit rond of onder de waarschuwingsgrens." },
    { tone: diagnostics.top?.ticker === "VWCE" && diagnostics.top.value / Math.max(diagnostics.visibleValue, 1) > .5 ? "warn" : "info", title: "Toppositie", text: diagnostics.top ? `${diagnostics.top.ticker} is de grootste positie; nieuwe inleg kan onderwogen posities versterken.` : "Nog geen positie." }
  ];
  document.getElementById("rebalancePlan").innerHTML = rows.map(signalCard).join("");
}

function signalCard(item) {
  return `<article class="analysis-signal signal-${item.tone}"><strong>${esc(item.title)}</strong><p>${esc(item.text)}</p></article>`;
}

function rebalanceSuggestionText(diagnostics) {
  if (diagnostics.cryptoWeight > .35) return `Laat BTC-DCA op €500 staan, maar stuur de DEGIRO-pot tijdelijk vooral naar ETF/IONQ/GOOGL om crypto-weging te dempen.`;
  if (diagnostics.top && diagnostics.top.value / Math.max(diagnostics.visibleValue, 1) > .45) return `Gebruik nieuwe inleg voor assets buiten ${diagnostics.top.ticker} om concentratie te verlagen zonder verkoop.`;
  return "Houd de huidige maandplannen aan en gebruik afwijkingen alleen om onderwogen categorieën bij te sturen.";
}

function projectValue(startValue, monthly, annualReturn, years) {
  let value = startValue;
  const monthlyReturn = Math.pow(1 + annualReturn, 1 / 12) - 1;
  for (let month = 0; month < years * 12; month += 1) {
    value = value * (1 + monthlyReturn) + monthly;
  }
  return value;
}

function monthsUntilGoal(startValue, monthly, annualReturn, goal) {
  let value = startValue;
  const monthlyReturn = Math.pow(1 + annualReturn, 1 / 12) - 1;
  for (let month = 1; month <= 360; month += 1) {
    value = value * (1 + monthlyReturn) + monthly;
    if (value >= goal) return month;
  }
  return null;
}

function syncSimulatorInputs(total) {
  const defaults = {
    simMonthly: Math.max(planDiagnostics(total).planned, averageMonthlyBuys(), 0),
    simReturn: 6,
    simGoal: 50000
  };
  Object.entries(defaults).forEach(([id, value]) => {
    const element = document.getElementById(id);
    if (element && !state.ui[id] && element.value !== String(value)) element.value = value;
  });
}

function portfolioRecommendations(context) {
  const rows = [];
  const topWeight = context.top ? context.top.value / Math.max(context.visibleValue, 1) : 0;
  if (topWeight > .45) rows.push({ tone: "warn", title: "Concentratie verlagen", text: `${context.top.ticker} weegt ${pct.format(topWeight)}. Nieuwe inleg kan tijdelijk naar lagere categorieën om dit af te bouwen.` });
  if (context.cryptoWeight > .35) rows.push({ tone: "warn", title: "Crypto-risico bewaken", text: `Crypto weegt ${pct.format(context.cryptoWeight)}. Zet eventueel een bovengrens of rebalance-trigger.` });
  if (!state.dcas.some((plan) => plan.active)) rows.push({ tone: "info", title: "DCA activeren", text: "Er is geen actief DCA-plan. Een brede ETF-DCA kan de portefeuille voorspelbaarder laten groeien." });
  if (context.correctionCount) rows.push({ tone: "info", title: "Correcties blijven controleren", text: `${context.correctionCount} crypto-correcties zijn actief. Controleer opnieuw na een nieuwe brokerexport.` });
  if (!rows.length) rows.push({ tone: "good", title: "Geen grote aandachtspunten", text: "Spreiding, data en inlegtempo tonen geen opvallende rode vlaggen." });
  return rows.slice(0, 5);
}

function transactionTypeStats() {
  const map = new Map();
  state.transactions.forEach((item) => {
    const row = map.get(item.type) || { type: item.type, count: 0, notional: 0 };
    row.count += 1;
    row.notional += item.quantity * item.price;
    map.set(item.type, row);
  });
  return [...map.values()].sort((a, b) => b.count - a.count);
}

function sourceStats() {
  const map = new Map();
  state.transactions.forEach((item) => {
    const source = item.source || (item.auto ? "DCA" : "Handmatig");
    const row = map.get(source) || { source, count: 0, latest: item.date };
    row.count += 1;
    if (item.date > row.latest) row.latest = item.date;
    map.set(source, row);
  });
  return [...map.values()].sort((a, b) => b.count - a.count);
}

function averageMonthlyBuys() {
  const buys = state.transactions.filter((item) => item.side === "buy" && item.quantity > 0 && item.price >= 0);
  if (!buys.length) return 0;
  const first = buys.reduce((min, item) => item.date < min ? item.date : min, buys[0].date);
  const start = new Date(`${first}T00:00:00`);
  const end = new Date(`${todayISO()}T00:00:00`);
  const months = Math.max(1, (end.getFullYear() - start.getFullYear()) * 12 + end.getMonth() - start.getMonth() + 1);
  const totalBuyValue = buys.reduce((sum, item) => sum + item.quantity * item.price, 0);
  return totalBuyValue / months;
}

function monthsSinceFirstTransaction() {
  if (!state.transactions.length) return 1;
  const first = state.transactions.reduce((min, item) => item.date < min ? item.date : min, state.transactions[0].date);
  const start = new Date(`${first}T00:00:00`);
  const end = new Date(`${todayISO()}T00:00:00`);
  return Math.max(1, (end.getFullYear() - start.getFullYear()) * 12 + end.getMonth() - start.getMonth() + 1);
}

function monthKey(date = todayISO()) {
  return String(date).slice(0, 7);
}

function monthLabel(key = monthKey()) {
  return new Intl.DateTimeFormat("nl-NL", { month: "long", year: "numeric" }).format(new Date(`${key}-01T00:00:00`));
}

function planDiagnostics(total = totals(), key = monthKey()) {
  const plans = normalizePurchasePlans(state.purchasePlans).filter((plan) => plan.active);
  const matches = plans.map((plan) => {
    const transactions = matchingPlanTransactions(plan, key);
    const actual = transactions.reduce((sum, item) => sum + Math.abs(item.quantity * item.price), 0);
    const diff = actual - plan.amount;
    const processed = state.processedMonths?.includes(`${key}:${plan.id}`);
    const status = processed ? "bevestigd" : actual <= 0 ? "gepland" : Math.abs(diff) <= Math.max(25, plan.amount * .08) ? "geimporteerd" : "afwijking";
    return { plan, transactions, actual, diff, processed, status };
  });
  const planned = matches.reduce((sum, item) => sum + item.plan.amount, 0);
  const actual = matches.reduce((sum, item) => sum + item.actual, 0);
  return {
    key,
    label: monthLabel(key),
    matches,
    planned,
    actual,
    remaining: Math.max(planned - actual, 0),
    processedCount: matches.filter((item) => item.processed).length
  };
}

function matchingPlanTransactions(plan, key) {
  const tickers = new Set(plan.tickers.map((ticker) => ticker.toUpperCase()));
  return state.transactions.filter((item) => {
    if (item.auto || item.side !== "buy" || !item.date.startsWith(key)) return false;
    if (!tickers.has(item.ticker)) return false;
    const source = (item.source || "").toLowerCase();
    const broker = String(plan.broker || "").toLowerCase();
    if (broker.includes("bitvavo")) return source.includes("bitvavo") || item.type === "Crypto";
    if (broker.includes("degiro")) return source.includes("degiro") || item.type !== "Crypto";
    return true;
  });
}

function portfolioDiagnostics(total = totals()) {
  const list = total.list.filter((item) => item.value >= 1);
  const visibleValue = list.reduce((sum, item) => sum + item.value, 0);
  const typeRows = analysisByType(list);
  const top = list[0];
  const topThreeWeight = list.slice(0, 3).reduce((sum, item) => sum + item.value, 0) / Math.max(visibleValue, 1);
  const topFiveWeight = list.slice(0, 5).reduce((sum, item) => sum + item.value, 0) / Math.max(visibleValue, 1);
  const cryptoWeight = typeRows.find((item) => item.type === "Crypto")?.weight || 0;
  const priceInfo = priceDiagnostics(total);
  const planInfo = planDiagnostics(total);
  const riskPoints = [
    top ? Math.min(35, (top.value / Math.max(visibleValue, 1)) * 55) : 0,
    Math.min(25, cryptoWeight * 45),
    Math.min(20, topFiveWeight * 20),
    Math.min(20, priceInfo.stale.length * 2)
  ];
  const riskScore = Math.round(riskPoints.reduce((sum, item) => sum + item, 0));
  return { list, visibleValue, typeRows, top, topThreeWeight, topFiveWeight, cryptoWeight, priceInfo, planInfo, riskScore };
}

function renderAudit(total) {
  const sourceRows = sourceStats();
  const corrections = correctionTransactions();
  const warnings = auditWarnings(total);
  const zeroPriceCount = state.transactions.filter((item) => Number(item.price) === 0).length;
  const lastImport = state.meta?.lastImportAt ? dateTimeNl(state.meta.lastImportAt) : "Onbekend";

  document.getElementById("auditMetrics").innerHTML = [
    metric("Transacties", number.format(state.transactions.length), `${sourceRows.length} bronnen`),
    metric("Correctieregels", number.format(corrections.length), corrections.length ? "Controleerbaar in tabel" : "Geen correcties"),
    metric("Prijs 0", number.format(zeroPriceCount), "Meestal staking, dividend of correctie"),
    metric("Laatste import", lastImport, state.meta?.lastImportFile || "Lokale opslag")
  ].join("");

  renderAuditSourcesTable(sourceRows);
  renderAuditCorrectionsTable(corrections);
  renderAuditWarnings(warnings);
  renderAuditNotes();
}

function correctionTransactions() {
  return state.transactions
    .filter((item) => /correctie|reconciliation/i.test(item.source || ""))
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}

function renderAuditSourcesTable(rows) {
  const total = Math.max(state.transactions.length, 1);
  document.getElementById("auditSourcesTable").innerHTML = `<table>
    <thead><tr><th>Bron</th><th>Aantal</th><th>Aandeel</th><th>Laatste datum</th></tr></thead>
    <tbody>${rows.map((item) => `<tr>
      <td><strong>${esc(item.source)}</strong></td>
      <td>${number.format(item.count)}</td>
      <td>${pct.format(item.count / total)}</td>
      <td>${dateNl(item.latest)}</td>
    </tr>`).join("")}</tbody>
  </table>`;
}

function renderAuditCorrectionsTable(rows) {
  const target = document.getElementById("auditCorrectionsTable");
  if (!rows.length) {
    target.innerHTML = `<div class="empty">Geen correctieregels gevonden.</div>`;
    return;
  }
  target.innerHTML = `<table>
    <thead><tr><th>Datum</th><th>Asset</th><th>Actie</th><th>Aantal</th><th>Bron</th></tr></thead>
    <tbody>${rows.slice(0, 80).map((item) => `<tr>
      <td>${dateNl(item.date)}</td>
      <td>${assetCell(item)}</td>
      <td>${item.side === "buy" ? "Aankoop" : "Verkoop"}</td>
      <td>${number.format(item.quantity)}</td>
      <td>${esc(item.source || "")}</td>
    </tr>`).join("")}</tbody>
  </table>${rows.length > 80 ? `<div class="empty">${rows.length - 80} extra correcties verborgen.</div>` : ""}`;
}

function brokerSnapshotDiagnostics(total = totals()) {
  const list = total.list || positions();
  const byTicker = new Map(list.map((item) => [item.ticker, item]));
  const cryptoExpected = Object.entries(CRYPTO_SNAPSHOT_QUANTITIES).map(([ticker, quantity]) => ({ ticker, expected: quantity, actual: byTicker.get(ticker)?.quantity || 0 }));
  list
    .filter((item) => item.type === "Crypto" && !(item.ticker in CRYPTO_SNAPSHOT_QUANTITIES))
    .forEach((item) => cryptoExpected.push({ ticker: item.ticker, expected: 0, actual: item.quantity }));

  const degiroExpected = DEGIRO_SNAPSHOT_POSITIONS.map(([ticker, _name, _type, _quantity, value]) => ({ ticker, expected: value, actual: byTicker.get(ticker)?.value || 0 }));
  const degiroTickers = new Set(DEGIRO_SNAPSHOT_POSITIONS.map(([ticker]) => ticker));
  list
    .filter((item) => (item.type === "Aandeel" || item.type === "ETF") && !degiroTickers.has(item.ticker))
    .forEach((item) => degiroExpected.push({ ticker: item.ticker, expected: 0, actual: item.value }));

  return {
    crypto: snapshotGroup(cryptoExpected, 1e-8),
    degiro: snapshotGroup(degiroExpected, .05)
  };
}

function snapshotGroup(rows, tolerance) {
  const enriched = rows.map((row) => ({ ...row, diff: Math.abs(row.actual - row.expected) })).sort((a, b) => b.diff - a.diff);
  const expected = rows.reduce((sum, row) => sum + row.expected, 0);
  const actual = rows.reduce((sum, row) => sum + row.actual, 0);
  const maxDiff = enriched[0]?.diff || 0;
  return {
    rows: enriched,
    expected,
    actual,
    maxDiff,
    ok: maxDiff <= tolerance && Math.abs(actual - expected) <= tolerance
  };
}

function auditWarnings(total) {
  const warnings = [];
  const snapshot = brokerSnapshotDiagnostics(total);
  const corrections = correctionTransactions();
  const zeroPrices = state.transactions.filter((item) => Number(item.price) === 0);
  const unsupportedPrices = positions().filter((item) => !state.prices?.[item.ticker] && item.currentPrice <= 0);
  const unknownSources = state.transactions.filter((item) => !item.source && !item.auto);
  const small = total.list.filter((item) => item.value < 1);
  const cryptoCorrections = state.transactions.filter((item) => item.source === "Crypto screenshot reconciliation");
  const degiroCorrections = state.transactions.filter((item) => item.source === "DEGIRO positiecorrectie");

  warnings.push(snapshotSignal("Bitvavo aantallen", snapshot.crypto, number.format));
  warnings.push(snapshotSignal("DEGIRO snapshot", snapshot.degiro, currency.format));
  if (corrections.length) warnings.push({ tone: "info", title: "Correctieregels actief", text: `${corrections.length} regels corrigeren posities na broker-exports of screenshots.` });
  if (cryptoCorrections.length) warnings.push({ tone: "warn", title: "Crypto-reconciliatie", text: `${cryptoCorrections.length} crypto-regels trekken Bitvavo-historie gelijk met de huidige app-aantallen.` });
  if (degiroCorrections.length) warnings.push({ tone: "info", title: "DEGIRO-positiecorrectie", text: `${degiroCorrections.length} regels corrigeren corporate actions of gesloten restposities.` });
  if (zeroPrices.length) warnings.push({ tone: "info", title: "Prijs nul", text: `${zeroPrices.length} transacties hebben prijs 0. Dat is normaal voor staking/withdrawals/correcties, maar goed om zichtbaar te houden.` });
  if (unsupportedPrices.length) warnings.push({ tone: "bad", title: "Ontbrekende actuele prijzen", text: `${unsupportedPrices.length} posities hebben geen bruikbare actuele prijs.` });
  if (unknownSources.length) warnings.push({ tone: "warn", title: "Onbekende bron", text: `${unknownSources.length} handmatige transacties hebben geen bronlabel.` });
  if (small.length) warnings.push({ tone: "info", title: "Restposities", text: `${small.length} posities zijn minder dan €1 waard.` });
  if (!warnings.length) warnings.push({ tone: "good", title: "Geen issues", text: "Geen opvallende datakwaliteitsproblemen gevonden." });
  return warnings;
}

function snapshotSignal(title, group, formatValue) {
  const worst = group.rows[0];
  if (group.ok) {
    return { tone: "good", title, text: `${formatValue(group.actual)} actueel, verwacht ${formatValue(group.expected)}. Grootste verschil ${formatValue(group.maxDiff)}.` };
  }
  return { tone: "bad", title, text: `${formatValue(group.actual)} actueel, verwacht ${formatValue(group.expected)}. Grootste afwijking: ${worst ? `${worst.ticker} ${formatValue(worst.diff)}` : formatValue(group.maxDiff)}.` };
}

function renderAuditWarnings(warnings) {
  document.getElementById("auditWarnings").innerHTML = warnings.map((item) => `<article class="analysis-signal signal-${item.tone}">
    <strong>${esc(item.title)}</strong>
    <p>${esc(item.text)}</p>
  </article>`).join("");
}

// Global window trigger to run backup recovery if needed
window.restoreBackup = restoreBackup;

function renderAuditNotes() {
  const notes = Array.isArray(state.notes) ? state.notes : [];
  const meta = state.meta || {};
  const rows = [
    meta.sourceVersion ? `Datasetversie: ${meta.sourceVersion}` : "",
    meta.lastImportAt ? `Laatst geïmporteerd: ${dateTimeNl(meta.lastImportAt)}` : "",
    meta.lastImportFile ? `Laatste bestand: ${meta.lastImportFile}` : "",
    ...notes
  ].filter(Boolean);
  document.getElementById("auditNotes").innerHTML = rows.length
    ? rows.map((text) => `<article class="analysis-signal signal-info"><p>${esc(text)}</p></article>`).join("")
    : `<div class="empty">Geen importnotities beschikbaar.</div>`;
}

function renderWatchlist(total) {
  const rows = state.watchlist || [];
  document.getElementById("watchlistTable").innerHTML = rows.length ? `<table>
    <thead><tr><th>Ticker</th><th>Prijs</th><th>Koopdoel</th><th>Afstand</th><th>Notitie</th><th></th></tr></thead>
    <tbody>${rows.map((item) => {
      const price = currentAssetPrice(item.ticker, item.currentPrice);
      const distance = item.targetPrice ? (price - item.targetPrice) / item.targetPrice : 0;
      const tone = price <= item.targetPrice ? "good" : price <= item.targetPrice * 1.05 ? "warn" : "info";
      return `<tr>
        <td>${assetCell(item)}</td>
        <td>${currency.format(price)}</td>
        <td>${currency.format(item.targetPrice)}</td>
        <td><span class="status-pill ${tone}">${price <= item.targetPrice ? "koopzone" : pct.format(distance)}</span></td>
        <td>${esc(item.note || "")}</td>
        <td><button class="icon-btn" title="Verwijder" onclick="removeWatchlistItem('${escAttr(item.id)}')">×</button></td>
      </tr>`;
    }).join("")}</tbody>
  </table>` : `<div class="empty">Nog geen watchlist-items.</div>`;

  const signals = rows
    .map((item) => ({ ...item, livePrice: currentAssetPrice(item.ticker, item.currentPrice) }))
    .sort((a, b) => (a.livePrice - a.targetPrice) / Math.max(a.targetPrice, 1) - (b.livePrice - b.targetPrice) / Math.max(b.targetPrice, 1))
    .slice(0, 4);
  document.getElementById("watchlistSignals").innerHTML = signals.length
    ? signals.map((item) => signalCard({
      tone: item.livePrice <= item.targetPrice ? "good" : item.livePrice <= item.targetPrice * 1.05 ? "warn" : "info",
      title: item.ticker,
      text: `${currency.format(item.livePrice)} versus koopdoel ${currency.format(item.targetPrice)}. ${item.note || "Geen notitie."}`
    })).join("")
    : `<div class="empty">Voeg kandidaten toe om koopzones te zien.</div>`;
  renderWatchlistSuggestions(total);
}

function renderWatchlistSuggestions(total) {
  const target = document.getElementById("watchlistSuggestions");
  if (!target) return;
  const existing = new Set((state.watchlist || []).map((item) => item.ticker));
  const suggestions = watchlistSuggestions(total).filter((item) => !existing.has(item.ticker)).slice(0, 4);
  target.innerHTML = suggestions.length
    ? suggestions.map((item) => `<article class="recommendation-card">
      <strong>${esc(item.title)}</strong>
      <p>${esc(item.text)}</p>
      <button class="ghost-btn" type="button" onclick="prefillWatchlist('${escAttr(item.ticker)}','${escAttr(item.name)}','${escAttr(item.type)}',${Number(item.currentPrice)},${Number(item.targetPrice)},'${escAttr(item.note)}')">Gebruik suggestie</button>
    </article>`).join("")
    : `<div class="empty">Geen nieuwe suggesties uit je huidige posities.</div>`;
}

function watchlistSuggestions(total) {
  const list = total.list.filter((item) => item.value >= 1 && item.currentPrice > 0);
  if (!list.length) return [];
  const suggestions = [];
  const add = (item, title, text, targetFactor, note) => {
    if (!item || suggestions.some((entry) => entry.ticker === item.ticker)) return;
    suggestions.push({
      title,
      text,
      ticker: item.ticker,
      name: item.name,
      type: item.type,
      currentPrice: item.currentPrice,
      targetPrice: Number((item.currentPrice * targetFactor).toFixed(4)),
      note
    });
  };
  const value = Math.max(total.value, 1);
  const broadEtf = list.find((item) => item.ticker === "VWCE" || item.ticker === "VWRL" || item.type === "ETF");
  const best = [...list].sort((a, b) => b.gainPct - a.gainPct)[0];
  const laggard = [...list].sort((a, b) => a.gainPct - b.gainPct)[0];
  const smallestCore = [...list].filter((item) => item.value / value < .08).sort((a, b) => b.currentPrice - a.currentPrice)[0];
  add(
    broadEtf,
    "Kernpositie volgen",
    `${broadEtf?.ticker || "ETF"} is een brede basispositie. Zet een koopdoel onder de actuele koers om nieuwe inleg gedisciplineerd te plannen.`,
    .95,
    "Portfolio-suggestie: kernpositie volgen bij pullback."
  );
  add(
    best,
    "Sterke positie op pullback",
    `${best?.ticker || "Deze positie"} heeft het beste rendement in je portefeuille. Volgen bij een terugval voorkomt haastige aankopen.`,
    .92,
    "Portfolio-suggestie: sterke positie alleen bijkopen bij terugval."
  );
  add(
    laggard,
    "Achterblijver evalueren",
    `${laggard?.ticker || "Deze positie"} blijft achter. Zet een lager koopdoel en gebruik de notitie om je thesis opnieuw te checken.`,
    .9,
    "Portfolio-suggestie: achterblijver volgen, thesis controleren."
  );
  add(
    smallestCore,
    "Kleine positie monitoren",
    `${smallestCore?.ticker || "Deze positie"} is nog klein binnen je portefeuille. Een watchlist-doel maakt opschalen bewuster.`,
    .94,
    "Portfolio-suggestie: kleine positie bewust opschalen."
  );
  return suggestions;
}

function renderAllocation(total) {
  const rows = allocationRows(total);
  document.getElementById("allocationMetrics").innerHTML = [
    metric("Doelsom", `${number.format(rows.reduce((sum, item) => sum + item.targetPct, 0))}%`, "Streef naar 100%"),
    metric("Grootste afwijking", rows[0] ? `${rows[0].type} ${pct.format(rows[0].diffPct / 100)}` : "Geen", "Absoluut verschil"),
    metric("Rebalance nodig", rows.some((item) => Math.abs(item.diffPct) >= 5) ? "Ja" : "Nee", "Grens: 5 procentpunt"),
    metric("Nieuwe inleg", allocationSuggestion(rows), "Zonder verkoop")
  ].join("");
  document.getElementById("allocationTable").innerHTML = `<table>
    <thead><tr><th>Categorie</th><th>Huidig</th><th>Doel</th><th>Afwijking</th><th>Actie</th></tr></thead>
    <tbody>${rows.map((item) => `<tr>
      <td>${typeBadge(item.type)}</td>
      <td>${allocationPercentCell(currency.format(item.value), item.currentPct, typeColor(item.type))}</td>
      <td>${allocationPercentCell(pct.format(item.targetPct / 100), item.targetPct, "var(--accent-5)")}</td>
      <td>${diffBadge(item.diffPct)}</td>
      <td>${item.diffPct < -2 ? "Bijkopen met nieuwe inleg" : item.diffPct > 5 ? "Geen nieuwe inleg nodig" : "Op koers"}</td>
    </tr>`).join("")}</tbody>
  </table>`;
  document.getElementById("allocationSignals").innerHTML = `<div class="allocation-card-grid">${rows.map(allocationCard).join("")}</div>`;
}

function allocationCard(item) {
  const tone = Math.abs(item.diffPct) >= 5 ? "warn" : "good";
  const color = typeColor(item.type);
  const bg = tone === "warn" ? "var(--warn-soft)" : "var(--good-soft)";
  return `<article class="allocation-card" style="--card-color:${color};--card-bg:${bg}">
    <div class="allocation-card-head">
      <strong>${esc(item.type)}</strong>
      ${diffBadge(item.diffPct)}
    </div>
    <div class="allocation-bars">
      ${allocationBar("Huidig", item.currentPct, color)}
      ${allocationBar("Doel", item.targetPct, "var(--accent-5)")}
    </div>
    <p class="muted">${item.diffPct < -2 ? "Onderwogen: stuur nieuwe inleg hierheen." : item.diffPct > 5 ? "Overwogen: pauzeer nieuwe inleg." : "Op koers binnen de bandbreedte."}</p>
  </article>`;
}

function allocationBar(label, value, color) {
  return `<div>
    <div class="allocation-bar-label"><span>${esc(label)}</span><span>${pct.format(value / 100)}</span></div>
    <span class="mini-track"><span class="mini-fill" style="width:${Math.max(2, Math.min(100, value)).toFixed(1)}%;--mini-color:${color};--mini-color-2:${color}"></span></span>
  </div>`;
}

function allocationPercentCell(label, value, color) {
  return visualValueCell(label, pct.format(value / 100), Math.max(2, Math.min(100, value)), color);
}

function diffBadge(diffPct) {
  const tone = Math.abs(diffPct) < 2 ? "good" : Math.abs(diffPct) < 5 ? "warn" : "bad";
  return `<span class="status-pill ${tone}">${diffPct >= 0 ? "+" : ""}${number.format(diffPct)} pp</span>`;
}

function incomeNetCell(item) {
  const gross = Number(item.amount || 0);
  const net = gross - Number(item.tax || 0);
  const retained = gross ? net / gross * 100 : 0;
  return visualValueCell(currency.format(net), `${number.format(retained)}% netto`, retained, "var(--type-income)");
}

function targetDistanceCell(price, target, direction) {
  const distance = target ? (price - target) / target : 0;
  const hit = direction === "below" ? price <= target : price >= target;
  const tone = hit ? "good" : Math.abs(distance) < .05 ? "warn" : "info";
  const label = `${currency.format(target)} · ${distance >= 0 ? "+" : ""}${pct.format(distance)}`;
  return `<div class="visual-cell">
    <div class="visual-cell-row"><strong>${currency.format(target)}</strong><span class="status-pill ${tone}">${hit ? "geraakt" : "open"}</span></div>
    <span class="muted">${esc(label)}</span>
  </div>`;
}

function renderIncome(total) {
  const rows = [...(state.incomeItems || [])].sort((a, b) => b.date.localeCompare(a.date));
  const year = String(state.ui.taxYear || new Date().getFullYear());
  const yearRows = rows.filter((item) => String(item.date || "").startsWith(year));
  const gross = rows.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const tax = rows.reduce((sum, item) => sum + Number(item.tax || 0), 0);
  const yearly = yearRows.reduce((sum, item) => sum + Number(item.amount || 0) - Number(item.tax || 0), 0);
  document.getElementById("incomeMetrics").innerHTML = [
    metric("Bruto totaal", currency.format(gross), `${rows.length} inkomsten`),
    metric("Netto totaal", currency.format(gross - tax), "Na vastgelegde belasting/fee"),
    metric(`Netto ${year}`, currency.format(yearly), `${yearRows.length} regels`),
    metric("Maandgemiddelde", currency.format(yearly / 12), "Voor gekozen jaar")
  ].join("");
  document.getElementById("incomeTable").innerHTML = rows.length ? `<table>
    <thead><tr><th>Datum</th><th>Ticker</th><th>Type</th><th>Bruto</th><th>Netto</th><th></th></tr></thead>
    <tbody>${rows.map((item) => `<tr>
      <td>${dateNl(item.date)}</td><td><strong>${esc(item.ticker)}</strong></td><td>${typeBadge(item.kind)}</td>
      <td>${currency.format(item.amount)}</td><td>${incomeNetCell(item)}</td>
      <td><button class="icon-btn" title="Verwijder" onclick="removeIncomeItem('${escAttr(item.id)}')">×</button></td>
    </tr>`).join("")}</tbody>
  </table>` : `<div class="empty">Nog geen dividend, staking of rente ingevoerd.</div>`;
  renderTaxReport(total, year, yearRows);
}

function renderTaxReport(total, year, incomeRows) {
  const txRows = state.transactions.filter((item) => String(item.date || "").startsWith(year));
  const buys = txRows.filter((item) => item.side === "buy").reduce((sum, item) => sum + item.quantity * item.price, 0);
  const sells = txRows.filter((item) => item.side === "sell").reduce((sum, item) => sum + item.quantity * item.price, 0);
  const netIncome = incomeRows.reduce((sum, item) => sum + Number(item.amount || 0) - Number(item.tax || 0), 0);
  document.getElementById("taxReport").innerHTML = [
    { tone: "info", title: `Jaar ${year}`, text: `${txRows.length} transacties, ${incomeRows.length} inkomstenregels.` },
    { tone: "info", title: "Transacties", text: `Aankopen ${currency.format(buys)} · verkopen ${currency.format(sells)}.` },
    { tone: "info", title: "Inkomsten", text: `Netto dividend/staking/rente: ${currency.format(netIncome)}.` },
    { tone: "warn", title: "Controle", text: "Gebruik dit als werkoverzicht; fiscale regels en peildata blijven handmatig te controleren." }
  ].map(signalCard).join("");
}

function renderStrategy(total) {
  renderStrategyTable(total);
  renderSalePlans(total);
  renderAlerts(total);
  renderSnapshots();
}

function renderStrategyTable(total) {
  const rows = total.list.map((item) => ({ ...item, meta: (state.tags || {})[item.ticker] || {} }));
  document.getElementById("strategyTable").innerHTML = rows.length ? `<table>
    <thead><tr><th>Positie</th><th>Tags</th><th>Thesis</th><th>Risico</th></tr></thead>
    <tbody>${rows.map((item) => `<tr>
      <td>${assetCell(item)}</td><td>${esc(item.meta.tags || "")}</td><td>${esc(item.meta.thesis || "")}</td><td>${esc(item.meta.risk || "")}</td>
    </tr>`).join("")}</tbody>
  </table>` : `<div class="empty">Nog geen posities.</div>`;
}

function renderSalePlans(total) {
  const rows = Object.entries(state.salePlans || {}).map(([ticker, plan]) => ({ ticker, ...plan, price: currentAssetPrice(ticker, 0) }));
  document.getElementById("salePlanTable").innerHTML = rows.length ? `<table>
    <thead><tr><th>Ticker</th><th>Prijs</th><th>Doel</th><th>Stop</th><th>Plan</th><th></th></tr></thead>
    <tbody>${rows.map((item) => `<tr>
      <td>${esc(item.ticker)}</td><td>${currency.format(item.price)}</td>
      <td>${item.targetPrice ? targetDistanceCell(item.price, item.targetPrice, "above") : "-"}</td><td>${item.stopPrice ? targetDistanceCell(item.price, item.stopPrice, "below") : "-"}</td>
      <td>${esc(item.note || "")}</td><td><button class="icon-btn" onclick="removeSalePlan('${escAttr(item.ticker)}')">×</button></td>
    </tr>`).join("")}</tbody>
  </table>` : `<div class="empty">Nog geen verkoopplannen.</div>`;
}

function renderAlerts(total) {
  const rows = state.alerts || [];
  const evaluated = rows.map((item) => ({ ...item, priceNow: currentAssetPrice(item.ticker, 0) }));
  document.getElementById("alertSignals").innerHTML = evaluated.length ? evaluated.map((item) => {
    const hit = item.direction === "below" ? item.priceNow <= item.price : item.priceNow >= item.price;
    return signalCard({ tone: hit ? "warn" : "info", title: `${item.ticker} ${hit ? "geraakt" : "open"}`, text: `${currency.format(item.priceNow)} nu, grens ${item.direction === "below" ? "onder" : "boven"} ${currency.format(item.price)}. ${item.note || ""}` });
  }).join("") : `<div class="empty">Nog geen koersalerts.</div>`;
  document.getElementById("alertTable").innerHTML = rows.length ? `<table>
    <thead><tr><th>Ticker</th><th>Richting</th><th>Grens</th><th>Notitie</th><th></th></tr></thead>
    <tbody>${evaluated.map((item) => {
      const hit = item.direction === "below" ? item.priceNow <= item.price : item.priceNow >= item.price;
      return `<tr><td><strong>${esc(item.ticker)}</strong></td><td><span class="status-pill ${hit ? "warn" : "info"}">${item.direction === "below" ? "Onder" : "Boven"}</span></td><td>${targetDistanceCell(item.priceNow, item.price, item.direction === "below" ? "below" : "above")}</td><td>${esc(item.note || "")}</td><td><button class="icon-btn" onclick="removeAlert('${escAttr(item.id)}')">×</button></td></tr>`;
    }).join("")}</tbody>
  </table>` : `<div class="empty">Nog geen alerts.</div>`;
}

function renderSnapshots() {
  const rows = [...(state.snapshots || [])].sort((a, b) => b.date.localeCompare(a.date));
  document.getElementById("snapshotTable").innerHTML = rows.length ? `<table>
    <thead><tr><th>Datum</th><th>Waarde</th><th>Kostprijs</th><th>Rendement</th><th></th></tr></thead>
    <tbody>${rows.map((item) => `<tr>
      <td>${dateTimeNl(item.date)}</td><td>${currency.format(item.value)}</td><td>${currency.format(item.cost)}</td><td>${currency.format(item.gain)}</td>
      <td><button class="icon-btn" onclick="removeSnapshot('${escAttr(item.id)}')">×</button></td>
    </tr>`).join("")}</tbody>
  </table>` : `<div class="empty">Nog geen snapshots.</div>`;
}

function allocationRows(total) {
  const grouped = groupByType(total.list);
  const target = normalizeTargetAllocation(state.targetAllocation);
  return Object.keys(target).map((type) => {
    const value = grouped.find((item) => item.type === type)?.value || 0;
    const currentPct = total.value ? value / total.value * 100 : 0;
    const targetPct = target[type] || 0;
    return { type, value, currentPct, targetPct, diffPct: currentPct - targetPct };
  }).sort((a, b) => Math.abs(b.diffPct) - Math.abs(a.diffPct));
}

function allocationSuggestion(rows) {
  const under = [...rows].sort((a, b) => a.diffPct - b.diffPct)[0];
  return under && under.diffPct < -1 ? under.type : "Op koers";
}

function currentAssetPrice(ticker, fallback) {
  const pos = positions().find((item) => item.ticker === ticker);
  return priceOf(ticker, fallback || pos?.currentPrice || 0);
}

function renderSettings() {
  const overrides = [...new Set([...Object.keys(state.avgPrices || {}), ...Object.keys(state.avgPriceCorrections || {})])];
  document.getElementById("avgOverrideSummary").innerHTML = overrides.length
    ? `${overrides.length} positie(s): ${overrides.map((ticker) => {
      const correction = state.avgPriceCorrections?.[ticker];
      return correction ? `${esc(ticker)} vanaf ${esc(dateNl(correction.date))}` : esc(ticker);
    }).join(", ")}`
    : "Geen handmatige gemiddelde aankoopkoersen ingesteld.";
}

function showImportStatus(fileName) {
  const status = document.getElementById("importStatus");
  if (!status) return;
  const cryptoAdjustments = state.transactions.filter((item) => item.source === "Crypto screenshot reconciliation").length;
  const visibleCrypto = positions().filter((item) => item.type === "Crypto" && item.value >= 1).map((item) => item.ticker).sort().join(", ");
  status.innerHTML = `Import gelukt: ${esc(fileName)} · ${state.transactions.length} transacties · ${cryptoAdjustments} crypto-correcties · zichtbaar: ${esc(visibleCrypto || "geen")}`;
}

function syncControls() {
  const controls = {
    positionSearch: state.ui.positionSearch,
    positionSort: state.ui.positionSort,
    positionDir: state.ui.positionDir,
    transactionSearch: state.ui.transactionSearch,
    transactionTypeFilter: state.ui.transactionTypeFilter,
    transactionSideFilter: state.ui.transactionSideFilter,
    transactionLimit: state.ui.transactionLimit,
    transactionGroup: state.ui.transactionGroup,
    taxYear: state.ui.taxYear || new Date().getFullYear()
  };
  Object.entries(controls).forEach(([id, value]) => {
    const element = document.getElementById(id);
    if (element && element.value !== value) element.value = value;
  });
  document.getElementById("defaultHideSmall").checked = !!state.settings.defaultHideSmallPositions;
  document.getElementById("defaultHideSmallTransactions").checked = !!state.settings.defaultHideSmallTransactions;
  Object.entries(normalizeTargetAllocation(state.targetAllocation)).forEach(([name, value]) => {
    const input = document.querySelector(`#allocationForm [name="${name}"]`);
    if (input && input.value !== String(value)) input.value = value;
  });
  const incomeDate = document.querySelector("#incomeForm [name=date]");
  if (incomeDate && !incomeDate.value) incomeDate.value = todayISO();
}

function renderDcaCards() {
  const target = document.getElementById("dcaCards");
  if (!state.dcas.length) {
    target.innerHTML = `<article class="dca-card"><h3>Geen DCA-plannen</h3><p class="muted">Maak een plan aan om periodieke aankopen automatisch mee te nemen.</p></article>`;
    return;
  }
  target.innerHTML = state.dcas.map((plan) => {
    const count = dcaDates(plan.startDate, plan.frequency, todayISO()).length;
    const frequency = { weekly: "Wekelijks", monthly: "Maandelijks", quarterly: "Per kwartaal" }[plan.frequency];
    const assets = normalizeDcaAssets(plan);
    const assetLabel = assets.map((asset) => `${asset.ticker} ${number.format(asset.quantity)}`).join(" · ");
    const value = dcaPlanValue(plan);
    return `<article class="dca-card">
      <div class="asset"><div class="badge">${(assets[0]?.ticker || plan.name || "DC").slice(0, 2)}</div><div><h3>${plan.name}</h3><span>${esc(assetLabel || "Geen assets")}</span></div></div>
      <div class="dca-meta">
        <div><span>Assets</span><strong>${number.format(assets.length)}</strong></div>
        <div><span>Waarde</span><strong>${currency.format(value)}</strong></div>
        <div><span>Interval</span><strong>${frequency}</strong></div>
        <div><span>Start</span><strong>${dateNl(plan.startDate)}</strong></div>
        <div><span>Gegenereerd</span><strong>${plan.active ? count : 0}x</strong></div>
      </div>
      <div class="actions-row">
        <button class="ghost-btn" onclick="toggleDca('${plan.id}')">${plan.active ? "Pauzeer" : "Activeer"}</button>
        <button class="ghost-btn danger" onclick="removeDca('${plan.id}')">Verwijder</button>
      </div>
    </article>`;
  }).join("");
}

function renderDcaSuggestions(total) {
  const target = document.getElementById("dcaSuggestions");
  if (!target) return;
  const visible = total.list.filter((item) => item.value >= 1);
  const typeRows = analysisByType(visible);
  const suggested = dcaSuggestions(total, typeRows);
  target.innerHTML = suggested.map((item) => `<article class="recommendation-card">
    <strong>${esc(item.title)}</strong>
    <p>${esc(item.text)}</p>
    <button class="ghost-btn" type="button" onclick="prefillDca('${escAttr(item.ticker)}','${escAttr(item.name)}','${escAttr(item.type)}',${Number(item.quantity)},${Number(item.price)})">Gebruik suggestie</button>
  </article>`).join("");
}

function dcaSuggestions(total, typeRows) {
  const value = Math.max(total.value, 1);
  const weights = Object.fromEntries(typeRows.map((row) => [row.type, row.weight]));
  const suggestions = [];
  const broadEtf = total.list.find((item) => item.ticker === "VWCE" || item.ticker === "VWRL" || item.type === "ETF");
  const top = total.list[0];
  const monthlyBase = Math.max(100, Math.round((averageMonthlyBuys() || total.value * .01) / 25) * 25);
  if ((weights.ETF || 0) < .6 && broadEtf) {
    suggestions.push({
      title: "ETF als basis versterken",
      text: `ETF weegt nu ${pct.format(weights.ETF || 0)}. Een maandelijkse DCA richting ${broadEtf.ticker} kan de kern rustiger maken.`,
      ticker: broadEtf.ticker,
      name: broadEtf.name,
      type: broadEtf.type,
      quantity: suggestedQuantity(monthlyBase, broadEtf.currentPrice),
      price: broadEtf.currentPrice
    });
  }
  if ((weights.Crypto || 0) > .35 && broadEtf) {
    suggestions.push({
      title: "Nieuwe inleg weg van crypto",
      text: `Crypto weegt ${pct.format(weights.Crypto)}. Nieuwe DCA naar ${broadEtf.ticker} verlaagt die weging zonder verkoop.`,
      ticker: broadEtf.ticker,
      name: broadEtf.name,
      type: broadEtf.type,
      quantity: suggestedQuantity(monthlyBase, broadEtf.currentPrice),
      price: broadEtf.currentPrice
    });
  }
  if (top && top.value / value > .45 && broadEtf && top.ticker !== broadEtf.ticker) {
    suggestions.push({
      title: "Toppositie verdunnen",
      text: `${top.ticker} is ${pct.format(top.value / value)}. DCA naar een bredere positie maakt de portefeuille minder afhankelijk van één asset.`,
      ticker: broadEtf.ticker,
      name: broadEtf.name,
      type: broadEtf.type,
      quantity: suggestedQuantity(monthlyBase, broadEtf.currentPrice),
      price: broadEtf.currentPrice
    });
  }
  if (!suggestions.length && broadEtf) {
    suggestions.push({
      title: "Consistente kern-DCA",
      text: `Geen grote disbalans gevonden. Een vaste DCA naar ${broadEtf.ticker} houdt de discipline erin.`,
      ticker: broadEtf.ticker,
      name: broadEtf.name,
      type: broadEtf.type,
      quantity: suggestedQuantity(monthlyBase, broadEtf.currentPrice),
      price: broadEtf.currentPrice
    });
  }
  return suggestions;
}

function suggestedQuantity(amount, price) {
  return price > 0 ? Number((amount / price).toFixed(6)) : 0;
}

window.prefillDca = (ticker, name, type, quantity, price) => {
  switchView("dca");
  const form = document.getElementById("dcaForm");
  form.name.value = `${ticker} maandelijks`;
  form.type.value = type;
  setDcaDraftAssets([{ ticker, name, type, quantity }]);
  form.frequency.value = "monthly";
  form.startDate.value = todayISO();
  form.active.value = "true";
  form.name.focus();
};

window.removeDcaAssetDraft = (ticker) => {
  setDcaDraftAssets(dcaDraftAssets().filter((asset) => asset.ticker !== ticker));
};

function renderInsights(total) {
  const biggest = total.list[0];
  const best = [...total.list].sort((a, b) => b.gainPct - a.gainPct)[0];
  const dcaRunway = total.dcaMonthly ? total.value / total.dcaMonthly : 0;
  const visible = total.list.filter((item) => item.value >= 1);
  const typeRows = analysisByType(visible);
  const crypto = typeRows.find((item) => item.type === "Crypto");
  document.getElementById("insights").innerHTML = [
    insight("Grootste positie", biggest ? `${biggest.ticker} is ${pct.format(biggest.value / total.value)} van je portefeuille.` : "Voeg je eerste transactie toe."),
    insight("Beste rendement", best ? `${best.ticker} staat op ${pct.format(best.gainPct)} sinds aankoop.` : "Nog geen rendement beschikbaar."),
    insight("DCA-tempo", total.dcaMonthly ? `Je automatische inleg is circa ${currency.format(total.dcaMonthly)} per maand. Dat is ${pct.format(1 / Math.max(dcaRunway, 1))} van je huidige waarde.` : "Er is nog geen actief DCA-plan."),
    insight("Categorieën", typeRows.length ? typeRows.map((row) => `${row.type} ${pct.format(row.weight)}`).join(" · ") : "Nog geen categorieën."),
    insight("Crypto-risico", crypto ? `Crypto weegt ${pct.format(crypto.weight)} en staat op ${currency.format(crypto.gain)} rendement.` : "Geen crypto boven €1 zichtbaar."),
    insight("Datakwaliteit", `${correctionTransactions().length} correctieregels · ${sourceStats().length} bronnen.`)
  ].join("");
}

function insight(title, text) {
  const color = title.includes("Crypto") ? "var(--type-crypto)" : title.includes("DCA") ? "var(--type-income)" : title.includes("rendement") ? "var(--accent-2)" : "var(--accent)";
  const bg = title.includes("Crypto") ? "var(--surface-gold)" : title.includes("DCA") ? "var(--surface-green)" : title.includes("rendement") ? "var(--surface-pink)" : "var(--surface-blue)";
  return `<article class="insight" style="--insight-color:${color};--insight-bg:${bg}"><h3>${esc(title)}</h3><p>${esc(text)}</p></article>`;
}

function assetCell(item) {
  const color = typeColor(item.type);
  return `<div class="asset">
    <div class="badge" style="--badge-color:${color}22">${esc(String(item.ticker || "?").slice(0, 2))}</div>
    <div>
      <strong>${esc(item.ticker)}</strong>
      <span>${esc(item.name)}</span>
      <div class="asset-meta">${typeBadge(item.type)}</div>
    </div>
  </div>`;
}

function resultPill(gain, gainPct) {
  const positive = gain >= 0;
  return `<span class="result-pill ${positive ? "" : "loss"}">
    <span>${currency.format(gain)}</span>
    <small>${pct.format(gainPct)}</small>
  </span>`;
}

function typeColor(type) {
  const normalized = String(type || "").toLowerCase();
  if (normalized.includes("crypto")) return "var(--type-crypto)";
  if (normalized.includes("etf")) return "var(--type-etf)";
  if (normalized.includes("aandeel")) return "var(--type-stock)";
  if (normalized.includes("gemengd")) return "var(--type-mixed)";
  if (normalized.includes("dividend") || normalized.includes("staking") || normalized.includes("rente")) return "var(--type-income)";
  return "var(--accent-5)";
}

function typeBadge(type) {
  const color = typeColor(type);
  return `<span class="type-badge" style="--badge-bg:color-mix(in srgb, ${color} 14%, white);--badge-ink:${color}">${esc(type || "Onbekend")}</span>`;
}

function sideBadge(side) {
  return `<span class="side-badge ${side === "sell" ? "sell" : "buy"}">${side === "sell" ? "Verkoop" : "Aankoop"}</span>`;
}

function positionValueCell(item, list) {
  const total = list.reduce((sum, row) => sum + row.value, 0);
  const weight = item.value / Math.max(total, 1);
  return visualValueCell(currency.format(item.value), pct.format(weight), Math.min(100, weight * 100), typeColor(item.type));
}

function transactionValueCell(item) {
  const value = Math.abs(item.quantity * item.price);
  const color = item.side === "sell" ? "var(--bad)" : "var(--good)";
  return visualValueCell(currency.format(value), item.source || (item.auto ? "DCA" : "Handmatig"), Math.min(100, value / 1000 * 100), color);
}

function visualValueCell(primary, secondary, width, color) {
  return `<div class="visual-cell">
    <div class="visual-cell-row"><strong>${esc(primary)}</strong><span class="muted">${esc(secondary)}</span></div>
    <span class="mini-track"><span class="mini-fill" style="width:${Math.max(2, Math.min(100, width)).toFixed(1)}%;--mini-color:${color};--mini-color-2:${color}"></span></span>
  </div>`;
}

function priceStatusBadge(ticker) {
  const info = state.priceMeta?.[ticker];
  if (!info) return `<span class="price-badge stale" title="Geen koersbron bekend">Onbekend<small>geen datum</small></span>`;
  const ageDays = Math.floor((Date.now() - new Date(info.updatedAt).getTime()) / 86400000);
  const stale = !Number.isFinite(ageDays) || ageDays > 7;
  const source = info.source || "Prijs";
  const label = Number.isFinite(ageDays) ? `${ageDays} dagen oud` : "datum onbekend";
  return `<span class="price-badge ${stale ? "stale" : ""}" title="${escAttr(source)} · ${escAttr(label)}">${esc(source)}<small>${esc(label)}</small></span>`;
}

function priceInline(item) {
  const info = state.priceMeta?.[item.ticker];
  const source = info?.source || "Import";
  const ageDays = info ? Math.floor((Date.now() - new Date(info.updatedAt).getTime()) / 86400000) : NaN;
  const stale = !Number.isFinite(ageDays) || ageDays > 7;
  const manual = /handmatig|csv|import/i.test(source) && !/coingecko/i.test(source);
  const title = `${source} · ${Number.isFinite(ageDays) ? `${ageDays} dagen oud` : "datum onbekend"}. Crypto kan live via CoinGecko; aandelen/ETF via import, CSV or handmatig.`;
  return `<span class="price-inline" title="${escAttr(title)}">${currency.format(item.currentPrice)}<span class="price-dot ${stale ? "stale" : manual ? "manual" : ""}"></span></span>`;
}

function priceDiagnostics(total = totals()) {
  const positionsList = total.list || positions();
  const now = Date.now();
  const stale = positionsList.filter((item) => {
    const info = state.priceMeta?.[item.ticker];
    if (!info) return true;
    const age = Math.floor((now - new Date(info.updatedAt).getTime()) / 86400000);
    return !Number.isFinite(age) || age > 7;
  });
  const cryptoInfos = positionsList
    .filter((item) => item.type === "Crypto")
    .map((item) => state.priceMeta?.[item.ticker])
    .filter(Boolean)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  const liveCrypto = cryptoInfos.find((info) => /coingecko/i.test(info.source || ""));
  const manualCount = positionsList.filter((item) => /handmatig|csv|import/i.test(state.priceMeta?.[item.ticker]?.source || "")).length;
  return {
    stale,
    liveCryptoAt: liveCrypto?.updatedAt || null,
    manualCount,
    totalPrices: positionsList.length
  };
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function escAttr(value) {
  return esc(value).replace(/`/g, "&#96;");
}

function portfolioHistory(months) {
  const end = new Date(`${todayISO()}T00:00:00`);
  const start = new Date(end);
  start.setMonth(start.getMonth() - months);
  const points = [];
  for (let cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 7)) {
    const date = cursor.toISOString().slice(0, 10);
    const value = positionsAt(date).reduce((sum, item) => sum + item.value, 0);
    points.push({ date, value });
  }
  return points;
}

function positionsAt(date) {
  const active = state.transactions
    .filter((item) => item.date <= date)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  const map = new Map();
  active.forEach((item) => {
    if (!map.has(item.ticker)) map.set(item.ticker, { ticker: item.ticker, value: 0, quantity: 0, currentPrice: item.currentPrice });
    const pos = map.get(item.ticker);
    if (item.side === "sell") pos.quantity = Math.max(0, pos.quantity - item.quantity);
    else pos.quantity += item.quantity;
    pos.currentPrice = priceOf(item.ticker, item.currentPrice || pos.currentPrice);
    pos.value = pos.quantity * pos.currentPrice;
  });
  return [...map.values()].filter((item) => item.quantity > 0);
}

function drawLineChart(canvas, points) {
  const ctx = setupCanvas(canvas);
  const { width, height } = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, width, height);
  const pad = 42;
  const values = points.map((point) => point.value);
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  drawGrid(ctx, width, height, pad);
  const areaGradient = ctx.createLinearGradient(0, pad, 0, height - pad);
  areaGradient.addColorStop(0, "rgba(19,124,155,.30)");
  areaGradient.addColorStop(.55, "rgba(47,174,137,.14)");
  areaGradient.addColorStop(1, "rgba(217,87,123,0)");
  ctx.beginPath();
  points.forEach((point, index) => {
    const x = pad + (index / Math.max(points.length - 1, 1)) * (width - pad * 1.5);
    const y = height - pad - ((point.value - min) / Math.max(max - min, 1)) * (height - pad * 1.6);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.lineTo(width - pad / 2, height - pad);
  ctx.lineTo(pad, height - pad);
  ctx.closePath();
  ctx.fillStyle = areaGradient;
  ctx.fill();
  ctx.beginPath();
  points.forEach((point, index) => {
    const x = pad + (index / Math.max(points.length - 1, 1)) * (width - pad * 1.5);
    const y = height - pad - ((point.value - min) / Math.max(max - min, 1)) * (height - pad * 1.6);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.lineWidth = 4;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const lineGradient = ctx.createLinearGradient(pad, 0, width - pad, 0);
  lineGradient.addColorStop(0, "#137c9b");
  lineGradient.addColorStop(.52, "#2fae89");
  lineGradient.addColorStop(1, "#d9577b");
  ctx.strokeStyle = lineGradient;
  ctx.stroke();
  axisLabel(ctx, currency.format(max), pad, pad - 12);
  axisLabel(ctx, currency.format(min), pad, height - 12);
  if (points.length > 1) {
    axisLabel(ctx, dateNl(points[0].date), pad, height - 28);
    axisLabel(ctx, dateNl(points[points.length - 1].date), width - 112, height - 28);
  }
  const hover = Number.isInteger(valueChartHoverIndex) ? points[valueChartHoverIndex] : null;
  if (hover) {
    const x = pad + (valueChartHoverIndex / Math.max(points.length - 1, 1)) * (width - pad * 1.5);
    const y = height - pad - ((hover.value - min) / Math.max(max - min, 1)) * (height - pad * 1.6);
    ctx.strokeStyle = "rgba(23,34,53,.28)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, pad);
    ctx.lineTo(x, height - pad);
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#147f9d";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  canvas.onmousemove = (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const index = Math.max(0, Math.min(points.length - 1, Math.round(((x - pad) / Math.max(width - pad * 1.5, 1)) * (points.length - 1))));
    valueChartHoverIndex = index;
    const point = points[index];
    showChartTooltip(event, `<strong>${dateNl(point.date)}</strong>${currency.format(point.value)}`);
    drawLineChart(canvas, points);
  };
  canvas.onmouseleave = () => {
    valueChartHoverIndex = null;
    hideChartTooltip();
    drawLineChart(canvas, points);
  };
}

function drawAllocationChart(canvas, list) {
  const ctx = setupCanvas(canvas);
  const { width, height } = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, width, height);
  const grouped = groupByType(list);
  const total = grouped.reduce((sum, item) => sum + item.value, 0);
  const colors = chartColors();
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) * .28;
  let angle = -Math.PI / 2;
  allocationSegments = [];
  if (!total) {
    ctx.fillStyle = "#e9eef3";
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  grouped.forEach((item, index) => {
    const next = angle + (item.value / total) * Math.PI * 2;
    const active = allocationHoverIndex === index;
    const mid = (angle + next) / 2;
    const offset = active ? 8 : 0;
    const ox = Math.cos(mid) * offset;
    const oy = Math.sin(mid) * offset;
    ctx.beginPath();
    ctx.moveTo(cx + ox, cy + oy);
    ctx.arc(cx + ox, cy + oy, active ? radius + 5 : radius, angle, next);
    ctx.fillStyle = colors[index % colors.length];
    ctx.fill();
    allocationSegments.push({ ...item, start: angle, end: next, color: colors[index % colors.length], total });
    angle = next;
  });
  ctx.globalCompositeOperation = "destination-out";
  ctx.beginPath();
  ctx.arc(cx, cy, radius * .58, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = "#172235";
  ctx.textAlign = "center";
  ctx.font = "700 16px Inter, sans-serif";
  ctx.fillText(currency.format(total), cx, cy - 2);
  ctx.fillStyle = "#66758d";
  ctx.font = "12px Inter, sans-serif";
  ctx.fillText(`${grouped.length} categorieen`, cx, cy + 17);
  ctx.textAlign = "left";
  canvas.onmousemove = (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left - cx;
    const y = event.clientY - rect.top - cy;
    const distance = Math.hypot(x, y);
    let angleAt = Math.atan2(y, x);
    if (angleAt < -Math.PI / 2) angleAt += Math.PI * 2;
    const index = distance >= radius * .5 && distance <= radius * 1.25
      ? allocationSegments.findIndex((segment) => angleAt >= segment.start && angleAt <= segment.end)
      : -1;
    allocationHoverIndex = index >= 0 ? index : null;
    if (allocationHoverIndex !== null) {
      const segment = allocationSegments[allocationHoverIndex];
      showChartTooltip(event, `<strong>${esc(segment.type)}</strong>${currency.format(segment.value)} · ${pct.format(segment.value / Math.max(segment.total, 1))}`);
    } else {
      hideChartTooltip();
    }
    drawAllocationChart(canvas, list);
  };
  canvas.onmouseleave = () => {
    allocationHoverIndex = null;
    hideChartTooltip();
    drawAllocationChart(canvas, list);
  };
}

function drawTopHoldingsChart(canvas, list) {
  const ctx = setupCanvas(canvas);
  const { width, height } = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, width, height);
  const rows = list.slice(0, 8);
  if (!rows.length || width <= 0 || height <= 0) return;
  const total = list.reduce((sum, item) => sum + item.value, 0);
  const max = Math.max(...rows.map((item) => item.value), 1);
  const left = 76;
  const right = 24;
  const top = 16;
  const rowGap = 6;
  const barHeight = Math.max(14, Math.min(24, (height - top * 2 - rowGap * (rows.length - 1)) / rows.length));
  rows.forEach((item, index) => {
    const y = top + index * (barHeight + rowGap);
    const barWidth = ((width - left - right) * item.value) / max;
    ctx.fillStyle = "#647084";
    ctx.font = "12px Inter, sans-serif";
    ctx.fillText(truncateCanvasText(ctx, item.ticker, left - 24), 16, y + barHeight * .72);
    ctx.fillStyle = "#e8edf3";
    fillRoundedRect(ctx, left, y, width - left - right, barHeight, 7);
    ctx.fillStyle = chartColors()[index % chartColors().length];
    fillRoundedRect(ctx, left, y, barWidth, barHeight, 7);
    ctx.fillStyle = barWidth > 145 ? "#ffffff" : "#18212f";
    ctx.font = "12px Inter, sans-serif";
    const labelMaxWidth = barWidth > 145 ? Math.max(90, barWidth - 20) : Math.max(88, width - left - right - barWidth - 12);
    const label = truncateCanvasText(ctx, `${currency.format(item.value)} · ${pct.format(item.value / Math.max(total, 1))}`, labelMaxWidth);
    const labelX = barWidth > 145 ? left + 10 : Math.min(left + barWidth + 8, Math.max(left + 8, width - 112));
    ctx.fillText(label, Math.max(labelX, left + 8), y + barHeight * .72);
  });
}

function drawTypePerformanceChart(canvas, rows) {
  const ctx = setupCanvas(canvas);
  const { width, height } = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, width, height);
  if (!rows.length || width <= 0 || height <= 0) return;
  const pad = 52;
  const max = Math.max(...rows.flatMap((item) => [item.value, item.cost]), 1);
  drawGrid(ctx, width, height, pad);
  const groupWidth = (width - pad * 2) / rows.length;
  const barWidth = Math.min(28, groupWidth / 3.2);
  rows.forEach((item, index) => {
    const x = pad + index * groupWidth + groupWidth / 2;
    const costHeight = ((height - pad * 1.8) * item.cost) / max;
    const valueHeight = ((height - pad * 1.8) * item.value) / max;
    ctx.fillStyle = "#d7dee8";
    fillRoundedRect(ctx, x - barWidth - 3, height - pad - costHeight, barWidth, costHeight, 6);
    ctx.fillStyle = item.gain >= 0 ? "#187a4d" : "#b23b44";
    fillRoundedRect(ctx, x + 3, height - pad - valueHeight, barWidth, valueHeight, 6);
    ctx.fillStyle = "#647084";
    ctx.font = "12px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(truncateCanvasText(ctx, item.type, Math.max(44, groupWidth - 8)), x, height - 14);
    ctx.fillStyle = item.gain >= 0 ? "#10845c" : "#c2495a";
    ctx.font = "11px Inter, sans-serif";
    ctx.fillText(pct.format(item.gainPct), x, Math.max(18, height - pad - Math.max(costHeight, valueHeight) - 8));
  });
  ctx.textAlign = "left";
  ctx.fillStyle = "#d7dee8";
  ctx.fillRect(pad, 14, 12, 12);
  axisLabel(ctx, "kostprijs", pad + 18, 24);
  ctx.fillStyle = "#10845c";
  ctx.fillRect(pad + 100, 14, 12, 12);
  axisLabel(ctx, "waarde", pad + 118, 24);
}

function showChartTooltip(event, html) {
  let tooltip = document.getElementById("chartTooltip");
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.id = "chartTooltip";
    tooltip.className = "chart-tooltip";
    document.body.appendChild(tooltip);
  }
  tooltip.innerHTML = html;
  tooltip.style.left = `${Math.min(window.innerWidth - 240, event.clientX + 14)}px`;
  tooltip.style.top = `${Math.max(10, event.clientY - 18)}px`;
}

function hideChartTooltip() {
  document.getElementById("chartTooltip")?.remove();
}

function chartColors() {
  return ["#137c9b", "#d9577b", "#f0a43a", "#2fae89", "#6b6fd6", "#79a83b", "#c2495a"];
}

function setupCanvas(canvas) {
  const ratio = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.floor(rect.width * ratio);
  canvas.height = Math.floor(rect.height * ratio);
  const ctx = canvas.getContext("2d");
  ctx.scale(ratio, ratio);
  return ctx;
}

function drawGrid(ctx, width, height, pad) {
  ctx.strokeStyle = "rgba(123,139,161,.22)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 5; i += 1) {
    const y = pad + i * ((height - pad * 1.6) / 4);
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(width - pad / 2, y);
    ctx.stroke();
  }
}

function axisLabel(ctx, text, x, y) {
  ctx.fillStyle = "#647084";
  ctx.font = "12px Inter, sans-serif";
  ctx.fillText(text, x, y);
}

// Global window trigger to filter positions
window.filterPositionsByType = filterPositionsByType;

function truncateCanvasText(ctx, text, maxWidth) {
  const value = String(text || "");
  if (ctx.measureText(value).width <= maxWidth) return value;
  let output = value;
  while (output.length > 1 && ctx.measureText(`${output}...`).width > maxWidth) {
    output = output.slice(0, -1);
  }
  return `${output}...`;
}

function fillRoundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, Math.abs(width) / 2, Math.abs(height) / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.fill();
}

function groupByType(list) {
  const map = new Map();
  list.forEach((item) => map.set(item.type, (map.get(item.type) || 0) + item.value));
  return [...map.entries()].map(([type, value]) => ({ type, value })).sort((a, b) => b.value - a.value);
}

function dateNl(date) {
  return new Intl.DateTimeFormat("nl-NL", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(`${date}T00:00:00`));
}

function dateTimeNl(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Onbekend";
  return new Intl.DateTimeFormat("nl-NL", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

function openModal() {
  document.getElementById("txModal").classList.add("open");
  document.querySelector("#txForm [name=date]").value = todayISO();
  document.querySelector("#txForm [name=ticker]").focus();
}

function closeModal() {
  document.getElementById("txModal").classList.remove("open");
}

function openPricesModal() {
  const list = positions();
  const form = document.getElementById("pricesForm");
  if (!list.length) {
    form.innerHTML = `<div class="empty">Voeg eerst een transactie toe.</div>`;
  } else {
    const cryptoCount = list.filter((item) => item.type === "Crypto" && COINGECKO_IDS[item.ticker]).length;
    const equityCount = list.filter((item) => isEquityQuotePosition(item)).length;
    form.innerHTML = `
      <div class="status-box" id="priceStatus">
        <strong>Actuele prijzen</strong><br>
        Crypto kan live via CoinGecko. Aandelen en ETF's kunnen live via Yahoo Finance, handmatig, of met een CSV met kolommen <code>ticker,price</code>.
      </div>
      <div class="actions-row start">
        <button class="ghost-btn" type="button" onclick="updateCryptoPrices()" ${cryptoCount ? "" : "disabled"}>Live crypto-prijzen</button>
        <button class="ghost-btn" type="button" onclick="updateEquityPrices()" ${equityCount ? "" : "disabled"}>Live aandelen/ETF's</button>
        <button class="ghost-btn" type="button" onclick="exportPriceTemplate()">Download template</button>
        <button class="ghost-btn" type="button" onclick="document.getElementById('priceFileInput').click()">Importeer prijs-CSV</button>
      </div>
      <div class="form-grid">${list.map((item) => `
      <label>${item.ticker} · ${item.name}
        <input name="price-${item.ticker}" required type="number" inputmode="decimal" min="0" step="any" value="${item.currentPrice}">
      </label>
    `).join("")}</div><button class="primary-btn" type="submit">Prijzen opslaan</button>`;
  }
  document.getElementById("pricesModal").classList.add("open");
}

function closePricesModal() {
  document.getElementById("pricesModal").classList.remove("open");
}

function openPositionDetail(ticker) {
  const item = positions().find((pos) => pos.ticker === ticker);
  if (!item) return;
  const transactionsList = state.transactions
    .filter((txItem) => txItem.ticker === ticker)
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 12);
  const correction = state.avgPriceCorrections?.[ticker];
  document.getElementById("positionTitle").textContent = `${item.ticker} · ${item.name}`;
  document.getElementById("positionDetail").innerHTML = `
    <div class="detail-grid">
      <div class="detail-stat"><span>Aantal</span><strong>${number.format(item.quantity)}</strong></div>
      <div class="detail-stat"><span>Waarde</span><strong>${currency.format(item.value)}</strong></div>
      <div class="detail-stat"><span>Gem. prijs</span><strong>${currency.format(item.avgPrice)}</strong></div>
      <div class="detail-stat"><span>Rendement</span><strong class="${item.gain >= 0 ? "gain" : "loss"}">${currency.format(item.gain)} · ${pct.format(item.gainPct)}</strong></div>
    </div>
    <form id="avgPriceForm">
      <div class="form-grid">
        <label>Gemiddelde aankoopprijs
          <input name="avgPrice" type="number" inputmode="decimal" min="0" step="any" value="${item.avgPrice}">
        </label>
        <label>Correctie vanaf
          <input name="correctionDate" type="date" value="${correction?.date || todayISO()}">
        </label>
        <label>Actuele prijs
          <input name="currentPrice" type="number" inputmode="decimal" min="0" step="any" value="${item.currentPrice}">
        </label>
      </div>
      <div class="actions-row">
        <button class="ghost-btn" type="button" onclick="resetAveragePrice('${escAttr(item.ticker)}')">Reset gemiddelde</button>
        <button class="primary-btn" type="submit">Opslaan</button>
      </div>
    </form>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Datum</th><th>Type</th><th>Aantal</th><th>Prijs</th></tr></thead>
        <tbody>${transactionsList.map((txItem) => `<tr>
          <td>${dateNl(txItem.date)}</td>
          <td>${txItem.side === "buy" ? "Aankoop" : "Verkoop"}</td>
          <td>${number.format(txItem.quantity)}</td>
          <td>${currency.format(txItem.price)}</td>
        </tr>`).join("")}</tbody>
      </table>
    </div>`;
  document.getElementById("avgPriceForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    const avgPrice = parsePriceNumber(data.avgPrice);
    const currentPrice = parsePriceNumber(data.currentPrice);
    state.avgPriceCorrections = state.avgPriceCorrections || {};
    if (Number.isFinite(avgPrice) && avgPrice >= 0) {
      state.avgPriceCorrections[item.ticker] = {
        avgPrice,
        date: data.correctionDate || todayISO(),
        createdAt: new Date().toISOString()
      };
      delete state.avgPrices[item.ticker];
    }
    if (Number.isFinite(currentPrice) && currentPrice > 0) state.prices[item.ticker] = currentPrice;
    state.priceMeta = state.priceMeta || {};
    state.priceMeta[item.ticker] = { source: "Handmatig", updatedAt: new Date().toISOString() };
    persist();
    render();
    openPositionDetail(item.ticker);
  });
  document.getElementById("positionModal").classList.add("open");
}

function closePositionModal() {
  document.getElementById("positionModal").classList.remove("open");
}

window.removeTransaction = (id) => {
  state.transactions = state.transactions.filter((item) => item.id !== id);
  persist();
  render();
};

window.openPosition = openPositionDetail;

window.resetAveragePrice = (ticker) => {
  delete state.avgPrices[ticker];
  if (state.avgPriceCorrections) delete state.avgPriceCorrections[ticker];
  persist();
  render();
  openPositionDetail(ticker);
};

window.showMoreTransactions = () => {
  const current = state.ui.transactionLimit === "all" ? "all" : Number(state.ui.transactionLimit || 100);
  state.ui.transactionLimit = current === "all" ? "all" : String(Math.min(current * 2, filteredTransactions().length));
  persist();
  render();
};

window.resetTransactionFilters = () => {
  state.ui.transactionSearch = "";
  state.ui.transactionTypeFilter = "all";
  state.ui.transactionSideFilter = "all";
  state.ui.transactionLimit = "100";
  state.ui.transactionGroup = "month";
  state.ui.transactionSpecialFilter = "all";
  persist();
  render();
};

window.markCurrentMonthProcessed = () => {
  const key = monthKey();
  const ids = planDiagnostics(totals(), key).matches.map((item) => `${key}:${item.plan.id}`);
  state.processedMonths = [...new Set([...(state.processedMonths || []), ...ids])];
  persist();
  render();
};

window.removeWatchlistItem = (id) => {
  state.watchlist = (state.watchlist || []).filter((item) => item.id !== id);
  persist();
  render();
};

window.prefillWatchlist = (ticker, name, type, currentPrice, targetPrice, note) => {
  switchView("watchlist");
  const form = document.getElementById("watchlistForm");
  form.ticker.value = ticker;
  form.name.value = name;
  form.type.value = type;
  form.currentPrice.value = Number(currentPrice || 0).toFixed(4);
  form.targetPrice.value = Number(targetPrice || 0).toFixed(4);
  form.note.value = note || "";
  form.ticker.focus();
};

window.removeIncomeItem = (id) => {
  state.incomeItems = (state.incomeItems || []).filter((item) => item.id !== id);
  persist();
  render();
};

window.removeSalePlan = (ticker) => {
  delete state.salePlans[ticker];
  persist();
  render();
};

window.removeAlert = (id) => {
  state.alerts = (state.alerts || []).filter((item) => item.id !== id);
  persist();
  render();
};

window.captureSnapshot = () => {
  const total = totals();
  state.snapshots = [...(state.snapshots || []), {
    id: uid(),
    date: new Date().toISOString(),
    value: total.value,
    cost: total.cost,
    gain: total.gain,
    positions: total.list.length
  }];
  persist();
  render();
};

window.removeSnapshot = (id) => {
  state.snapshots = (state.snapshots || []).filter((item) => item.id !== id);
  persist();
  render();
};

window.updateCryptoPrices = async (options = {}) => {
  const cryptoPositions = positions().filter((item) => item.type === "Crypto" && COINGECKO_IDS[item.ticker]);
  if (!cryptoPositions.length) {
    showPriceStatus("Geen ondersteunde crypto-posities gevonden.", true);
    return;
  }
  showPriceStatus("Crypto-prijzen ophalen...");
  try {
    const ids = [...new Set(cryptoPositions.map((item) => COINGECKO_IDS[item.ticker]))];
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids.join(","))}&vs_currencies=eur`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`CoinGecko gaf status ${response.status}.`);
    const payload = await response.json();
    const updates = {};
    cryptoPositions.forEach((item) => {
      const price = Number(payload[COINGECKO_IDS[item.ticker]]?.eur);
      if (Number.isFinite(price) && price > 0) updates[item.ticker] = price;
    });
    const result = applyPriceUpdates(updates, "CoinGecko");
    if (!options.keepModalOpen) openPricesModal();
    showPriceStatus(`${result.updated} live crypto-prijzen bijgewerkt via CoinGecko.`);
    return result;
  } catch (error) {
    showPriceStatus(`Live prijzen ophalen lukte niet: ${error.message || "onbekende fout"}.`, true);
    return { updated: 0, error };
  }
};

function isEquityQuotePosition(item) {
  return item.type === "Aandeel" || item.type === "ETF";
}

async function fetchUsdEurRate() {
  const response = await fetch(USD_EUR_RATE_URL);
  if (!response.ok) throw new Error(`Wisselkoers gaf status ${response.status}.`);
  const payload = await response.json();
  const rate = Number(payload?.rates?.EUR);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("USD/EUR-wisselkoers ontbreekt.");
  return rate;
}

async function fetchYahooChartQuote(item) {
  const symbol = resolveEquityQuoteSymbol(item.ticker);
  const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
  const urls = [
    yahooUrl,
    `${YAHOO_CHART_PROXY}${encodeURIComponent(yahooUrl)}`
  ];
  const errors = [];

  for (const url of urls) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`status ${response.status}`);
      const quote = parseYahooChartQuote(await response.json());
      if (!quote) throw new Error("geen geldige koers");
      return { ...quote, ticker: item.ticker, requestedSymbol: symbol };
    } catch (error) {
      errors.push(error.message || "fetch mislukt");
    }
  }

  throw new Error(`Yahoo niet bereikbaar (${errors.join(", ")})`);
}

window.updateEquityPrices = async (options = {}) => {
  const equityPositions = positions().filter((item) => isEquityQuotePosition(item));
  if (!equityPositions.length) {
    showPriceStatus("Geen aandelen/ETF-posities gevonden.", true);
    return { updated: 0, skipped: [] };
  }

  showPriceStatus("Live aandelen/ETF-koersen ophalen...");
  const quotes = [];
  const skipped = [];

  for (const item of equityPositions) {
    try {
      quotes.push(await fetchYahooChartQuote(item));
    } catch (error) {
      skipped.push(`${item.ticker}: ${error.message || "geen koers"}`);
    }
  }

  let usdEurRate = null;
  if (quotes.some((quote) => quote.currency === "USD")) {
    try {
      usdEurRate = await fetchUsdEurRate();
    } catch (error) {
      quotes
        .filter((quote) => quote.currency === "USD")
        .forEach((quote) => skipped.push(`${quote.ticker}: USD/EUR-conversie niet beschikbaar`));
    }
  }

  const updates = {};
  let converted = 0;
  quotes.forEach((quote) => {
    const convertedQuote = convertQuoteToEur(quote, usdEurRate);
    if (!convertedQuote) {
      if (quote.currency !== "USD" || usdEurRate) skipped.push(`${quote.ticker}: valuta ${quote.currency} niet ondersteund`);
      return;
    }
    updates[quote.ticker] = convertedQuote.priceEur;
    if (quote.currency === "USD") converted += 1;
  });

  if (!Object.keys(updates).length) {
    const detail = skipped.length ? ` ${skipped.join("; ")}.` : "";
    showPriceStatus(`Geen aandelen/ETF-koersen bijgewerkt.${detail}`, true);
    return { updated: 0, skipped };
  }

  const result = applyPriceUpdates(updates, "Yahoo Finance live");
  if (!options.keepModalOpen) openPricesModal();
  const skippedText = skipped.length ? ` ${skipped.length} overgeslagen: ${skipped.join("; ")}.` : "";
  const convertedText = converted ? ` ${converted} USD-koersen omgerekend naar EUR.` : "";
  showPriceStatus(`${result.updated} live aandelen/ETF-koersen bijgewerkt via Yahoo Finance.${convertedText}${skippedText}`);
  return { ...result, skipped };
};

window.exportPriceTemplate = () => {
  const rows = ["ticker,price,name,type", ...positions().map((item) => [
    item.ticker,
    formatCsvNumber(item.currentPrice),
    csvCell(item.name),
    item.type
  ].join(","))];
  const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `portfolio-prijzen-${todayISO()}.csv`;
  link.click();
  URL.revokeObjectURL(url);
};

function removeSmallPositions() {
  const smallTickers = positions().filter((item) => item.value < 1).map((item) => item.ticker);
  if (!smallTickers.length) return;
  state.transactions = state.transactions.filter((item) => !smallTickers.includes(item.ticker));
  smallTickers.forEach((ticker) => {
    delete state.prices[ticker];
    delete state.avgPrices[ticker];
    if (state.priceMeta) delete state.priceMeta[ticker];
  });
  persist();
  render();
}

function formatCsvNumber(value) {
  return Number(value || 0).toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function applyPriceUpdates(updates, source = "Handmatig") {
  const tickers = new Set(positions().map((item) => item.ticker));
  let updated = 0;
  state.prices = state.prices || {};
  state.priceMeta = state.priceMeta || {};
  const updatedAt = new Date().toISOString();
  Object.entries(updates).forEach(([ticker, price]) => {
    if (!tickers.has(ticker)) return;
    state.prices[ticker] = price;
    state.priceMeta[ticker] = { source, updatedAt };
    state.transactions = state.transactions.map((item) => item.ticker === ticker ? { ...item, currentPrice: price } : item);
    updated += 1;
  });
  persist();
  render();
  return { updated };
}

function showPriceStatus(message, isError = false) {
  const status = document.getElementById("priceStatus");
  if (!status) return;
  status.innerHTML = `<strong>${isError ? "Let op" : "Status"}</strong><br>${esc(message)}`;
  status.style.borderColor = isError ? "rgba(178,59,68,.45)" : "var(--line)";
  status.style.color = isError ? "var(--bad)" : "var(--muted)";
}

async function refreshAssetPrices() {
  openPricesModal();
  const cryptoPositions = positions().filter((item) => item.type === "Crypto" && COINGECKO_IDS[item.ticker]);
  const otherCount = positions().filter((item) => !(item.type === "Crypto" && COINGECKO_IDS[item.ticker])).length;
  if (!cryptoPositions.length) {
    showPriceStatus("Geen ondersteunde live crypto-posities gevonden. Aandelen/ETF blijven handmatig, CSV of import.", true);
    return;
  }
  showPriceStatus("Live crypto-koersen ophalen...");
  const result = await updateCryptoPrices({ keepModalOpen: true });
  if (result?.error) return;
  if (otherCount) {
    showPriceStatus(`Crypto-koersen bijgewerkt. ${otherCount} aandelen/ETF-posities blijven op import, CSV of handmatige koersdata.`);
  }
}

function autoFixCryptoIfNeeded() {
  const current = positions();
  const staleSnapshotCrypto = Object.entries(CRYPTO_SNAPSHOT_QUANTITIES).some(([ticker, targetQuantity]) => {
    const item = current.find((pos) => pos.ticker === ticker);
    return !item || Math.abs(item.quantity - targetQuantity) > 1e-8;
  });
  const staleUnknownCrypto = current.some((item) => item.type === "Crypto" && !(item.ticker in CRYPTO_SNAPSHOT_QUANTITIES) && item.quantity > 1e-8);
  if (staleSnapshotCrypto || staleUnknownCrypto) {
    fixCryptoSnapshot({ silent: true });
  } else {
    removeZeroCryptoTargets();
    markCryptoSnapshotPrices();
  }
}

function markCryptoSnapshotPrices() {
  state.priceMeta = state.priceMeta || {};
  const updatedAt = new Date().toISOString();
  Object.entries(CRYPTO_SNAPSHOT_PRICES).forEach(([ticker, price]) => {
    const stored = Number(state.prices?.[ticker]);
    if (Number.isFinite(stored) && Math.abs(stored - price) < 1e-8) {
      state.priceMeta[ticker] = { source: "Bitvavo screenshot", updatedAt };
    }
  });
}

function autoFixDegiroIfNeeded() {
  const hasDegiroSnapshotData = state.transactions.some((item) => /^DEGIRO (positiecorrectie|screenshot snapshot|Account\.csv)$/i.test(item.source || ""));
  const hasDemoEquities = isDemoEquityState();
  if (hasDemoEquities) {
    fixDegiroSnapshot({ silent: true, replaceDemoEquities: true });
    return;
  }
  if (!hasDegiroSnapshotData) return;
  const current = positions();
  const stale = DEGIRO_SNAPSHOT_POSITIONS.some(([ticker, _name, _type, _quantity, value]) => {
    const item = current.find((pos) => pos.ticker === ticker);
    return !item || Math.abs(item.value - value) > .05;
  });
  if (stale) fixDegiroSnapshot({ silent: true });
}

function isDemoEquityState() {
  const hasDegiroSnapshotData = state.transactions.some((item) => /^DEGIRO /i.test(item.source || ""));
  if (hasDegiroSnapshotData) return false;
  const equityPositions = positions().filter((item) => item.type === "Aandeel" || item.type === "ETF");
  if (!equityPositions.length) return false;
  const tickers = new Set(equityPositions.map((item) => item.ticker));
  const onlyDemoTickers = [...tickers].every((ticker) => ["ASML", "VWCE"].includes(ticker));
  const hasDemoDca = (state.dcas || []).some((plan) => plan.ticker === "VWCE" && /vwce maandelijks/i.test(plan.name || ""));
  return onlyDemoTickers && tickers.has("ASML") && tickers.has("VWCE") && hasDemoDca;
}

function fixDegiroSnapshot(options = {}) {
  state.transactions = state.transactions.filter((item) => {
    if (["DEGIRO positiecorrectie", "DEGIRO screenshot snapshot"].includes(item.source)) return false;
    if (options.replaceDemoEquities && (item.type === "Aandeel" || item.type === "ETF" || item.type === "Gemengd")) return false;
    return true;
  });
  if (options.replaceDemoEquities) {
    state.dcas = (state.dcas || []).filter((plan) => !(plan.ticker === "VWCE" && /vwce maandelijks/i.test(plan.name || "")));
    delete state.prices?.ASML;
    delete state.avgPrices?.ASML;
    if (state.priceMeta) delete state.priceMeta.ASML;
  }
  state.prices = state.prices || {};
  state.priceMeta = state.priceMeta || {};
  const updatedAt = new Date().toISOString();
  const targets = new Map(DEGIRO_SNAPSHOT_POSITIONS.map(([ticker, name, type, quantity, value]) => {
    const price = value / quantity;
    state.prices[ticker] = price;
    state.priceMeta[ticker] = { source: "DEGIRO screenshot", updatedAt };
    return [ticker, { ticker, name, type, quantity, price }];
  }));

  const degiroTickers = new Set([
    ...targets.keys(),
    ...state.transactions
      .filter((item) => /^DEGIRO /i.test(item.source || ""))
      .map((item) => item.ticker)
  ]);
  const quantities = {};
  state.transactions
    .filter((item) => degiroTickers.has(item.ticker))
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .forEach((item) => {
      const sign = item.side === "sell" ? -1 : 1;
      quantities[item.ticker] = (quantities[item.ticker] || 0) + sign * item.quantity;
      if (Math.abs(quantities[item.ticker]) < 1e-8) quantities[item.ticker] = 0;
    });

  [...new Set([...degiroTickers, ...targets.keys()])].forEach((ticker) => {
    const target = targets.get(ticker);
    const targetQuantity = target ? target.quantity : 0;
    const currentQuantity = quantities[ticker] || 0;
    const difference = targetQuantity - currentQuantity;
    if (Math.abs(difference) < 1e-8) return;
    const existing = state.transactions.find((item) => item.ticker === ticker);
    const price = target?.price || state.prices[ticker] || existing?.currentPrice || 0;
    state.transactions.push(tx(
      ticker,
      target?.name || existing?.name || ticker,
      target?.type || existing?.type || "Aandeel",
      difference > 0 ? "buy" : "sell",
      DEGIRO_SNAPSHOT_DATE,
      Math.abs(difference),
      price,
      price,
      false
    ));
    state.transactions[state.transactions.length - 1].source = existing ? "DEGIRO positiecorrectie" : "DEGIRO screenshot snapshot";
  });

  persist();
  if (!options.silent) {
    render();
    showImportStatus("DEGIRO snapshot herstel");
  }
}

function fixCryptoSnapshot(options = {}) {
  state.transactions = state.transactions.filter((item) => item.source !== "Crypto screenshot reconciliation");
  removeZeroCryptoTargets();
  state.prices = { ...(state.prices || {}), ...CRYPTO_SNAPSHOT_PRICES };
  markCryptoSnapshotPrices();

  const cryptoQuantities = {};
  state.transactions
    .filter((item) => item.type === "Crypto")
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .forEach((item) => {
      const sign = item.side === "sell" ? -1 : 1;
      cryptoQuantities[item.ticker] = (cryptoQuantities[item.ticker] || 0) + sign * item.quantity;
      if (Math.abs(cryptoQuantities[item.ticker]) < 1e-8) cryptoQuantities[item.ticker] = 0;
    });

  Object.entries(CRYPTO_SNAPSHOT_QUANTITIES).forEach(([ticker, targetQuantity]) => {
    const price = CRYPTO_SNAPSHOT_PRICES[ticker] || state.prices[ticker] || 0;
    const currentQuantity = cryptoQuantities[ticker] || 0;
    const difference = targetQuantity - currentQuantity;
    if (Math.abs(difference) < 1e-8) return;
    state.transactions.push(tx(
      ticker,
      cryptoName(ticker),
      "Crypto",
      difference > 0 ? "buy" : "sell",
      CRYPTO_SNAPSHOT_DATE,
      Math.abs(difference),
      price,
      price,
      false
    ));
    state.transactions[state.transactions.length - 1].source = "Crypto screenshot reconciliation";
  });

  state.settings.defaultHideSmallPositions = true;
  state.ui.hideSmallPositions = true;
  persist();
  if (!options.silent) {
    render();
    showImportStatus("crypto snapshot herstel");
  }
}

function replaceCryptoWithSnapshot(options = {}) {
  state.transactions = state.transactions.filter((item) => item.type !== "Crypto");
  state.prices = { ...(state.prices || {}), ...CRYPTO_SNAPSHOT_PRICES };
  state.avgPrices = state.avgPrices || {};
  state.priceMeta = state.priceMeta || {};

  Object.keys(CRYPTO_SNAPSHOT_QUANTITIES).forEach((ticker) => {
    delete state.avgPrices[ticker];
  });

  Object.entries(CRYPTO_SNAPSHOT_QUANTITIES).forEach(([ticker, targetQuantity]) => {
    const price = CRYPTO_SNAPSHOT_PRICES[ticker] || 0;
    if (!price || targetQuantity <= 0) return;
    state.transactions.push(tx(
      ticker,
      cryptoName(ticker),
      "Crypto",
      "buy",
      CRYPTO_SNAPSHOT_DATE,
      targetQuantity,
      price,
      price,
      false
    ));
    state.transactions[state.transactions.length - 1].source = "Bitvavo screenshot snapshot";
  });

  markCryptoSnapshotPrices();
  state.settings.defaultHideSmallPositions = true;
  state.ui.hideSmallPositions = true;
  persist();
  if (!options.silent) {
    render();
    showImportStatus("Bitvavo snapshot herstel");
  }
}

function cryptoName(ticker) {
  return {
    BTC: "Bitcoin",
    ETH: "Ethereum",
    SOL: "Solana",
    ZK: "zkSync",
    OP: "Optimism",
    TIA: "Celestia",
    ADA: "Cardano",
    DOGE: "Dogecoin",
    LINK: "Chainlink"
  }[ticker] || ticker;
}

window.removeDca = (id) => {
  state.dcas = state.dcas.filter((plan) => plan.id !== id);
  state.transactions = state.transactions.filter((item) => item.dcaId !== id);
  persist();
  render();
};

window.toggleDca = (id) => {
  state.dcas = state.dcas.map((plan) => plan.id === id ? { ...plan, active: !plan.active } : plan);
  applyDcaPlans();
  persist();
  render();
};

window.addEventListener("resize", () => render());
document.querySelector("#dcaForm [name=startDate]").value = todayISO();
