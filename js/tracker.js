    const STORAGE_KEY = "portfolio-tracker-v1";
    // Stateless helpers komen uit de gedeelde bibliotheek (js/portfolioMath.js).
    const {
      parsePriceNumber,
      parsePriceCsv,
      parseYahooChartQuote,
      convertQuoteToEur,
      resolveEquityQuoteSymbol,
      normalizeDcaAssets,
      dcaPlanQuantity,
      dcaDates,
      dateToISO,
      EQUITY_QUOTE_SYMBOLS
    } = PortfolioMath;
    const currency = new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" });
    const number = new Intl.NumberFormat("nl-NL", { maximumFractionDigits: 6 });
    const pct = new Intl.NumberFormat("nl-NL", { style: "percent", maximumFractionDigits: 2 });
    const todayISO = () => new Date().toISOString().slice(0, 10);
    const SCHEMA_VERSION = 2;
    const BACKUP_KEY_PREFIX = "portfolio-tracker-backup-";
    const MAX_BACKUPS = 5;
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
    const YAHOO_CHART_PROXY = "https://api.allorigins.win/raw?url=";
    const USD_EUR_RATE_URL = "https://open.er-api.com/v6/latest/USD";
    const ASSET_CHART_RANGES = [
      { key: "1m", label: "1M", days: 30, yahooRange: "1mo" },
      { key: "3m", label: "3M", days: 91, yahooRange: "3mo" },
      { key: "6m", label: "6M", days: 182, yahooRange: "6mo" },
      { key: "1y", label: "1J", days: 365, yahooRange: "1y" },
      { key: "max", label: "Alles", days: null, yahooRange: "max" }
    ];
    const HISTORY_CACHE_KEY = "portfolio-tracker-history-v1";
    const HISTORY_TTL_MS = 6 * 3600000;
    const HISTORY_MAX_ENTRIES = 24;
    const HISTORY_MAX_POINTS = 400;
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
      assetChartRange: "1y",
      portfolioSegment: "positions",
      mcMonthly: "",
      mcGoal: "",
      mcYears: "",
      sidebarCollapsed: false
    };
    const DEFAULT_PURCHASE_PLANS = [];

    let stateCache = { positions: null, totals: null, history: null, series: null, xirr: null };
    const VIEW_RENDERERS = {
      dashboard: (total) => renderDashboard(total),
      portfolio: (total) => renderPortfolio(total),
      analysis: (total) => renderAnalysis(total),
      plan: (total) => renderPlan(total),
      settings: (total) => {
        renderAudit(total);
        renderSettings();
      }
    };
    const dirtyViews = new Set();

    let state = loadState();
    let assetChartToken = 0;
    let valueChartToken = 0;
    let analysisRiskToken = 0;
    let correlationToken = 0;
    let mcToken = 0;
    // In-memory memo bovenop de localStorage-cache voor koershistorie;
    // dedupliceert ook gelijktijdige aanvragen (composer + correlatie).
    const historyMemo = new Map();
    let usdEurRateCache = null;
    let allocationHoverIndex = null;
    let allocationSegments = [];
    let activeModal = null;
    let activeModalOpener = null;

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

    ["mcMonthly", "mcGoal", "mcYears"].forEach((id) => {
      document.getElementById(id).addEventListener("input", (event) => {
        state.ui[id] = event.target.value;
        persist();
        renderPlanProjection(totals());
      });
    });

    document.addEventListener("keydown", handleModalKeydown);

    // Gedelegeerde klik-acties voor dynamisch gerenderde knoppen; vervangt
    // inline onclick-handlers zodat een strikte CSP mogelijk is.
    const UI_ACTIONS = {
      openPosition: (el) => openPositionDetail(el.dataset.ticker),
      removeDcaAssetDraft: (el) => removeDcaAssetDraft(el.dataset.ticker),
      filterPositionsByType: (el) => filterPositionsByType(el.dataset.type),
      sortPositionsBy: (el) => sortPositionsBy(el.dataset.key),
      clearPositionFilters: () => clearPositionFilters(),
      showSmallPositions: () => showSmallPositions(),
      showMoreTransactions: () => showMoreTransactions(),
      setTransactionSide: (el) => setTransactionSide(el.dataset.side),
      setTransactionSearch: (el) => setTransactionSearch(el.dataset.query),
      setTransactionCorrections: () => setTransactionCorrections(),
      resetTransactionFilters: () => resetTransactionFilters(),
      removeTransaction: (el) => removeTransaction(el.dataset.id),
      removeWatchlistItem: (el) => removeWatchlistItem(el.dataset.id),
      removeIncomeItem: (el) => removeIncomeItem(el.dataset.id),
      removeAlert: (el) => removeAlert(el.dataset.id),
      toggleDca: (el) => toggleDca(el.dataset.id),
      removeDca: (el) => removeDca(el.dataset.id),
      resetAveragePrice: (el) => resetAveragePrice(el.dataset.ticker),
      setPortfolioSegment: (el) => setPortfolioSegment(el.dataset.segment),
      setAssetChartRange: (el) => setAssetChartRange(el.dataset.rangeKey, el.dataset.ticker),
      updateCryptoPrices: () => updateCryptoPrices(),
      updateEquityPrices: () => updateEquityPrices(),
      exportPriceTemplate: () => exportPriceTemplate(),
      importPriceCsv: () => document.getElementById("priceFileInput").click(),
      restoreBackup: () => restoreBackup()
    };

    document.addEventListener("click", (event) => {
      const target = event.target.closest("[data-action]");
      if (!target) return;
      const action = UI_ACTIONS[target.dataset.action];
      if (action) action(target);
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
        active: data.active === "true",
        lastGeneratedDate: null
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
      link.download = `portfolio-private-${todayISO()}.json`;
      link.click();
      URL.revokeObjectURL(url);
    });

    document.getElementById("importBtn").addEventListener("click", () => document.getElementById("fileInput").click());
    document.getElementById("fileInput").addEventListener("change", async (event) => {
      const file = event.target.files[0];
      if (!file) return;
      try {
        const imported = JSON.parse(await file.text());
        const issues = validateImportedState(imported);
        createBackup(`voor import ${file.name}`);
        state = normalizeState(imported);
        state.meta = { ...(state.meta || {}), lastImportAt: new Date().toISOString(), lastImportFile: file.name };
        invalidateStateCache();
        applyDcaPlans();
        persist();
        render();
        showImportStatus(file.name, issues);
      } catch (error) {
        showImportStatus(`${file.name}: ${error.message || "import mislukt"}`);
      } finally {
        event.target.value = "";
      }
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
    document.getElementById("watchlistForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.target));
      const ticker = data.ticker.toUpperCase();
      const submitButton = event.target.querySelector("button[type=submit]");
      if (submitButton) {
        submitButton.disabled = true;
        submitButton.textContent = "Opzoeken...";
      }
      let lookup = null;
      try {
        if (!data.name || !data.type || !parsePriceNumber(data.currentPrice)) {
          lookup = await lookupWatchlistTicker(ticker);
        }
      } catch (error) {
        if (!parsePriceNumber(data.currentPrice)) {
          alert(`Ticker ${ticker} kon niet automatisch worden opgezocht. Vul naam, categorie en prijs handmatig in.`);
          if (submitButton) {
            submitButton.disabled = false;
            submitButton.textContent = "Toevoegen";
          }
          return;
        }
      }
      const currentPrice = parsePriceNumber(data.currentPrice) || lookup?.currentPrice || 0;
      const targetPrice = parsePriceNumber(data.targetPrice) || (currentPrice ? Number((currentPrice * 0.95).toFixed(4)) : 0);
      state.watchlist = [
        ...(state.watchlist || []).filter((item) => item.ticker !== ticker),
        {
          id: uid(),
          ticker,
          name: data.name || lookup?.name || ticker,
          type: data.type || lookup?.type || inferAssetType(ticker),
          currentPrice,
          targetPrice,
          note: data.note || "",
          createdAt: new Date().toISOString()
        }
      ];
      persist();
      event.target.reset();
      render();
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = "Toevoegen";
      }
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
        const copy = emptyState();
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
        return normalizeState(JSON.parse(raw));
      } catch {
        return emptyState();
      }
    }

    function validateImportedState(input) {
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("het bestand bevat geen geldig portfolio-object");
      }
      if (input.transactions !== undefined && !Array.isArray(input.transactions)) {
        throw new Error("het veld transactions is geen lijst");
      }
      const issues = [];
      const transactions = Array.isArray(input.transactions) ? input.transactions : [];
      const invalidDates = transactions.filter((item) => !/^\d{4}-\d{2}-\d{2}/.test(String(item?.date || ""))).length;
      const invalidQuantities = transactions.filter((item) => !Number.isFinite(Number(item?.quantity)) || Number(item?.quantity) <= 0).length;
      const negativePrices = transactions.filter((item) => Number(item?.price) < 0).length;
      const unknownSides = transactions.filter((item) => item?.side && !["buy", "sell"].includes(item.side)).length;
      if (invalidDates) issues.push(`${invalidDates} transacties met ongeldige datum`);
      if (invalidQuantities) issues.push(`${invalidQuantities} transacties met ongeldig aantal`);
      if (negativePrices) issues.push(`${negativePrices} transacties met negatieve prijs`);
      if (unknownSides) issues.push(`${unknownSides} transacties met onbekende actie`);
      return issues;
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
      const transactions = Array.isArray(input.transactions) ? input.transactions : [];
      const dcas = Array.isArray(input.dcas)
        ? input.dcas.map((plan) => ({ ...plan, assets: normalizeDcaAssets(plan), lastGeneratedDate: plan.lastGeneratedDate || null }))
        : [];
      // Migratie van oudere data: bestaande automatische transacties bepalen tot
      // waar een plan al gegenereerd is, zodat er geen duplicaten bijkomen.
      dcas.forEach((plan) => {
        if (plan.lastGeneratedDate) return;
        const generated = transactions.filter((item) => item.auto && item.dcaId === plan.id).map((item) => item.date);
        if (generated.length) plan.lastGeneratedDate = generated.sort().pop();
      });
      return {
        settings,
        avgPrices: input.avgPrices && typeof input.avgPrices === "object" ? input.avgPrices : {},
        avgPriceCorrections: input.avgPriceCorrections && typeof input.avgPriceCorrections === "object" ? input.avgPriceCorrections : {},
        priceMeta,
        prices,
        transactions,
        dcas,
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
        meta: { ...(input.meta && typeof input.meta === "object" ? input.meta : {}), schemaVersion: SCHEMA_VERSION }
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
          <button class="icon-btn danger" type="button" title="Verwijder" data-action="removeDcaAssetDraft" data-ticker="${escAttr(asset.ticker)}">×</button>
        </div>`).join("")
        : `<div class="empty">Nog geen assets toegevoegd.</div>`;
    }

    function normalizeTargetAllocation(input) {
      const defaults = { ETF: 55, Aandeel: 25, Crypto: 20, Gemengd: 0 };
      const source = input && typeof input === "object" ? input : {};
      return Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, Number(source[key] ?? value) || 0]));
    }

    function invalidateStateCache() {
      stateCache.positions = null;
      stateCache.totals = null;
      stateCache.history = null;
      stateCache.series = null;
      stateCache.xirr = null;
    }

    function positions() {
      if (!stateCache.positions) stateCache.positions = PortfolioMath.positions(state);
      return stateCache.positions;
    }

    function totals() {
      if (!stateCache.totals) stateCache.totals = PortfolioMath.totals(state);
      return stateCache.totals;
    }

    function priceOf(ticker, fallback) {
      return PortfolioMath.priceOf(state, ticker, fallback);
    }

    function averagePriceFor(pos) {
      return PortfolioMath.averagePriceFor(state, pos);
    }

    function dcaPlanValue(plan) {
      return PortfolioMath.dcaPlanValue(state, plan);
    }

    function persist() {
      invalidateStateCache();
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch (error) {
        showImportStatus(`opslaan mislukt: ${error.message || "opslag vol of niet beschikbaar"}. Maak een export als backup.`);
      }
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

    function backupKeys() {
      return Object.keys(localStorage)
        .filter((key) => key.startsWith(BACKUP_KEY_PREFIX))
        .sort((a, b) => backupKeyTime(a) - backupKeyTime(b));
    }

    function backupKeyTime(key) {
      // Legacy keys zonder timestamp ("-latest") gelden als oudste.
      const time = Number(key.slice(BACKUP_KEY_PREFIX.length));
      return Number.isFinite(time) ? time : 0;
    }

    function createBackup(reason) {
      try {
        const payload = {
          reason,
          createdAt: new Date().toISOString(),
          state
        };
        localStorage.setItem(`${BACKUP_KEY_PREFIX}${Date.now()}`, JSON.stringify(payload));
        const keys = backupKeys();
        keys.slice(0, Math.max(0, keys.length - MAX_BACKUPS)).forEach((key) => localStorage.removeItem(key));
      } catch {
        // Backups are best-effort because localStorage can be full or unavailable.
      }
    }

    function restoreBackup() {
      const key = backupKeys().pop();
      const raw = key ? localStorage.getItem(key) : null;
      if (!raw) {
        showImportStatus("geen backup gevonden");
        return;
      }
      try {
        const backup = JSON.parse(raw);
        state = normalizeState(backup.state || {});
        invalidateStateCache();
        persist();
        render();
        switchView("settings");
        showImportStatus(`backup hersteld (${backup.reason || "onbekend"}, ${dateTimeNl(backup.createdAt)})`);
      } catch (error) {
        showImportStatus(`backup herstellen mislukt: ${error.message || "bestand onleesbaar"}`);
      }
    }

    function applyDcaPlans() {
      // Genereert alleen nog niet eerder aangemaakte DCA-aankopen en zet de prijs
      // vast op het generatiemoment, zodat de kostbasis stabiel blijft.
      const today = todayISO();
      let changed = false;
      state.dcas.filter((plan) => plan.active).forEach((plan) => {
        const assets = normalizeDcaAssets(plan);
        if (!assets.length) return;
        const dates = dcaDates(plan.startDate, plan.frequency, today)
          .filter((date) => !plan.lastGeneratedDate || date > plan.lastGeneratedDate);
        if (!dates.length) return;
        dates.forEach((date) => {
          assets.forEach((asset) => {
            const price = priceOf(asset.ticker, Number(plan.price) || 0);
            state.transactions.push(tx(
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
        plan.lastGeneratedDate = dates[dates.length - 1];
        changed = true;
      });
      if (changed) {
        state.transactions.sort((a, b) => new Date(b.date) - new Date(a.date));
        invalidateStateCache();
      }
      return changed;
    }

    function captureDailySnapshot() {
      const total = totals();
      if (!total.list.length) return false;
      const today = todayISO();
      state.snapshots = Array.isArray(state.snapshots) ? state.snapshots : [];
      if (state.snapshots.some((item) => String(item.date || "").slice(0, 10) === today)) return false;
      state.snapshots.push({
        id: uid(),
        date: new Date().toISOString(),
        value: total.value,
        cost: total.cost,
        gain: total.gain,
        positions: total.list.length,
        auto: true
      });
      // Bewaar maximaal twee jaar aan automatische dagpunten.
      const autoSnapshots = state.snapshots.filter((item) => item.auto);
      if (autoSnapshots.length > 730) {
        const cutoff = autoSnapshots.sort((a, b) => String(a.date).localeCompare(String(b.date)))[autoSnapshots.length - 731].date;
        state.snapshots = state.snapshots.filter((item) => !item.auto || String(item.date) > String(cutoff));
      }
      return true;
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
        portfolio: ["Portfolio", "Posities, transacties en inkomsten op één plek."],
        analysis: ["Analyse", "Rendement, risico, spreiding en samenhang op koershistorie."],
        plan: ["Plan", "Doelplanner, DCA, doelallocatie, watchlist en alerts."],
        settings: ["Instellingen", "Import, export, datakwaliteit en opschonen."]
      };
      document.getElementById("pageTitle").textContent = titles[view][0];
      document.getElementById("pageSubtitle").textContent = titles[view][1];
      // Synchroon renderen: requestAnimationFrame vuurt niet betrouwbaar in
      // achtergrond-tabs (mobiel), waardoor views leeg konden blijven.
      if (dirtyViews.has(view)) renderView(view);
      else drawChartsForView(view);
    }

    function render() {
      // Alleen de actieve view wordt direct getekend; de rest wordt lui
      // bijgewerkt bij het wisselen van view.
      Object.keys(VIEW_RENDERERS).forEach((view) => dirtyViews.add(view));
      renderView(activeView());
    }

    function renderView(view) {
      const total = totals();
      document.querySelectorAll("[data-range]").forEach((button) => {
        button.classList.toggle("active", Number(button.dataset.range) === Number(state.chartRange || 12));
      });
      (VIEW_RENDERERS[view] || VIEW_RENDERERS.dashboard)(total);
      syncControls();
      updatePriceRefreshMeta();
      drawChartsForView(view);
      dirtyViews.delete(view);
    }

    function activeView() {
      return document.querySelector(".view.active")?.id || "dashboard";
    }

    function drawChartsForView(view) {
      const total = totals();
      if (view === "dashboard") {
        drawDashboardChart();
        drawAllocationChart(document.getElementById("allocationChart"), total.list);
      }
      if (view === "analysis") renderAnalysisRisk(total);
      if (view === "plan") renderPlanProjection(total);
    }

    function renderDashboard(total) {
      renderDashboardMetrics(total);
      renderDashboardSignals(total);
      renderValueChartSummary(total, null);
      renderAllocationLegend(total.list);
    }

    function renderDashboardMetrics(total, periodInfo = null) {
      const annual = portfolioXirr(total);
      const months = Number(state.chartRange || 12);
      const periodLabel = { 1: "1M", 3: "3M", 6: "6M", 12: "1J", 36: "3J", 60: "alles" }[months] || `${months}M`;
      const periodValue = periodInfo && Number.isFinite(periodInfo.twr)
        ? `${periodInfo.twr >= 0 ? "+" : ""}${pct.format(periodInfo.twr)}`
        : total.list.length ? "berekenen..." : "n.v.t.";
      const periodNote = periodInfo && Number.isFinite(periodInfo.twr)
        ? "Time-weighted, exclusief inleg"
        : "Op basis van koershistorie";
      document.getElementById("metrics").innerHTML = [
        metric("Actuele waarde", currency.format(total.value), `${total.list.length} open posities · inleg ${currency.format(total.cost)}`),
        metric("Totaal rendement", `${currency.format(total.gain)} (${pct.format(total.gainPct)})`, total.gain >= 0 ? "Boven aankoopwaarde" : "Onder aankoopwaarde"),
        metric("Rendement per jaar", annual === null ? "n.v.t." : pct.format(annual), "Money-weighted (XIRR) sinds start"),
        `<article class="metric" id="metricPeriod"><span>Rendement ${esc(periodLabel)}</span><strong>${esc(periodValue)}</strong><small>${esc(periodNote)}</small></article>`
      ].join("");
    }

    function metric(label, value, note) {
      return `<article class="metric"><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`;
    }

    // Money-weighted jaarrendement over de hele portefeuille: alle koop-/verkoop-
    // flows plus de huidige waarde als slotflow.
    function portfolioXirr(total = totals()) {
      if (stateCache.xirr !== null) return stateCache.xirr;
      const flows = state.transactions
        .filter((item) => Number(item.price) > 0 && Number(item.quantity) > 0)
        .map((item) => ({
          date: item.date,
          amount: (item.side === "sell" ? 1 : -1) * Math.abs(item.quantity * item.price)
        }));
      if (total.value > 0) flows.push({ date: todayISO(), amount: total.value });
      const result = PortfolioMath.xirr(flows);
      stateCache.xirr = Number.isFinite(result) ? result : null;
      return stateCache.xirr;
    }

    function positionXirr(item) {
      const flows = state.transactions
        .filter((txItem) => txItem.ticker === item.ticker && Number(txItem.price) > 0 && Number(txItem.quantity) > 0)
        .map((txItem) => ({
          date: txItem.date,
          amount: (txItem.side === "sell" ? 1 : -1) * Math.abs(txItem.quantity * txItem.price)
        }));
      if (item.value > 0) flows.push({ date: todayISO(), amount: item.value });
      const result = PortfolioMath.xirr(flows);
      return Number.isFinite(result) ? result : null;
    }

    function alertHits(total = totals()) {
      return (state.alerts || [])
        .map((item) => ({ ...item, priceNow: currentAssetPrice(item.ticker, 0) }))
        .filter((item) => item.priceNow > 0 && (item.direction === "below" ? item.priceNow <= item.price : item.priceNow >= item.price));
    }

    // Maximaal drie signalen met besluitwaarde; de rest is ruis.
    function renderDashboardSignals(total) {
      const target = document.getElementById("dashboardSignals");
      if (!target) return;
      const signals = [];
      if (window.location.protocol === "file:") {
        signals.push(healthTile("Live koersen geblokkeerd", "App via bestand geopend", "Dubbelklik start-app.command in de projectmap", "bad"));
      }
      if (!total.list.length) {
        signals.push(healthTile("Startpunt", "Nog geen data", "Importeer een backup of voeg je eerste transactie toe", "info"));
        target.innerHTML = signals.join("");
        target.hidden = false;
        return;
      }
      const info = priceDiagnostics(total);
      const hits = alertHits(total);
      const list = total.list.filter((item) => item.value >= 1);
      const visibleValue = list.reduce((sum, item) => sum + item.value, 0);
      const topWeight = list.length ? list[0].value / Math.max(visibleValue, 1) : 0;
      const cryptoWeight = list.filter((item) => item.type === "Crypto").reduce((sum, item) => sum + item.value, 0) / Math.max(visibleValue, 1);
      if (hits.length) signals.push(healthTile("Alerts geraakt", `${hits.length}`, hits.slice(0, 2).map((item) => `${item.ticker} ${item.direction === "below" ? "onder" : "boven"} ${currency.format(item.price)}`).join(" · "), "warn"));
      if (info.stale.length) signals.push(healthTile("Koersdata", `${info.stale.length} verouderd`, "Klik bovenin op Koersen voordat je conclusies trekt", "warn"));
      if (topWeight > .45 && list[0]) signals.push(healthTile("Concentratie", `${list[0].ticker} ${pct.format(topWeight)}`, "Stuur nieuwe inleg naar onderwogen categorieën", "warn"));
      if (cryptoWeight > .35) signals.push(healthTile("Crypto-weging", pct.format(cryptoWeight), "Boven je bewakingsgrens van 35%", "warn"));
      if (signals.length < 3) signals.push(healthTile("Op koers", "Geen actie nodig", "Geen harde signalen voor bijsturen vandaag", "good"));
      target.innerHTML = signals.slice(0, 3).join("");
      target.hidden = false;
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

    function signalCard(item) {
      return `<article class="analysis-signal signal-${item.tone}"><strong>${esc(item.title)}</strong><p>${esc(item.text)}</p></article>`;
    }

    function renderValueChartSummary(total, seriesInfo = null) {
      const list = total.list.filter((item) => item.value >= 1);
      const biggest = list[0];
      const sourceLabel = seriesInfo
        ? seriesInfo.liveCount
          ? `Koershistorie (${seriesInfo.liveCount}/${seriesInfo.totalTickers} assets live)`
          : "Reconstructie op transactieprijzen"
        : "Koershistorie laden...";
      const periodChange = seriesInfo && Number.isFinite(seriesInfo.twr)
        ? `<strong class="${seriesInfo.twr >= 0 ? "gain" : "loss"}">${seriesInfo.twr >= 0 ? "+" : ""}${pct.format(seriesInfo.twr)}</strong>`
        : `<strong>—</strong>`;
      document.getElementById("valueChartSummary").innerHTML = [
        `<div><span>Waarde</span><strong>${currency.format(total.value)}</strong></div>`,
        `<div><span>Totaal rendement</span><strong class="${total.gain >= 0 ? "gain" : "loss"}">${currency.format(total.gain)} · ${pct.format(total.gainPct)}</strong></div>`,
        `<div><span>Periode-rendement</span>${periodChange}</div>`,
        `<div><span>Grootste positie</span><strong>${biggest ? `${esc(biggest.ticker)} · ${pct.format(biggest.value / Math.max(total.value, 1))}` : "Geen"}</strong></div>`,
        `<div><span>Bron grafiek</span><strong>${esc(sourceLabel)}</strong></div>`
      ].join("");
    }

    function renderAllocationLegend(list) {
      const grouped = groupByType(list.filter((item) => item.value >= 1));
      const total = grouped.reduce((sum, item) => sum + item.value, 0);
      const colors = chartColors();
      document.getElementById("allocationLegend").innerHTML = grouped.map((item, index) => `
        <button class="legend-btn" data-action="filterPositionsByType" data-type="${escAttr(item.type)}">
          <span class="legend-dot" style="background:${colors[index % colors.length]}"></span>
          <strong>${esc(item.type)}</strong>
          <span>${currency.format(item.value)} · ${pct.format(item.value / Math.max(total, 1))}</span>
        </button>
      `).join("");
    }

    window.filterPositionsByType = (type) => {
      state.ui.positionSearch = type;
      state.ui.positionSpecialFilter = "all";
      state.ui.portfolioSegment = "positions";
      persist();
      render();
      switchView("portfolio");
    };

    function renderPortfolio(total) {
      applyPortfolioSegment();
      renderPositions(total.list);
      renderTransactions();
      renderIncome(total);
    }

    function applyPortfolioSegment() {
      const segment = ["positions", "transactions", "income"].includes(state.ui.portfolioSegment) ? state.ui.portfolioSegment : "positions";
      document.querySelectorAll("#portfolioSegments [data-segment]").forEach((button) => {
        button.classList.toggle("active", button.dataset.segment === segment);
      });
      const map = { positions: "portfolioPositions", transactions: "portfolioTransactions", income: "portfolioIncome" };
      Object.entries(map).forEach(([key, id]) => {
        const element = document.getElementById(id);
        if (element) element.hidden = key !== segment;
      });
    }

    function setPortfolioSegment(segment) {
      state.ui.portfolioSegment = segment;
      persist();
      applyPortfolioSegment();
    }

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
        <tbody>${filtered.map((item) => `<tr class="clickable-row" data-action="openPosition" data-ticker="${escAttr(item.ticker)}">
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
      </table>${visible.length < filtered.length ? `<div class="load-more"><button class="ghost-btn" data-action="showMoreTransactions">Toon meer (${filtered.length - visible.length})</button></div>` : ""}`;
    }

    function transactionRowHtml(item) {
      return `<tr>
        <td class="date-col">${dateNl(item.date)}</td>
        <td class="asset-col">${assetCell(item)}</td>
        <td class="type-col">${sideBadge(item.side)}${item.auto ? `<div class="asset-meta"><span class="tag-badge">DCA</span></div>` : ""}</td>
        <td class="num-col">${number.format(item.quantity)}</td>
        <td class="num-col">${currency.format(item.price)}</td>
        <td class="num-col">${transactionValueCell(item)}</td>
        <td class="action-col"><button class="icon-btn danger" title="Verwijderen" data-action="removeTransaction" data-id="${escAttr(item.id)}" ${item.auto ? "disabled" : ""}>
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
        `<button class="chip ${state.ui.positionSpecialFilter === "all" && !(state.ui.positionSearch || "") ? "active" : ""}" data-action="clearPositionFilters">${filtered.length} posities · ${currency.format(visibleValue)}</button>`,
        `<span class="chip">${winners} positief</span>`,
        ...typeRows.map((item) => `<button class="chip" data-action="filterPositionsByType" data-type="${escAttr(item.type)}">${esc(item.type)} ${pct.format(item.weight)}</button>`),
        small ? `<button class="chip ${state.ui.positionSpecialFilter === "small" ? "active" : ""}" data-action="showSmallPositions">${small} klein</button>` : ""
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
        `<button class="chip ${side === "all" && special === "all" ? "active" : ""}" data-action="setTransactionSide" data-side="all">${filtered.length} transacties</button>`,
        `<button class="chip ${side === "buy" && special === "all" ? "active" : ""}" data-action="setTransactionSide" data-side="buy">${buys} aankopen</button>`,
        `<button class="chip ${side === "sell" && special === "all" ? "active" : ""}" data-action="setTransactionSide" data-side="sell">${sells} verkopen</button>`,
        corrections ? `<button class="chip ${special === "corrections" ? "active" : ""}" data-action="setTransactionCorrections">${corrections} correcties</button>` : "",
        automated ? `<button class="chip" data-action="setTransactionSearch" data-query="DCA">${automated} DCA</button>` : "",
        `<button class="chip" data-action="resetTransactionFilters">Reset filters</button>`
      ].filter(Boolean).join("");
    }

    function sortHeader(label, key) {
      const active = state.ui.positionSort === key;
      const dir = active && state.ui.positionDir === "asc" ? "↑" : "↓";
      return `<button class="sort-th ${active ? "active" : ""}" data-action="sortPositionsBy" data-key="${key}">${esc(label)} ${active ? dir : ""}</button>`;
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

    window.showSmallPositions = () => {
      state.ui.positionSearch = "";
      state.ui.hideSmallPositions = false;
      state.ui.positionSpecialFilter = "small";
      state.ui.positionSort = "value";
      state.ui.positionDir = "asc";
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
      renderAttribution(list);
      renderAnalysisTypeTable(analysisByType(list));
      renderAnalysisRisk(total);
    }

    function renderAttribution(list) {
      const target = document.getElementById("attributionList");
      if (!target) return;
      const rows = [...list].sort((a, b) => Math.abs(b.gain) - Math.abs(a.gain)).slice(0, 10);
      if (!rows.length) {
        target.innerHTML = `<div class="empty">Nog geen posities.</div>`;
        return;
      }
      const maxAbs = Math.max(...rows.map((item) => Math.abs(item.gain)), 1);
      target.innerHTML = rows.map((item) => {
        const width = Math.max(2, Math.abs(item.gain) / maxAbs * 100);
        const positive = item.gain >= 0;
        return `<button class="attribution-row" type="button" data-action="openPosition" data-ticker="${escAttr(item.ticker)}">
          <strong>${esc(item.ticker)}</strong>
          <span class="attribution-track"><span class="attribution-fill ${positive ? "is-gain" : "is-loss"}" style="width:${width.toFixed(1)}%"></span></span>
          <span class="attribution-value ${positive ? "gain" : "loss"}">${positive ? "+" : ""}${currency.format(item.gain)}</span>
        </button>`;
      }).join("");
    }

    async function renderAnalysisRisk(total) {
      const metricsTarget = document.getElementById("analysisMetrics");
      const canvas = document.getElementById("drawdownChart");
      const summaryTarget = document.getElementById("drawdownSummary");
      if (!metricsTarget || !canvas) return;
      const token = ++analysisRiskToken;
      if (!total.list.length) {
        metricsTarget.innerHTML = metric("Analyse", "Nog geen data", "Voeg transacties toe of importeer een backup");
        const ctx = setupCanvas(canvas);
        const rect = canvas.getBoundingClientRect();
        drawEmptyCanvasMessage(ctx, rect.width, rect.height, "Geen data", "Nog geen portefeuillehistorie.");
        if (summaryTarget) summaryTarget.innerHTML = "";
        renderCorrelationMatrix(total);
        return;
      }
      metricsTarget.innerHTML = [
        metric("Volatiliteit", "berekenen...", "Jaarbasis, op maandrendementen"),
        metric("Max drawdown", "berekenen...", "Grootste piek-naar-dal-daling"),
        metric("Beste maand", "berekenen...", "Flow-gecorrigeerd"),
        metric("Slechtste maand", "berekenen...", "Flow-gecorrigeerd")
      ].join("");
      const series = await loadPortfolioSeries(60);
      if (token !== analysisRiskToken || !canvas.isConnected) return;
      const points = series?.points || [];
      const returns = PortfolioMath.monthlyReturns(points, 500);
      const volatility = returns.length >= 6 ? PortfolioMath.stdev(returns) * Math.sqrt(12) : null;
      const values = points.map((point) => point.value);
      const dd = PortfolioMath.maxDrawdown(values);
      const best = returns.length ? Math.max(...returns) : null;
      const worst = returns.length ? Math.min(...returns) : null;
      metricsTarget.innerHTML = [
        metric("Volatiliteit", volatility === null ? "Te weinig data" : pct.format(volatility), `Jaarbasis · ${returns.length} maandrendementen`),
        metric("Max drawdown", pct.format(dd.drawdown), points[dd.peakIndex] && points[dd.troughIndex] ? `${dateNl(points[dd.peakIndex].date)} → ${dateNl(points[dd.troughIndex].date)}` : "Piek naar dal"),
        metric("Beste maand", best === null ? "n.v.t." : `+${pct.format(best)}`, "Flow-gecorrigeerd maandrendement"),
        metric("Slechtste maand", worst === null ? "n.v.t." : pct.format(worst), "Flow-gecorrigeerd maandrendement")
      ].join("");
      drawDrawdownChart(canvas, points);
      if (summaryTarget) {
        const current = values.length && Math.max(...values) > 0 ? values[values.length - 1] / Math.max(...values) - 1 : 0;
        summaryTarget.innerHTML = [
          `<div><span>Huidige drawdown</span><strong class="${current < -0.01 ? "loss" : "gain"}">${pct.format(Math.min(0, current))}</strong></div>`,
          `<div><span>Diepste punt</span><strong>${pct.format(dd.drawdown)}</strong></div>`,
          `<div><span>Bron</span><strong>${series?.liveCount ? `Koershistorie (${series.liveCount}/${series.totalTickers} live)` : "Transactieprijzen"}</strong></div>`
        ].join("");
      }
      renderCorrelationMatrix(total);
    }

    function drawDrawdownChart(canvas, points) {
      if (points.length < 2) {
        const ctx = setupCanvas(canvas);
        const rect = canvas.getBoundingClientRect();
        drawEmptyCanvasMessage(ctx, rect.width, rect.height, "Geen historie", "Te weinig datapunten voor drawdown.");
        return;
      }
      let peak = 0;
      const ddPoints = points.map((point) => {
        peak = Math.max(peak, point.value);
        return { t: point.t ?? new Date(`${point.date}T00:00:00`).getTime(), v: peak > 0 ? point.value / peak - 1 : 0 };
      });
      drawTimeChart(canvas, {
        series: [{ points: ddPoints, color: "#b23b44", width: 2, fill: "rgba(178,59,68,.16)", fillToZero: true }],
        formatValue: (value) => pct.format(value),
        tooltip: (index) => `<strong>${dateNlFromMs(ddPoints[index].t)}</strong>${pct.format(ddPoints[index].v)} vanaf piek`,
        emptyTitle: "Geen historie"
      });
    }

    async function renderCorrelationMatrix(total) {
      const target = document.getElementById("correlationMatrix");
      if (!target) return;
      const list = total.list.filter((item) => item.value >= 1).slice(0, 8);
      if (list.length < 2) {
        target.innerHTML = `<div class="empty">Minimaal twee posities nodig voor correlatie.</div>`;
        return;
      }
      const token = ++correlationToken;
      target.innerHTML = `<div class="empty">Koershistorie laden voor ${list.length} posities...</div>`;
      const range = ASSET_CHART_RANGES.find((item) => item.key === "1y");
      const histories = new Map();
      await runBatched(list, 3, async (item) => {
        try {
          const history = await fetchAssetHistory(item, range);
          if (history.points.length >= 30) histories.set(item.ticker, history.points);
        } catch {
          // Ticker zonder historie doet niet mee aan de matrix.
        }
      });
      if (token !== correlationToken || !target.isConnected) return;
      const withData = list.filter((item) => histories.has(item.ticker));
      if (withData.length < 2) {
        target.innerHTML = `<div class="empty">Onvoldoende koershistorie beschikbaar (live bronnen niet bereikbaar).</div>`;
        return;
      }
      const returnsByTicker = new Map(withData.map((item) => [item.ticker, dailyReturnMap(histories.get(item.ticker))]));
      const cells = withData.map((rowItem) => withData.map((colItem) => {
        if (rowItem.ticker === colItem.ticker) return 1;
        return pairCorrelation(returnsByTicker.get(rowItem.ticker), returnsByTicker.get(colItem.ticker));
      }));
      target.innerHTML = `<table class="correlation-table">
        <thead><tr><th></th>${withData.map((item) => `<th>${esc(item.ticker)}</th>`).join("")}</tr></thead>
        <tbody>${withData.map((rowItem, rowIndex) => `<tr>
          <th>${esc(rowItem.ticker)}</th>
          ${cells[rowIndex].map((value) => correlationCell(value)).join("")}
        </tr>`).join("")}</tbody>
      </table>
      <p class="correlation-note">1,00 = beweegt identiek · 0 = onafhankelijk · negatief = tegengesteld. Posities zonder live historie ontbreken.</p>`;
    }

    function correlationCell(value) {
      if (value === null || !Number.isFinite(value)) return `<td class="corr-na">–</td>`;
      const clamped = Math.max(-1, Math.min(1, value));
      const alpha = Math.abs(clamped) * .85;
      const background = clamped >= 0 ? `rgba(19,124,155,${alpha.toFixed(2)})` : `rgba(217,87,123,${alpha.toFixed(2)})`;
      const ink = Math.abs(clamped) > .55 ? "#ffffff" : "#172235";
      return `<td style="background:${background};color:${ink}">${clamped.toFixed(2).replace(".", ",")}</td>`;
    }

    function dailyReturnMap(points) {
      const byDay = new Map();
      points.forEach((point) => byDay.set(new Date(point.t).toISOString().slice(0, 10), point.p));
      const days = [...byDay.keys()].sort();
      const returns = new Map();
      for (let i = 1; i < days.length; i += 1) {
        const prev = byDay.get(days[i - 1]);
        const cur = byDay.get(days[i]);
        if (prev > 0) returns.set(days[i], cur / prev - 1);
      }
      return returns;
    }

    function pairCorrelation(mapA, mapB) {
      const keys = [...mapA.keys()].filter((key) => mapB.has(key));
      if (keys.length < 20) return null;
      return PortfolioMath.correlation(keys.map((key) => mapA.get(key)), keys.map((key) => mapB.get(key)));
    }

    async function runBatched(items, concurrency, worker) {
      const queue = [...items];
      const runners = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        while (queue.length) {
          const item = queue.shift();
          await worker(item);
        }
      });
      await Promise.all(runners);
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

    function auditWarnings(total) {
      const warnings = [];
      const corrections = correctionTransactions();
      const zeroPrices = state.transactions.filter((item) => Number(item.price) === 0);
      const unsupportedPrices = positions().filter((item) => !state.prices?.[item.ticker] && item.currentPrice <= 0);
      const unknownSources = state.transactions.filter((item) => !item.source && !item.auto);
      const small = total.list.filter((item) => item.value < 1);

      if (corrections.length) warnings.push({ tone: "info", title: "Correctieregels actief", text: `${corrections.length} regels corrigeren posities na broker-exports of screenshots.` });
      if (zeroPrices.length) warnings.push({ tone: "info", title: "Prijs nul", text: `${zeroPrices.length} transacties hebben prijs 0. Dat is normaal voor staking/withdrawals/correcties, maar goed om zichtbaar te houden.` });
      if (unsupportedPrices.length) warnings.push({ tone: "bad", title: "Ontbrekende actuele prijzen", text: `${unsupportedPrices.length} posities hebben geen bruikbare actuele prijs.` });
      if (unknownSources.length) warnings.push({ tone: "warn", title: "Onbekende bron", text: `${unknownSources.length} handmatige transacties hebben geen bronlabel.` });
      if (small.length) warnings.push({ tone: "info", title: "Restposities", text: `${small.length} posities zijn minder dan €1 waard.` });
      if (!warnings.length) warnings.push({ tone: "good", title: "Geen issues", text: "Geen opvallende datakwaliteitsproblemen gevonden." });
      return warnings;
    }

    function renderAuditWarnings(warnings) {
      document.getElementById("auditWarnings").innerHTML = warnings.map((item) => `<article class="analysis-signal signal-${item.tone}">
        <strong>${esc(item.title)}</strong>
        <p>${esc(item.text)}</p>
      </article>`).join("");
    }

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

    function diffBadge(diffPct) {
      const tone = Math.abs(diffPct) < 2 ? "good" : Math.abs(diffPct) < 5 ? "warn" : "bad";
      const formatted = new Intl.NumberFormat("nl-NL", { maximumFractionDigits: 1 }).format(diffPct);
      return `<span class="status-pill ${tone}">${diffPct >= 0 ? "+" : ""}${formatted} pp</span>`;
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
          <td><button class="icon-btn" title="Verwijder" data-action="removeIncomeItem" data-id="${escAttr(item.id)}">×</button></td>
        </tr>`).join("")}</tbody>
      </table>` : `<div class="empty">Nog geen dividend, staking of rente ingevoerd.</div>`;
      renderTaxReport(total, year, yearRows);
    }

    function renderTaxReport(total, year, incomeRows) {
      const txRows = state.transactions.filter((item) => String(item.date || "").startsWith(year));
      const buys = txRows.filter((item) => item.side === "buy").reduce((sum, item) => sum + item.quantity * item.price, 0);
      const sells = txRows.filter((item) => item.side === "sell").reduce((sum, item) => sum + item.quantity * item.price, 0);
      const netIncome = incomeRows.reduce((sum, item) => sum + Number(item.amount || 0) - Number(item.tax || 0), 0);
      const realized = PortfolioMath.realizedGainForYear(state, year);
      document.getElementById("taxReport").innerHTML = [
        { tone: "info", title: `Jaar ${year}`, text: `${txRows.length} transacties, ${incomeRows.length} inkomstenregels.` },
        { tone: "info", title: "Transacties", text: `Aankopen ${currency.format(buys)} · verkopen ${currency.format(sells)}.` },
        { tone: realized >= 0 ? "info" : "warn", title: "Gerealiseerd resultaat", text: `${currency.format(realized)} op verkopen in ${year} (gemiddelde-kostprijsmethode).` },
        { tone: "info", title: "Inkomsten", text: `Netto dividend/staking/rente: ${currency.format(netIncome)}.` },
        { tone: "warn", title: "Controle", text: "Gebruik dit als werkoverzicht; fiscale regels en peildata blijven handmatig te controleren." }
      ].map(signalCard).join("");
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

    function showImportStatus(fileName, issues = []) {
      const status = document.getElementById("importStatus");
      if (!status) return;
      const visibleCrypto = positions().filter((item) => item.type === "Crypto" && item.value >= 1).map((item) => item.ticker).sort().join(", ");
      const issueText = issues.length ? `<br><strong>Let op:</strong> ${esc(issues.join(" · "))}` : "";
      status.innerHTML = `Import gelukt: ${esc(fileName)} · ${state.transactions.length} transacties · zichtbaar crypto: ${esc(visibleCrypto || "geen")}${issueText}`;
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
        const badgeLabel = String(assets[0]?.ticker || plan.name || "DC").slice(0, 2);
        const value = dcaPlanValue(plan);
        return `<article class="dca-card">
          <div class="asset"><div class="badge">${esc(badgeLabel)}</div><div><h3>${esc(plan.name)}</h3><span>${esc(assetLabel || "Geen assets")}</span></div></div>
          <div class="dca-meta">
            <div><span>Assets</span><strong>${number.format(assets.length)}</strong></div>
            <div><span>Waarde</span><strong>${currency.format(value)}</strong></div>
            <div><span>Interval</span><strong>${frequency}</strong></div>
            <div><span>Start</span><strong>${dateNl(plan.startDate)}</strong></div>
            <div><span>Gegenereerd</span><strong>${plan.active ? count : 0}x</strong></div>
          </div>
          <div class="actions-row">
            <button class="ghost-btn" data-action="toggleDca" data-id="${escAttr(plan.id)}">${plan.active ? "Pauzeer" : "Activeer"}</button>
            <button class="ghost-btn danger" data-action="removeDca" data-id="${escAttr(plan.id)}">Verwijder</button>
          </div>
        </article>`;
      }).join("");
    }

    window.removeDcaAssetDraft = (ticker) => {
      setDcaDraftAssets(dcaDraftAssets().filter((asset) => asset.ticker !== ticker));
    };

    // ---- Plan-view: doelplanner (Monte Carlo), allocatie, watchlist, alerts ----

    function renderPlan(total) {
      renderDcaCards();
      renderPlanAllocation(total);
      renderWatchlistTable(total);
      renderAlertsTable();
      renderPlanSignals(total);
      syncMcInputs(total);
      renderPlanProjection(total);
    }

    function renderPlanAllocation(total) {
      const target = document.getElementById("planAllocation");
      if (!target) return;
      if (!total.list.length) {
        target.innerHTML = `<div class="empty">Nog geen posities om te wegen.</div>`;
        return;
      }
      const rows = allocationRows(total);
      const monthly = mcSettings(total).monthly;
      const plan = rebalanceAllocations(rows, monthly);
      target.innerHTML = rows.map((item) => {
        const planned = plan.find((entry) => entry.type === item.type);
        const color = typeColor(item.type);
        return `<article class="allocation-row">
          <div class="allocation-row-head">
            <strong>${esc(item.type)}</strong>
            ${diffBadge(item.diffPct)}
          </div>
          <span class="mini-track"><span class="mini-fill" style="width:${Math.max(2, Math.min(100, item.currentPct)).toFixed(1)}%;--mini-color:${color};--mini-color-2:${color}"></span></span>
          <span class="allocation-row-meta">${pct.format(item.currentPct / 100)} nu · doel ${pct.format(item.targetPct / 100)}${planned && planned.amount > 0 ? ` · volgende inleg: ${currency.format(planned.amount)}` : ""}</span>
        </article>`;
      }).join("");
    }

    function renderWatchlistTable(total) {
      const target = document.getElementById("watchlistTable");
      if (!target) return;
      const rows = state.watchlist || [];
      target.innerHTML = rows.length ? `<table>
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
            <td><button class="icon-btn" title="Verwijder" data-action="removeWatchlistItem" data-id="${escAttr(item.id)}">×</button></td>
          </tr>`;
        }).join("")}</tbody>
      </table>` : `<div class="empty">Nog geen watchlist-items.</div>`;
    }

    function renderAlertsTable() {
      const target = document.getElementById("alertTable");
      if (!target) return;
      const rows = (state.alerts || []).map((item) => ({ ...item, priceNow: currentAssetPrice(item.ticker, 0) }));
      target.innerHTML = rows.length ? `<table>
        <thead><tr><th>Ticker</th><th>Richting</th><th>Grens</th><th>Notitie</th><th></th></tr></thead>
        <tbody>${rows.map((item) => {
          const hit = item.direction === "below" ? item.priceNow <= item.price : item.priceNow >= item.price;
          return `<tr>
            <td><strong>${esc(item.ticker)}</strong></td>
            <td><span class="status-pill ${hit ? "warn" : "info"}">${item.direction === "below" ? "Onder" : "Boven"}</span></td>
            <td>${targetDistanceCell(item.priceNow, item.price, item.direction === "below" ? "below" : "above")}</td>
            <td>${esc(item.note || "")}</td>
            <td><button class="icon-btn" data-action="removeAlert" data-id="${escAttr(item.id)}">×</button></td>
          </tr>`;
        }).join("")}</tbody>
      </table>` : `<div class="empty">Nog geen alerts.</div>`;
    }

    // Eén signalenlijst: geraakte alerts, koopzones en verkoopdoelen/stops.
    function renderPlanSignals(total) {
      const target = document.getElementById("planSignals");
      if (!target) return;
      const signals = [];
      alertHits(total).forEach((item) => {
        signals.push(signalCard({
          tone: "warn",
          title: `Alert ${item.ticker} geraakt`,
          text: `${currency.format(item.priceNow)} is ${item.direction === "below" ? "onder" : "boven"} je grens van ${currency.format(item.price)}. ${item.note || ""}`
        }));
      });
      (state.watchlist || []).forEach((item) => {
        const price = currentAssetPrice(item.ticker, item.currentPrice);
        if (item.targetPrice && price > 0 && price <= item.targetPrice) {
          signals.push(signalCard({
            tone: "good",
            title: `${item.ticker} in koopzone`,
            text: `${currency.format(price)} is op of onder je koopdoel van ${currency.format(item.targetPrice)}. ${item.note || ""}`
          }));
        }
      });
      Object.entries(state.salePlans || {}).forEach(([ticker, plan]) => {
        const price = currentAssetPrice(ticker, 0);
        if (!price) return;
        if (plan.targetPrice && price >= plan.targetPrice) {
          signals.push(signalCard({ tone: "good", title: `${ticker} boven verkoopdoel`, text: `${currency.format(price)} ≥ doel ${currency.format(plan.targetPrice)}. ${plan.note || ""}` }));
        }
        if (plan.stopPrice && price <= plan.stopPrice) {
          signals.push(signalCard({ tone: "bad", title: `${ticker} onder stop-loss`, text: `${currency.format(price)} ≤ stop ${currency.format(plan.stopPrice)}. ${plan.note || ""}` }));
        }
      });
      target.innerHTML = signals.length ? signals.join("") : `<div class="empty">Geen geraakte alerts, koopzones of verkoopgrenzen.</div>`;
    }

    function mcDefaults(total) {
      const monthly = Math.max(Math.round(Math.max(total.dcaMonthly, averageMonthlyBuys()) / 25) * 25, 100);
      const goal = Math.max(Math.round(total.value * 2 / 5000) * 5000, 25000);
      return { mcMonthly: monthly, mcGoal: goal, mcYears: 10 };
    }

    function mcSettings(total) {
      const defaults = mcDefaults(total);
      return {
        monthly: Math.max(0, Number(state.ui.mcMonthly) || defaults.mcMonthly),
        goal: Math.max(0, Number(state.ui.mcGoal) || defaults.mcGoal),
        years: Math.min(30, Math.max(1, Math.round(Number(state.ui.mcYears) || defaults.mcYears)))
      };
    }

    function syncMcInputs(total) {
      const settings = mcSettings(total);
      [["mcMonthly", settings.monthly], ["mcGoal", settings.goal], ["mcYears", settings.years]].forEach(([id, value]) => {
        const element = document.getElementById(id);
        if (element && document.activeElement !== element && element.value !== String(value)) element.value = value;
      });
    }

    // Historische rendementen per categorie als terugval wanneer de eigen
    // historie te kort is voor bootstrapping (jaarlijkse mu/sigma).
    function categoryAssumption(total) {
      const ASSUMPTIONS = {
        ETF: { mu: .06, sigma: .15 },
        Aandeel: { mu: .08, sigma: .25 },
        Crypto: { mu: .15, sigma: .70 },
        Gemengd: { mu: .04, sigma: .10 }
      };
      const list = total.list.filter((item) => item.value >= 1);
      const value = list.reduce((sum, item) => sum + item.value, 0);
      if (!value) return { mu: .06, sigma: .15 };
      let mu = 0;
      let sigma = 0;
      list.forEach((item) => {
        const assumption = ASSUMPTIONS[item.type] || ASSUMPTIONS.Gemengd;
        mu += (item.value / value) * assumption.mu;
        sigma += (item.value / value) * assumption.sigma;
      });
      return { mu, sigma };
    }

    // Deterministische RNG zodat dezelfde invoer dezelfde waaier oplevert.
    function seededRandom(seed) {
      let s = seed >>> 0;
      return () => {
        s = (s + 0x6D2B79F5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    async function renderPlanProjection(total = totals()) {
      const canvas = document.getElementById("mcChart");
      const summary = document.getElementById("mcSummary");
      if (!canvas || !summary) return;
      const settings = mcSettings(total);
      const token = ++mcToken;
      const series = await loadPortfolioSeries(60);
      if (token !== mcToken || !canvas.isConnected || activeView() !== "plan") return;
      // Bootstrap op de laatste 36 maanden: de vroege jaren (bijna volledig
      // small-cap crypto) zeggen niets over de huidige mix. Uitschieters worden
      // gedempt op ±25% per maand zodat één mania-maand de waaier niet opblaast.
      const samples = (series ? PortfolioMath.monthlyReturns(series.points, 500) : [])
        .slice(-36)
        .map((value) => Math.max(-0.25, Math.min(0.25, value)));
      const assumption = categoryAssumption(total);
      const months = settings.years * 12;
      const projection = PortfolioMath.monteCarloProjection({
        startValue: total.value,
        monthly: settings.monthly,
        months,
        samples,
        mu: assumption.mu,
        sigma: assumption.sigma,
        runs: 400,
        random: seededRandom(settings.monthly * 7919 + settings.goal + settings.years * 104729 + samples.length * 31)
      });
      drawFanChart(canvas, projection, settings, total);
      const probability = projection.endValues.length
        ? projection.endValues.filter((value) => value >= settings.goal).length / projection.endValues.length
        : 0;
      const methodLabel = projection.method === "bootstrap"
        ? `Bootstrap, laatste ${samples.length} maanden`
        : `Normaal: μ ${pct.format(assumption.mu)}, σ ${pct.format(assumption.sigma)}/jr (allocatie)`;
      summary.innerHTML = [
        `<div><span>Kans op ${currency.format(settings.goal)}</span><strong class="${probability >= .5 ? "gain" : "loss"}">${pct.format(probability)}</strong></div>`,
        `<div><span>Mediaan na ${settings.years} jaar</span><strong>${currency.format(projection.p50[months - 1])}</strong></div>`,
        `<div><span>Bandbreedte P10–P90</span><strong>${currency.format(projection.p10[months - 1])} – ${currency.format(projection.p90[months - 1])}</strong></div>`,
        `<div><span>Methode</span><strong>${esc(methodLabel)}</strong></div>`
      ].join("");
    }

    function drawFanChart(canvas, projection, settings, total) {
      const start = Date.now();
      const monthMs = 2629800000;
      const toPoints = (values) => values.map((value, index) => ({ t: start + (index + 1) * monthMs, v: value }));
      const median = [{ t: start, v: total.value }, ...toPoints(projection.p50)];
      const upper = [{ t: start, v: total.value }, ...toPoints(projection.p90)];
      const lower = [{ t: start, v: total.value }, ...toPoints(projection.p10)];
      const invested = [{ t: start, v: total.value }, ...projection.p50.map((_, index) => ({ t: start + (index + 1) * monthMs, v: total.value + settings.monthly * (index + 1) }))];
      drawTimeChart(canvas, {
        series: [
          { points: median, color: "#137c9b", width: 2.5 },
          { points: invested, color: "#7b8ba1", width: 1.5, dash: [5, 5] }
        ],
        band: { upper, lower, color: "rgba(19,124,155,.15)" },
        legend: [
          { label: "Mediaan (P50)", color: "#137c9b" },
          { label: "Alleen inleg", color: "#7b8ba1", dash: true },
          { label: "P10–P90 band", color: "rgba(19,124,155,.45)" }
        ],
        avgLine: settings.goal > 0 ? { value: settings.goal, label: `doel ${currency.format(settings.goal)}`, expandScale: true } : null,
        formatValue: (value) => currency.format(value),
        tooltip: (index) => `<strong>${dateNlFromMs(median[index].t)}</strong>P50 ${currency.format(median[index].v)}<br>P10 ${currency.format(lower[index].v)} · P90 ${currency.format(upper[index].v)}`,
        emptyTitle: "Geen projectie",
        emptyNote: "Voeg posities of inleg toe."
      });
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
      const title = `${source} · ${Number.isFinite(ageDays) ? `${ageDays} dagen oud` : "datum onbekend"}. Crypto kan live via CoinGecko; aandelen/ETF via import, CSV of handmatig.`;
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

    // ---- Portefeuillehistorie: transactie-walker + live koershistorie ----

    function sortedValidTransactions() {
      return [...state.transactions]
        .filter((item) => /^\d{4}-\d{2}-\d{2}/.test(String(item.date || "")))
        .sort((a, b) => a.date.localeCompare(b.date));
    }

    // Loopt chronologisch door de transacties en levert per griddatum de
    // aantallen, laatst bekende transactieprijs en cumulatieve netto inleg.
    function transactionWalker() {
      const txs = sortedValidTransactions();
      const quantities = new Map();
      const lastTxPrice = new Map();
      let invested = 0;
      let txIndex = 0;
      return {
        applyUntil(date) {
          while (txIndex < txs.length && txs[txIndex].date <= date) {
            const item = txs[txIndex];
            const quantity = Number(item.quantity) || 0;
            const price = Number(item.price) || 0;
            const held = quantities.get(item.ticker) || 0;
            if (item.side === "sell") {
              quantities.set(item.ticker, Math.max(0, held - quantity));
              invested -= quantity * price;
            } else {
              quantities.set(item.ticker, held + quantity);
              invested += quantity * price;
            }
            if (price > 0) lastTxPrice.set(item.ticker, price);
            txIndex += 1;
          }
        },
        quantities,
        lastTxPrice,
        get invested() {
          return invested;
        },
        hasTransactions: txs.length > 0
      };
    }

    // Synchrone fallback: waardeert tegen de laatst bekende transactieprijs.
    function transactionSeries(months) {
      const end = new Date(`${todayISO()}T00:00:00`);
      const start = new Date(end);
      start.setMonth(start.getMonth() - months);
      const walker = transactionWalker();
      if (!walker.hasTransactions) return [];
      const points = [];
      for (let cursor = new Date(start); cursor < end; cursor.setDate(cursor.getDate() + 7)) {
        const date = dateToISO(cursor);
        walker.applyUntil(date);
        let value = 0;
        walker.quantities.forEach((quantity, ticker) => {
          if (quantity > 0) value += quantity * (walker.lastTxPrice.get(ticker) || 0);
        });
        points.push({ t: cursor.getTime(), date, value, invested: walker.invested });
      }
      walker.applyUntil(todayISO());
      points.push({ t: end.getTime(), date: todayISO(), value: totals().value, invested: walker.invested });
      return points;
    }

    function assetRangeForMonths(months) {
      const key = { 1: "1m", 3: "3m", 6: "6m", 12: "1y", 36: "max", 60: "max" }[months] || "max";
      return ASSET_CHART_RANGES.find((range) => range.key === key);
    }

    function loadPortfolioSeries(months) {
      if (!stateCache.series) stateCache.series = new Map();
      if (!stateCache.series.has(months)) {
        stateCache.series.set(months, composePortfolioSeries(months).catch(() => null));
      }
      return stateCache.series.get(months);
    }

    // Bouwt de portefeuillereeks op echte koershistorie per asset. Tickers
    // zonder bereikbare live bron vallen per stuk terug op transactieprijzen.
    async function composePortfolioSeries(months) {
      const end = new Date(`${todayISO()}T00:00:00`);
      const start = new Date(end);
      start.setMonth(start.getMonth() - months);
      const walker = transactionWalker();
      if (!walker.hasTransactions) return { points: [], liveCount: 0, totalTickers: 0, twr: null };

      const notional = new Map();
      const typeOf = new Map();
      sortedValidTransactions().forEach((item) => {
        notional.set(item.ticker, (notional.get(item.ticker) || 0) + Math.abs((Number(item.quantity) || 0) * (Number(item.price) || 0)));
        if (!typeOf.has(item.ticker)) typeOf.set(item.ticker, item.type);
      });
      const tickers = [...notional.entries()]
        .filter(([, amount]) => amount >= 1)
        .sort((a, b) => b[1] - a[1])
        .map(([ticker]) => ({ ticker, type: typeOf.get(ticker) }));
      const range = assetRangeForMonths(months);
      const priceSeries = new Map();
      await runBatched(tickers, 3, async (info) => {
        try {
          const history = await fetchAssetHistory(info, range);
          if (history.points.length >= 2) priceSeries.set(info.ticker, history.points);
        } catch {
          // Geen live bron: deze ticker telt mee tegen transactieprijzen.
        }
      });

      const priceAt = (ticker, t) => {
        const series = priceSeries.get(ticker);
        if (!series || !series.length || t < series[0].t) {
          return walker.lastTxPrice.get(ticker) || (series && series.length ? series[0].p : 0);
        }
        let lo = 0;
        let hi = series.length - 1;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          if (series[mid].t <= t) lo = mid;
          else hi = mid - 1;
        }
        return series[lo].p;
      };

      const totalDays = Math.max(7, Math.round((end - start) / 86400000));
      const stepDays = Math.max(1, Math.round(totalDays / 130));
      const points = [];
      for (let cursor = new Date(start); cursor < end; cursor.setDate(cursor.getDate() + stepDays)) {
        const date = dateToISO(cursor);
        const t = cursor.getTime();
        walker.applyUntil(date);
        let value = 0;
        walker.quantities.forEach((quantity, ticker) => {
          if (quantity > 0) value += quantity * priceAt(ticker, t);
        });
        points.push({ t, date, value, invested: walker.invested });
      }
      walker.applyUntil(todayISO());
      points.push({ t: end.getTime(), date: todayISO(), value: totals().value, invested: walker.invested });
      const windowPoints = points.filter((point) => point.value > 0 || point.invested > 0);
      const twr = PortfolioMath.timeWeightedReturn(windowPoints);
      return { points, liveCount: priceSeries.size, totalTickers: tickers.length, twr };
    }

    function drawDashboardChart() {
      const canvas = document.getElementById("valueChart");
      if (!canvas) return;
      const months = Number(state.chartRange || 12);
      const fallback = transactionSeries(months);
      renderValueChart(canvas, fallback);
      const token = ++valueChartToken;
      loadPortfolioSeries(months).then((series) => {
        if (token !== valueChartToken || !canvas.isConnected || activeView() !== "dashboard") return;
        const total = totals();
        if (series && series.points.length >= 2) {
          renderValueChart(canvas, series.points);
          renderValueChartSummary(total, series);
          renderDashboardMetrics(total, series);
        } else {
          const twr = PortfolioMath.timeWeightedReturn(fallback);
          renderValueChartSummary(total, { liveCount: 0, totalTickers: 0, twr });
          renderDashboardMetrics(total, { twr });
        }
      });
    }

    function renderValueChart(canvas, points) {
      const valuePoints = points.map((point) => ({ t: point.t, v: point.value }));
      const investedPoints = points
        .filter((point) => Number.isFinite(point.invested))
        .map((point) => ({ t: point.t, v: point.invested }));
      drawTimeChart(canvas, {
        series: [
          { points: valuePoints, color: "#137c9b", width: 3, fill: "rgba(19,124,155,.14)" },
          investedPoints.length >= 2 ? { points: investedPoints, color: "#7b8ba1", width: 1.5, dash: [5, 5] } : null
        ].filter(Boolean),
        legend: [
          { label: "Waarde", color: "#137c9b" },
          { label: "Netto inleg", color: "#7b8ba1", dash: true }
        ],
        formatValue: (value) => currency.format(value),
        tooltip: (index) => {
          const point = points[index];
          const gain = Number.isFinite(point.invested) ? point.value - point.invested : null;
          return `<strong>${dateNl(point.date)}</strong>${currency.format(point.value)}${gain === null ? "" : `<br>Inleg ${currency.format(point.invested)} · ${gain >= 0 ? "+" : ""}${currency.format(gain)}`}`;
        },
        emptyTitle: "Nog geen waardedata",
        emptyNote: "Importeer of voeg transacties toe."
      });
    }

    // ---- Generieke tijdreeksgrafiek: één stijl voor waarde-, drawdown-,
    // fan- en assetgrafiek. Serie 0 is de hoofdserie (scrub + labels). ----
    function drawTimeChart(canvas, model) {
      const ctx = setupCanvas(canvas);
      const { width, height } = canvas.getBoundingClientRect();
      ctx.clearRect(0, 0, width, height);
      const series = (model.series || []).filter((entry) => entry && entry.points && entry.points.length >= 2);
      const main = series[0];
      if (!main) {
        drawEmptyCanvasMessage(ctx, width, height, model.emptyTitle || "Geen data", model.emptyNote || "Onvoldoende datapunten.");
        canvas.onpointermove = canvas.onpointerdown = canvas.onpointerleave = canvas.onpointercancel = canvas.onpointerup = null;
        return;
      }
      const padX = 16;
      const padTop = model.legend ? 40 : 30;
      const padBottom = 34;
      const format = model.formatValue || ((value) => String(value));

      const allPoints = series.flatMap((entry) => entry.points)
        .concat(model.band ? [...model.band.upper, ...model.band.lower] : []);
      const t0 = Math.min(...allPoints.map((point) => point.t));
      const t1 = Math.max(...allPoints.map((point) => point.t));
      const spanT = Math.max(t1 - t0, 1);
      let minV = Math.min(...allPoints.map((point) => point.v));
      let maxV = Math.max(...allPoints.map((point) => point.v));
      // Referentielijn telt alleen mee in de schaal als dat gevraagd is (doel in
      // de fan chart wel; gemiddelde aankoopprijs ver buiten koersbereik niet).
      if (model.avgLine && Number.isFinite(model.avgLine.value) && model.avgLine.expandScale) {
        minV = Math.min(minV, model.avgLine.value);
        maxV = Math.max(maxV, model.avgLine.value);
      }
      if (model.includeZero) minV = Math.min(minV, 0);
      const spanV = Math.max(maxV - minV, Math.abs(maxV) * .002, 1e-9);
      const xFor = (t) => padX + ((t - t0) / spanT) * (width - padX * 2);
      const yFor = (v) => padTop + (1 - (v - minV) / spanV) * (height - padTop - padBottom);

      // Onzekerheidsband (fan chart)
      if (model.band) {
        ctx.beginPath();
        model.band.upper.forEach((point, index) => {
          const x = xFor(point.t);
          const y = yFor(point.v);
          if (index === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        [...model.band.lower].reverse().forEach((point) => ctx.lineTo(xFor(point.t), yFor(point.v)));
        ctx.closePath();
        ctx.fillStyle = model.band.color || "rgba(19,124,155,.14)";
        ctx.fill();
      }

      series.forEach((entry) => {
        if (entry.fill) {
          const baseline = entry.fillToZero && minV < 0 ? yFor(Math.min(0, maxV)) : height - padBottom;
          ctx.beginPath();
          entry.points.forEach((point, index) => {
            const x = xFor(point.t);
            const y = yFor(point.v);
            if (index === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          });
          ctx.lineTo(xFor(entry.points[entry.points.length - 1].t), baseline);
          ctx.lineTo(xFor(entry.points[0].t), baseline);
          ctx.closePath();
          ctx.fillStyle = entry.fill;
          ctx.fill();
        }
        ctx.beginPath();
        entry.points.forEach((point, index) => {
          const x = xFor(point.t);
          const y = yFor(point.v);
          if (index === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.lineWidth = entry.width || 2;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.strokeStyle = entry.color || "#137c9b";
        ctx.save();
        if (entry.dash) ctx.setLineDash(entry.dash);
        ctx.stroke();
        ctx.restore();
      });

      if (model.avgLine && Number.isFinite(model.avgLine.value) && model.avgLine.value >= minV && model.avgLine.value <= maxV) {
        const y = yFor(model.avgLine.value);
        ctx.save();
        ctx.setLineDash([5, 5]);
        ctx.strokeStyle = "rgba(23,34,53,.38)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(padX, y);
        ctx.lineTo(width - padX, y);
        ctx.stroke();
        ctx.restore();
        axisLabel(ctx, model.avgLine.label, padX + 4, y - 6);
      }

      // Hoog/laag-labels op de hoofdserie + datumranden
      ctx.font = "12px Inter, sans-serif";
      ctx.fillStyle = "#647084";
      let maxIndex = 0;
      let minIndex = 0;
      main.points.forEach((point, index) => {
        if (point.v > main.points[maxIndex].v) maxIndex = index;
        if (point.v < main.points[minIndex].v) minIndex = index;
      });
      const clampLabelX = (x, text) => Math.max(padX, Math.min(width - padX - ctx.measureText(text).width, x - ctx.measureText(text).width / 2));
      if (model.labels !== false) {
        const highText = format(main.points[maxIndex].v);
        ctx.fillText(highText, clampLabelX(xFor(main.points[maxIndex].t), highText), Math.max(14, yFor(main.points[maxIndex].v) - 10));
        const lowText = format(main.points[minIndex].v);
        ctx.fillText(lowText, clampLabelX(xFor(main.points[minIndex].t), lowText), Math.min(height - padBottom + 12, yFor(main.points[minIndex].v) + 18));
      }
      axisLabel(ctx, dateNlFromMs(t0), padX, height - 10);
      const endLabel = model.endLabel || dateNlFromMs(t1);
      axisLabel(ctx, endLabel, width - padX - ctx.measureText(endLabel).width, height - 10);

      if (model.legend) {
        let legendX = padX;
        model.legend.forEach((entry) => {
          ctx.strokeStyle = entry.color;
          ctx.lineWidth = 3;
          ctx.save();
          if (entry.dash) ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.moveTo(legendX, 16);
          ctx.lineTo(legendX + 18, 16);
          ctx.stroke();
          ctx.restore();
          ctx.fillStyle = "#647084";
          ctx.fillText(entry.label, legendX + 23, 20);
          legendX += 23 + ctx.measureText(entry.label).width + 18;
        });
      }

      // Markers (bijv. aan-/verkoopmomenten) op de hoofdserie
      const hover = Number.isInteger(canvas.__hoverIndex) ? Math.max(0, Math.min(main.points.length - 1, canvas.__hoverIndex)) : null;
      const tolerance = Math.max(1, Math.round(main.points.length / 70));
      if (model.markers && model.markers.length) {
        const active = model.activeMarkers ? model.activeMarkers(hover, tolerance) : [];
        model.markers.forEach((marker) => {
          const point = main.points[marker.index];
          if (!point) return;
          const isActive = active.includes(marker);
          ctx.beginPath();
          ctx.arc(xFor(point.t), yFor(point.v), isActive ? 6.5 : 4.5, 0, Math.PI * 2);
          ctx.fillStyle = marker.color;
          ctx.fill();
          ctx.lineWidth = isActive ? 2.5 : 1.5;
          ctx.strokeStyle = "#ffffff";
          ctx.stroke();
        });
      }

      // Scrub-lijn en punt
      if (hover !== null && model.tooltip) {
        const point = main.points[hover];
        const x = xFor(point.t);
        const y = yFor(point.v);
        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = "rgba(23,34,53,.35)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, padTop - 6);
        ctx.lineTo(x, height - padBottom);
        ctx.stroke();
        ctx.restore();
        ctx.beginPath();
        ctx.arc(x, y, 6, 0, Math.PI * 2);
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        ctx.lineWidth = 3;
        ctx.strokeStyle = main.color || "#137c9b";
        ctx.stroke();
      }

      if (!model.tooltip) {
        canvas.onpointermove = canvas.onpointerdown = canvas.onpointerleave = canvas.onpointercancel = canvas.onpointerup = null;
        return;
      }
      const scrub = (event) => {
        const rect = canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        let index = 0;
        let best = Infinity;
        main.points.forEach((point, pointIndex) => {
          const distance = Math.abs(xFor(point.t) - x);
          if (distance < best) {
            best = distance;
            index = pointIndex;
          }
        });
        canvas.__hoverIndex = index;
        const html = model.tooltip(index, tolerance);
        if (html) showChartTooltip(event, html);
        drawTimeChart(canvas, model);
      };
      const clear = () => {
        canvas.__hoverIndex = null;
        hideChartTooltip();
        drawTimeChart(canvas, model);
      };
      canvas.onpointermove = scrub;
      canvas.onpointerdown = scrub;
      canvas.onpointerleave = clear;
      canvas.onpointercancel = clear;
      canvas.onpointerup = (event) => {
        if (event.pointerType !== "mouse") clear();
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
        drawEmptyCanvasMessage(ctx, width, height, "Geen verdeling", "Nog geen open posities.");
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
      const allocationScrub = (event) => {
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
      const allocationClear = () => {
        allocationHoverIndex = null;
        hideChartTooltip();
        drawAllocationChart(canvas, list);
      };
      canvas.onpointermove = allocationScrub;
      canvas.onpointerdown = allocationScrub;
      canvas.onpointerleave = allocationClear;
      canvas.onpointercancel = allocationClear;
      canvas.onpointerup = (event) => {
        if (event.pointerType !== "mouse") allocationClear();
      };
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
      // Eerst content zetten en meten, dan klemmen binnen het scherm; bij de
      // rechterrand klapt de tooltip naar de linkerkant van de cursor.
      const rect = tooltip.getBoundingClientRect();
      const margin = 10;
      let left = event.clientX + 14;
      if (left + rect.width > window.innerWidth - margin) left = event.clientX - rect.width - 14;
      left = Math.max(margin, left);
      let top = event.clientY - 18;
      if (top + rect.height > window.innerHeight - margin) top = window.innerHeight - rect.height - margin;
      top = Math.max(margin, top);
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${top}px`;
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

    function drawEmptyCanvasMessage(ctx, width, height, title, note) {
      ctx.save();
      ctx.textAlign = "center";
      ctx.fillStyle = "#172235";
      ctx.font = "700 15px Inter, sans-serif";
      ctx.fillText(title, width / 2, height / 2 - 8);
      ctx.fillStyle = "#66758d";
      ctx.font = "12px Inter, sans-serif";
      ctx.fillText(note, width / 2, height / 2 + 13);
      ctx.restore();
    }

    function axisLabel(ctx, text, x, y) {
      ctx.fillStyle = "#647084";
      ctx.font = "12px Inter, sans-serif";
      ctx.fillText(text, x, y);
    }

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
      const parsed = new Date(`${date}T00:00:00`);
      if (Number.isNaN(parsed.getTime())) return "Onbekend";
      return new Intl.DateTimeFormat("nl-NL", { day: "2-digit", month: "short", year: "numeric" }).format(parsed);
    }

    function dateTimeNl(value) {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return "Onbekend";
      return new Intl.DateTimeFormat("nl-NL", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
    }

    function openModal() {
      document.querySelector("#txForm [name=date]").value = todayISO();
      openDialog("txModal", document.querySelector("#txForm [name=ticker]"));
    }

    function closeModal() {
      closeDialog("txModal");
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
            <button class="ghost-btn" type="button" data-action="updateCryptoPrices" ${cryptoCount ? "" : "disabled"}>Live crypto-prijzen</button>
            <button class="ghost-btn" type="button" data-action="updateEquityPrices" ${equityCount ? "" : "disabled"}>Live aandelen/ETF's</button>
            <button class="ghost-btn" type="button" data-action="exportPriceTemplate">Download template</button>
            <button class="ghost-btn" type="button" data-action="importPriceCsv">Importeer prijs-CSV</button>
          </div>
          <div class="form-grid">${list.map((item) => `
          <label>${esc(item.ticker)} · ${esc(item.name)}
            <input name="price-${escAttr(item.ticker)}" required type="number" inputmode="decimal" min="0" step="any" value="${escAttr(item.currentPrice)}">
          </label>
        `).join("")}</div><button class="primary-btn" type="submit">Prijzen opslaan</button>`;
      }
      openDialog("pricesModal", document.getElementById("closePricesModal"));
    }

    function closePricesModal() {
      closeDialog("pricesModal");
    }

    function openPositionDetail(ticker) {
      const item = positions().find((pos) => pos.ticker === ticker);
      if (!item) return;
      const transactions = state.transactions
        .filter((txItem) => txItem.ticker === ticker)
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .slice(0, 12);
      const correction = state.avgPriceCorrections?.[ticker];
      const activeRange = assetChartRange();
      const annual = positionXirr(item);
      const meta = (state.tags || {})[ticker] || {};
      const salePlan = (state.salePlans || {})[ticker] || {};
      document.getElementById("positionTitle").textContent = `${item.ticker} · ${item.name}`;
      document.getElementById("positionDetail").innerHTML = `
        <div class="detail-grid">
          <div class="detail-stat"><span>Aantal</span><strong>${number.format(item.quantity)}</strong></div>
          <div class="detail-stat"><span>Waarde</span><strong>${currency.format(item.value)}</strong></div>
          <div class="detail-stat"><span>Gem. prijs</span><strong>${currency.format(item.avgPrice)}</strong></div>
          <div class="detail-stat"><span>Rendement</span><strong class="${item.gain >= 0 ? "gain" : "loss"}">${currency.format(item.gain)} · ${pct.format(item.gainPct)}</strong></div>
          <div class="detail-stat"><span>Rendement/jaar</span><strong class="${(annual || 0) >= 0 ? "gain" : "loss"}">${annual === null ? "n.v.t." : pct.format(annual)}</strong></div>
          ${item.realizedGain ? `<div class="detail-stat"><span>Gerealiseerd</span><strong class="${item.realizedGain >= 0 ? "gain" : "loss"}">${currency.format(item.realizedGain)}</strong></div>` : ""}
        </div>
        <div class="asset-chart-block">
          <div class="asset-chart-head">
            <div class="asset-chart-price">
              <span>Actuele prijs</span>
              <strong>${currency.format(item.currentPrice)}</strong>
            </div>
            <div class="tabs compact-tabs" id="assetRangeTabs">${ASSET_CHART_RANGES.map((range) => `<button type="button" class="${range.key === activeRange.key ? "active" : ""}" data-action="setAssetChartRange" data-range-key="${range.key}" data-ticker="${escAttr(item.ticker)}">${range.label}</button>`).join("")}</div>
          </div>
          <div class="asset-chart-wrap"><canvas id="assetChart"></canvas></div>
          <div class="asset-chart-meta" id="assetChartMeta"></div>
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
            <button class="ghost-btn" type="button" data-action="resetAveragePrice" data-ticker="${escAttr(item.ticker)}">Reset gemiddelde</button>
            <button class="primary-btn" type="submit">Opslaan</button>
          </div>
        </form>
        <form id="strategyForm">
          <div class="detail-form-head"><strong>Strategie & verkoopplan</strong><span>Waarom bezit je dit en wanneer verkoop je?</span></div>
          <div class="form-grid">
            <label>Tags<input name="tags" value="${escAttr(meta.tags || "")}" placeholder="core, long-term"></label>
            <label>Thesis<input name="thesis" value="${escAttr(meta.thesis || "")}" placeholder="Waarom bezit ik dit?"></label>
            <label>Risico<input name="risk" value="${escAttr(meta.risk || "")}" placeholder="Wat kan fout gaan?"></label>
            <label>Verkoopdoel<input name="targetPrice" type="number" inputmode="decimal" min="0" step="any" value="${salePlan.targetPrice || ""}" placeholder="Doelprijs"></label>
            <label>Stop-loss<input name="stopPrice" type="number" inputmode="decimal" min="0" step="any" value="${salePlan.stopPrice || ""}" placeholder="Ondergrens"></label>
            <label>Verkoopplan<input name="note" value="${escAttr(salePlan.note || "")}" placeholder="Wanneer verkoop ik?"></label>
          </div>
          <div class="actions-row">
            <button class="primary-btn" type="submit">Strategie opslaan</button>
          </div>
        </form>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Datum</th><th>Type</th><th>Aantal</th><th>Prijs</th></tr></thead>
            <tbody>${transactions.map((txItem) => `<tr>
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
      document.getElementById("strategyForm").addEventListener("submit", (event) => {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(event.target));
        const tags = { tags: data.tags?.trim() || "", thesis: data.thesis?.trim() || "", risk: data.risk?.trim() || "" };
        state.tags = { ...(state.tags || {}) };
        if (tags.tags || tags.thesis || tags.risk) state.tags[item.ticker] = tags;
        else delete state.tags[item.ticker];
        const plan = {
          targetPrice: parsePriceNumber(data.targetPrice) || 0,
          stopPrice: parsePriceNumber(data.stopPrice) || 0,
          note: data.note?.trim() || ""
        };
        state.salePlans = { ...(state.salePlans || {}) };
        if (plan.targetPrice || plan.stopPrice || plan.note) state.salePlans[item.ticker] = plan;
        else delete state.salePlans[item.ticker];
        persist();
        render();
        openPositionDetail(item.ticker);
      });
      openDialog("positionModal", document.getElementById("closePositionModal"));
      loadAssetChart(item);
    }

    // ---- Interactieve koersgrafiek per asset (historie + aan-/verkoopmomenten) ----

    function assetChartRange() {
      return ASSET_CHART_RANGES.find((range) => range.key === state.ui.assetChartRange) || ASSET_CHART_RANGES[3];
    }

    function setAssetChartRange(key, ticker) {
      if (!ASSET_CHART_RANGES.some((range) => range.key === key)) return;
      state.ui.assetChartRange = key;
      persist();
      document.querySelectorAll("#assetRangeTabs [data-range-key]").forEach((button) => {
        button.classList.toggle("active", button.dataset.rangeKey === key);
      });
      const item = positions().find((pos) => pos.ticker === ticker);
      if (item) loadAssetChart(item);
    }

    async function loadAssetChart(item) {
      const canvas = document.getElementById("assetChart");
      if (!canvas) return;
      const token = ++assetChartToken;
      canvas.__hoverIndex = null;
      hideChartTooltip();
      const range = assetChartRange();
      const ctx = setupCanvas(canvas);
      const rect = canvas.getBoundingClientRect();
      drawEmptyCanvasMessage(ctx, rect.width, rect.height, "Koershistorie laden...", "Live bron: CoinGecko / Yahoo Finance");
      let history;
      let note = "";
      try {
        history = await fetchAssetHistory(item, range);
      } catch (error) {
        history = transactionFallbackHistory(item, range);
        note = window.location.protocol === "file:"
          ? "Live historie geblokkeerd omdat de app via een bestand is geopend. Start via start-app.command; nu zijn eigen transactieprijzen getoond."
          : `Live historie niet beschikbaar (${error.message || "onbekende fout"}). Eigen transactieprijzen getoond.`;
      }
      if (token !== assetChartToken || !canvas.isConnected) return;
      const model = buildAssetChartModel(item, history, range);
      drawAssetChart(canvas, model);
      updateAssetChartMeta(model, history, range, note);
    }

    function fetchAssetHistory(item, range) {
      const cacheKey = `${item.ticker}:${range.key}`;
      if (historyMemo.has(cacheKey)) return historyMemo.get(cacheKey);
      const promise = (async () => {
        const cached = readHistoryCache(cacheKey);
        if (cached) return { points: cached.points, source: cached.source, cachedAt: cached.at };
        const result = item.type === "Crypto" && COINGECKO_IDS[item.ticker]
          ? await fetchCryptoHistory(item.ticker, range)
          : await fetchEquityHistory(item, range);
        writeHistoryCache(cacheKey, { at: new Date().toISOString(), points: result.points, source: result.source });
        return result;
      })();
      historyMemo.set(cacheKey, promise);
      // Mislukte fetches even vasthouden (negatieve cache) zodat een render
      // geen burst van retries veroorzaakt; na 45s mag het opnieuw.
      promise.catch(() => setTimeout(() => {
        if (historyMemo.get(cacheKey) === promise) historyMemo.delete(cacheKey);
      }, 45000));
      return promise;
    }

    async function fetchCryptoHistory(ticker, range) {
      // De publieke CoinGecko-API staat maximaal 365 dagen historie toe
      // (days=max geeft 401); oudere periodes vallen terug op transactieprijzen.
      const days = range.days ? String(Math.min(range.days, 365)) : "365";
      const url = `https://api.coingecko.com/api/v3/coins/${COINGECKO_IDS[ticker]}/market_chart?vs_currency=eur&days=${days}`;
      const response = await fetchWithTimeout(url);
      if (!response.ok) throw new Error(`CoinGecko gaf status ${response.status}`);
      const payload = await response.json();
      const points = (payload.prices || [])
        .map(([t, p]) => ({ t: Number(t), p: Number(p) }))
        .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.p) && point.p > 0);
      if (points.length < 2) throw new Error("geen historische koersen gevonden");
      return { points: downsamplePoints(points, HISTORY_MAX_POINTS), source: "CoinGecko" };
    }

    async function fetchEquityHistory(item, range) {
      const symbol = resolveEquityQuoteSymbol(item.ticker);
      const interval = range.key === "max" ? "1wk" : "1d";
      const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range.yahooRange}&interval=${interval}`;
      const payload = await fetchFirstJson([yahooUrl, `${YAHOO_CHART_PROXY}${encodeURIComponent(yahooUrl)}`]);
      const result = payload?.chart?.result?.[0];
      if (payload?.chart?.error) throw new Error(payload.chart.error.description || payload.chart.error.code || "Yahoo gaf een fout");
      const timestamps = result?.timestamp || [];
      const closes = result?.indicators?.quote?.[0]?.close || [];
      const quoteCurrency = String(result?.meta?.currency || "").toUpperCase();
      let fx = 1;
      if (quoteCurrency === "USD") fx = await usdEurRateCached();
      else if (quoteCurrency && quoteCurrency !== "EUR") throw new Error(`valuta ${quoteCurrency} niet ondersteund`);
      const points = timestamps
        .map((t, index) => ({ t: Number(t) * 1000, p: Number(closes[index]) * fx }))
        .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.p) && point.p > 0);
      if (points.length < 2) throw new Error("geen historische koersen gevonden");
      return { points: downsamplePoints(points, HISTORY_MAX_POINTS), source: "Yahoo Finance" };
    }

    // Fetch met harde timeout zodat een hangende bron de grafieken niet blokkeert.
    function fetchWithTimeout(url, ms = 9000) {
      return fetch(url, typeof AbortSignal !== "undefined" && AbortSignal.timeout ? { signal: AbortSignal.timeout(ms) } : {});
    }

    async function fetchFirstJson(urls) {
      const errors = [];
      for (const url of urls) {
        try {
          const response = await fetchWithTimeout(url);
          if (!response.ok) throw new Error(`status ${response.status}`);
          return await response.json();
        } catch (error) {
          errors.push(error.message || "fetch mislukt");
        }
      }
      throw new Error(errors.join(", "));
    }

    async function usdEurRateCached() {
      if (usdEurRateCache && Date.now() - usdEurRateCache.at < HISTORY_TTL_MS) return usdEurRateCache.rate;
      const rate = await fetchUsdEurRate();
      usdEurRateCache = { rate, at: Date.now() };
      return rate;
    }

    function readHistoryCache(key) {
      try {
        const store = JSON.parse(localStorage.getItem(HISTORY_CACHE_KEY) || "{}");
        const entry = store[key];
        if (!entry || !Array.isArray(entry.points)) return null;
        if (Date.now() - new Date(entry.at).getTime() > HISTORY_TTL_MS) return null;
        return entry;
      } catch {
        return null;
      }
    }

    function writeHistoryCache(key, entry) {
      try {
        const store = JSON.parse(localStorage.getItem(HISTORY_CACHE_KEY) || "{}");
        store[key] = entry;
        const keys = Object.keys(store);
        if (keys.length > HISTORY_MAX_ENTRIES) {
          keys
            .sort((a, b) => new Date(store[a].at) - new Date(store[b].at))
            .slice(0, keys.length - HISTORY_MAX_ENTRIES)
            .forEach((oldKey) => delete store[oldKey]);
        }
        localStorage.setItem(HISTORY_CACHE_KEY, JSON.stringify(store));
      } catch {
        // Cache is best-effort; zonder opslagruimte blijft de grafiek gewoon live werken.
      }
    }

    function downsamplePoints(points, maxPoints) {
      if (points.length <= maxPoints) return points;
      const step = (points.length - 1) / (maxPoints - 1);
      return Array.from({ length: maxPoints }, (_, index) => points[Math.round(index * step)]);
    }

    function transactionFallbackHistory(item, range) {
      const startMs = range.days ? Date.now() - range.days * 86400000 : 0;
      const points = state.transactions
        .filter((txItem) => txItem.ticker === item.ticker && Number(txItem.price) > 0)
        .map((txItem) => ({ t: new Date(`${txItem.date}T12:00:00`).getTime(), p: Number(txItem.price) }))
        .filter((point) => Number.isFinite(point.t) && point.t >= startMs)
        .sort((a, b) => a.t - b.t);
      if (Number(item.currentPrice) > 0) points.push({ t: Date.now(), p: Number(item.currentPrice) });
      return { points, source: "transacties" };
    }

    function buildAssetChartModel(item, history, range) {
      const startMs = range.days ? Date.now() - range.days * 86400000 : 0;
      const filtered = history.points.filter((point) => point.t >= startMs);
      const points = filtered.length >= 2 ? filtered : history.points;
      const values = points.map((point) => point.p);
      return {
        points,
        markers: assetChartMarkers(item.ticker, points),
        avgPrice: Number(item.avgPrice) || 0,
        min: Math.min(...values),
        max: Math.max(...values)
      };
    }

    function assetChartMarkers(ticker, points) {
      if (!points.length) return [];
      const startMs = points[0].t - 43200000;
      const endMs = points[points.length - 1].t + 86400000;
      const byKey = new Map();
      // Regels met prijs 0 (staking, dividend, correcties) zijn geen echte
      // handelsmomenten en horen niet als marker op de koerslijn.
      state.transactions
        .filter((txItem) => txItem.ticker === ticker && Number(txItem.quantity) > 0 && Number(txItem.price) > 0)
        .forEach((txItem) => {
          const t = new Date(`${txItem.date}T12:00:00`).getTime();
          if (!Number.isFinite(t) || t < startMs || t > endMs) return;
          const key = `${txItem.date}:${txItem.side}`;
          const row = byKey.get(key) || { date: txItem.date, side: txItem.side, t, quantity: 0, total: 0, count: 0 };
          row.quantity += Number(txItem.quantity) || 0;
          row.total += (Number(txItem.quantity) || 0) * (Number(txItem.price) || 0);
          row.count += 1;
          byKey.set(key, row);
        });
      return [...byKey.values()]
        .map((row) => ({
          ...row,
          price: row.quantity ? row.total / row.quantity : 0,
          index: nearestPointIndex(points, row.t)
        }))
        .sort((a, b) => a.t - b.t);
    }

    function nearestPointIndex(points, t) {
      let best = 0;
      let bestDistance = Infinity;
      points.forEach((point, index) => {
        const distance = Math.abs(point.t - t);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = index;
        }
      });
      return best;
    }

    // Assetgrafiek op de generieke tijdreeks-engine: koerslijn, gemiddelde
    // aankoopprijs en aan-/verkoopmarkers met orderdetails in de tooltip.
    function drawAssetChart(canvas, model) {
      const pricePoints = model.points.map((point) => ({ t: point.t, v: point.p }));
      const markers = model.markers.map((marker) => ({
        index: marker.index,
        color: marker.side === "sell" ? "#d9577b" : "#1f9d77",
        data: marker
      }));
      const nearest = (hover, tolerance) => {
        if (hover === null || hover === undefined) return [];
        const within = markers.filter((marker) => Math.abs(marker.index - hover) <= tolerance);
        if (!within.length) return [];
        const best = Math.min(...within.map((marker) => Math.abs(marker.index - hover)));
        return within.filter((marker) => Math.abs(marker.index - hover) === best);
      };
      drawTimeChart(canvas, {
        series: [{ points: pricePoints, color: "#137c9b", width: 2.5, fill: "rgba(19,124,155,.16)" }],
        markers,
        activeMarkers: nearest,
        avgLine: model.avgPrice > 0 ? { value: model.avgPrice, label: `gem. aankoop ${currency.format(model.avgPrice)}` } : null,
        formatValue: (value) => currency.format(value),
        tooltip: (index, tolerance) => {
          const point = model.points[index];
          const orders = nearest(index, tolerance).map(({ data }) => `<div class="tooltip-order ${data.side === "sell" ? "sell" : "buy"}">
            <strong>${data.side === "sell" ? "Verkoop" : "Aankoop"}${data.count > 1 ? ` · ${data.count} orders` : ""} · ${dateNl(data.date)}</strong>
            <span>Aantal</span><span>${number.format(data.quantity)}</span>
            <span>Prijs</span><span>${currency.format(data.price)}</span>
            <span>Totaal</span><span>${currency.format(data.total)}</span>
          </div>`).join("");
          return `<strong>${dateNlFromMs(point.t)}</strong>${currency.format(point.p)}${orders}`;
        },
        emptyTitle: "Geen koershistorie",
        emptyNote: "Voor deze periode zijn geen datapunten beschikbaar."
      });
    }

    function updateAssetChartMeta(model, history, range, note) {
      const target = document.getElementById("assetChartMeta");
      if (!target) return;
      if (!model.points || model.points.length < 2) {
        target.innerHTML = `<span>${esc(note || "Geen koershistorie beschikbaar voor deze periode.")}</span>`;
        return;
      }
      const first = model.points[0];
      const last = model.points[model.points.length - 1];
      const change = first.p > 0 ? (last.p - first.p) / first.p : 0;
      const buys = model.markers.filter((marker) => marker.side !== "sell").length;
      const sells = model.markers.filter((marker) => marker.side === "sell").length;
      const periodLabel = range.key === "max" ? "de hele periode" : range.label;
      const sourceLabel = history.source === "transacties"
        ? "Bron: eigen transactieprijzen"
        : history.cachedAt
          ? `Bron: ${history.source} (opgehaald ${dateTimeNl(history.cachedAt)})`
          : `Bron: ${history.source} (live)`;
      target.innerHTML = [
        `<span><strong class="${change >= 0 ? "gain" : "loss"}">${change >= 0 ? "+" : ""}${pct.format(change)}</strong> in ${esc(periodLabel)}</span>`,
        `<span>Laag ${currency.format(model.min)} · hoog ${currency.format(model.max)}</span>`,
        `<span><span class="marker-dot buy"></span>${number.format(buys)} koopmoment${buys === 1 ? "" : "en"} <span class="marker-dot sell"></span>${number.format(sells)} verkoopmoment${sells === 1 ? "" : "en"}</span>`,
        `<span>${esc(sourceLabel)}</span>`,
        note ? `<span>${esc(note)}</span>` : ""
      ].filter(Boolean).join("");
    }

    function dateNlFromMs(ms) {
      const date = new Date(ms);
      if (Number.isNaN(date.getTime())) return "Onbekend";
      return new Intl.DateTimeFormat("nl-NL", { day: "2-digit", month: "short", year: "numeric" }).format(date);
    }

    function closePositionModal() {
      closeDialog("positionModal");
    }

    function openDialog(id, focusTarget) {
      const modal = document.getElementById(id);
      if (!modal) return;
      activeModalOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      activeModal = modal;
      modal.classList.add("open");
      document.body.classList.add("modal-open");
      setAppInert(true);
      requestAnimationFrame(() => {
        const target = focusTarget || firstFocusable(modal) || modal.querySelector(".dialog");
        if (target instanceof HTMLElement) target.focus();
      });
    }

    function closeDialog(id) {
      const modal = document.getElementById(id);
      if (!modal) return;
      hideChartTooltip();
      modal.classList.remove("open");
      if (activeModal === modal) activeModal = null;
      if (!document.querySelector(".modal.open")) {
        document.body.classList.remove("modal-open");
        setAppInert(false);
      }
      if (activeModalOpener instanceof HTMLElement && document.contains(activeModalOpener)) {
        activeModalOpener.focus();
      }
      activeModalOpener = null;
    }

    function closeActiveModal() {
      if (!activeModal) return;
      const id = activeModal.id;
      if (id === "txModal") closeModal();
      else if (id === "pricesModal") closePricesModal();
      else if (id === "positionModal") closePositionModal();
    }

    function setAppInert(inert) {
      ["main", "aside"].forEach((selector) => {
        const element = document.querySelector(selector);
        if (!element) return;
        element.inert = inert;
        element.setAttribute("aria-hidden", String(inert));
        if (!inert) element.removeAttribute("aria-hidden");
      });
    }

    function focusableElements(scope) {
      return [...scope.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")]
        .filter((element) => !element.disabled && element.offsetParent !== null);
    }

    function firstFocusable(scope) {
      return focusableElements(scope)[0] || null;
    }

    function handleModalKeydown(event) {
      if (!activeModal) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeActiveModal();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableElements(activeModal);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
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

    window.removeWatchlistItem = (id) => {
      state.watchlist = (state.watchlist || []).filter((item) => item.id !== id);
      persist();
      render();
    };

    window.removeIncomeItem = (id) => {
      state.incomeItems = (state.incomeItems || []).filter((item) => item.id !== id);
      persist();
      render();
    };

    window.removeAlert = (id) => {
      state.alerts = (state.alerts || []).filter((item) => item.id !== id);
      persist();
      render();
    };

    function inferAssetType(ticker) {
      const normalized = String(ticker || "").trim().toUpperCase();
      if (COINGECKO_IDS[normalized]) return "Crypto";
      if (normalized in EQUITY_QUOTE_SYMBOLS) return "ETF";
      return "Aandeel";
    }

    async function lookupWatchlistTicker(ticker) {
      const normalized = String(ticker || "").trim().toUpperCase();
      if (!normalized) throw new Error("Ticker ontbreekt.");
      if (COINGECKO_IDS[normalized]) {
        const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(COINGECKO_IDS[normalized])}&vs_currencies=eur`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`CoinGecko gaf status ${response.status}.`);
        const payload = await response.json();
        const currentPrice = Number(payload[COINGECKO_IDS[normalized]]?.eur);
        if (!Number.isFinite(currentPrice) || currentPrice <= 0) throw new Error("Geen crypto-koers gevonden.");
        return { ticker: normalized, name: cryptoName(normalized), type: "Crypto", currentPrice };
      }

      const quote = await fetchYahooChartQuote({ ticker: normalized });
      const rates = quote.currency === "USD" ? { USD_EUR: await fetchUsdEurRate() } : {};
      const converted = convertQuoteToEur(quote, rates);
      if (!converted || !Number.isFinite(converted.priceEur) || converted.priceEur <= 0) throw new Error("Geen bruikbare koers gevonden.");
      return {
        ticker: normalized,
        name: quote.name || normalized,
        type: inferAssetType(normalized),
        currentPrice: Number(converted.priceEur)
      };
    }

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
        const convertedQuote = convertQuoteToEur(quote, { USD_EUR: usdEurRate });
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

    function latestPriceUpdateLabel() {
      const dates = Object.values(state.priceMeta || {})
        .map((item) => new Date(item?.updatedAt || "").getTime())
        .filter(Number.isFinite);
      if (!dates.length) return "onbekend";
      const latest = new Date(Math.max(...dates));
      const ageDays = Math.floor((Date.now() - latest.getTime()) / 86400000);
      if (ageDays <= 0) return "vandaag";
      if (ageDays === 1) return "gisteren";
      if (ageDays < 7) return `${ageDays} dagen geleden`;
      return dateNl(latest.toISOString().slice(0, 10));
    }

    function priceRefreshButtonHtml(label, meta = latestPriceUpdateLabel()) {
      return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/><path d="M3 12a9 9 0 0 1 15.74-6.26L21 8"/><path d="M16 8h5V3"/></svg><span class="price-refresh-text"><span>${esc(label)}</span><small>Laatste: ${esc(meta)}</small></span>`;
    }

    function updatePriceRefreshMeta() {
      const button = document.getElementById("refreshPricesBtn");
      if (!button || button.disabled) return;
      button.innerHTML = priceRefreshButtonHtml("Koersen");
      button.dataset.readyHtml = button.innerHTML;
      button.title = `Koersdata ophalen · laatste update ${latestPriceUpdateLabel()}`;
    }

    function setPriceRefreshButton(label, { loading = false, restore = false, title = "" } = {}) {
      const button = document.getElementById("refreshPricesBtn");
      if (!button) return;
      button.dataset.readyHtml = button.dataset.readyHtml || button.innerHTML;
      button.disabled = loading;
      button.innerHTML = label ? priceRefreshButtonHtml(label) : button.dataset.readyHtml;
      if (title) button.title = title;
      if (restore) {
        setTimeout(() => {
          button.disabled = false;
          updatePriceRefreshMeta();
        }, 2600);
      }
    }

    async function refreshAssetPrices() {
      const button = document.getElementById("refreshPricesBtn");
      if (button?.disabled) return;
      const allPositions = positions();
      if (!allPositions.length) {
        openPricesModal();
        return;
      }

      const cryptoCount = allPositions.filter((item) => item.type === "Crypto" && COINGECKO_IDS[item.ticker]).length;
      const equityCount = allPositions.filter((item) => isEquityQuotePosition(item)).length;
      const unsupportedCount = allPositions.length - cryptoCount - equityCount;
      let updated = 0;
      const notes = [];

      setPriceRefreshButton("Bijwerken", { loading: true, title: "Koersen live ophalen..." });
      try {
        if (cryptoCount) {
          const cryptoResult = await updateCryptoPrices({ keepModalOpen: true });
          updated += cryptoResult?.updated || 0;
          if (cryptoResult?.error) notes.push(`Crypto: ${cryptoResult.error.message || "mislukt"}`);
        }
        if (equityCount) {
          const equityResult = await updateEquityPrices({ keepModalOpen: true });
          updated += equityResult?.updated || 0;
          if (equityResult?.skipped?.length) notes.push(`${equityResult.skipped.length} aandelen/ETF overgeslagen`);
        }
        if (unsupportedCount > 0) notes.push(`${unsupportedCount} positie(s) zonder live bron`);
        const label = updated ? `${updated} koersen` : "Geen update";
        const title = notes.length ? `${updated} koersen bijgewerkt. ${notes.join("; ")}.` : `${updated} koersen bijgewerkt.`;
        setPriceRefreshButton(label, { restore: true, title });
      } catch (error) {
        setPriceRefreshButton("Mislukt", { restore: true, title: error.message || "Koersen bijwerken mislukt" });
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
      state.dcas = state.dcas.map((plan) => {
        if (plan.id !== id) return plan;
        const active = !plan.active;
        // Bij heractiveren niet met terugwerkende kracht aankopen genereren:
        // de pauzeperiode is immers niet gekocht.
        return { ...plan, active, lastGeneratedDate: active ? todayISO() : plan.lastGeneratedDate };
      });
      applyDcaPlans();
      persist();
      render();
    };

    let resizeTimer = null;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => drawChartsForView(activeView()), 150);
    });
    // Startup pas ná alle declaraties, zodat let/const-bindings nooit in de
    // temporal dead zone geraakt worden tijdens de eerste render.
    if (applyDcaPlans()) persist();
    if (captureDailySnapshot()) persist();
    applySidebarState();
    render();
    renderDcaAssetDraft();
    document.querySelector("#dcaForm [name=startDate]").value = todayISO();
