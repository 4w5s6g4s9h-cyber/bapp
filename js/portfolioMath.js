function parsePriceNumber(value) {
  const raw = String(value || "").replace(/[€\s]/g, "");
  const normalized = raw.includes(",") ? raw.replace(/\./g, "").replace(",", ".") : raw;
  return Number(normalized);
}

function parsePriceCsv(text) {
  const rows = text.split(/\r?\n/).map((row) => row.trim()).filter(Boolean);
  if (!rows.length) throw new Error("Het prijsbestand is leeg.");

  const updates = {};
  rows.forEach((row, index) => {
    const separator = row.includes(";") ? ";" : ",";
    const columns = row.split(separator).map((value) => value.trim().replace(/^"|"$/g, ""));
    if (index === 0 && /ticker|symbol/i.test(columns[0])) return;

    const ticker = (columns[0] || "").toUpperCase();
    const price = parsePriceNumber(columns[1]);
    if (!ticker || !Number.isFinite(price) || price <= 0) return;
    updates[ticker] = price;
  });

  if (!Object.keys(updates).length) {
    throw new Error("Geen geldige prijzen gevonden. Gebruik bijvoorbeeld: BTC,52650");
  }
  return updates;
}

const EQUITY_QUOTE_SYMBOLS = {
  VWCE: "VWCE.DE",
  VWRL: "VWRL.AS",
  ISPA: "ISPA.DE",
  WTAI: "WTAI.MI"
};

function resolveEquityQuoteSymbol(ticker, overrides = EQUITY_QUOTE_SYMBOLS) {
  const normalized = String(ticker || "").trim().toUpperCase();
  return overrides[normalized] || normalized;
}

function parseYahooChartQuote(payload) {
  const result = payload?.chart?.result?.[0];
  const error = payload?.chart?.error;
  if (error) throw new Error(error.description || error.code || "Yahoo gaf geen koers terug.");

  const meta = result?.meta || {};
  const price = Number(meta.regularMarketPrice);
  const currency = String(meta.currency || "").toUpperCase();
  const symbol = String(meta.symbol || "").toUpperCase();
  if (!symbol || !Number.isFinite(price) || price <= 0 || !currency) return null;

  return {
    symbol,
    price,
    currency,
    regularMarketTime: meta.regularMarketTime || null,
    name: meta.longName || meta.shortName || ""
  };
}

function convertQuoteToEur(quote, rates = {}) {
  if (!quote || !Number.isFinite(Number(quote.price)) || Number(quote.price) <= 0) return null;
  if (quote.currency === "EUR") return { ...quote, priceEur: Number(quote.price), fxRate: 1 };
  if (quote.currency !== "USD") return null;

  const usdEur = Number(rates.USD_EUR);
  if (!Number.isFinite(usdEur) || usdEur <= 0) return null;
  return { ...quote, priceEur: Number(quote.price) * usdEur, fxRate: usdEur };
}

function dcaDates(start, frequency, end) {
  const dates = [];
  const cursor = new Date(`${start}T00:00:00`);
  const last = new Date(`${end}T00:00:00`);

  while (cursor <= last) {
    dates.push(dateToISO(cursor));
    if (frequency === "weekly") cursor.setDate(cursor.getDate() + 7);
    if (frequency === "monthly") cursor.setMonth(cursor.getMonth() + 1);
    if (frequency === "quarterly") cursor.setMonth(cursor.getMonth() + 3);
  }

  return dates;
}

function dateToISO(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function priceOf(state, ticker, fallback) {
  const stored = state && state.prices ? Number(state.prices[ticker]) : 0;
  return Number.isFinite(stored) && stored > 0 ? stored : fallback;
}

function averagePriceFor(state, pos) {
  if (state.avgPriceCorrections?.[pos.ticker]) return pos.quantity ? pos.cost / pos.quantity : 0;
  const override = state.avgPrices ? Number(state.avgPrices[pos.ticker]) : 0;
  return Number.isFinite(override) && override > 0 ? override : pos.cost / pos.quantity;
}

function positions(state) {
  const map = new Map();
  const correctionEvents = Object.entries(state.avgPriceCorrections || {}).map(([ticker, correction]) => ({
    ticker,
    side: "correction",
    date: correction.date || dateToISO(new Date()),
    avgPrice: Number(correction.avgPrice),
    order: 1
  })).filter((item) => Number.isFinite(item.avgPrice) && item.avgPrice >= 0);
  const transactionEvents = (state.transactions || []).map((item) => ({ ...item, order: 0 }));
  [...transactionEvents, ...correctionEvents]
    .sort((a, b) => new Date(a.date) - new Date(b.date) || a.order - b.order)
    .forEach((item) => {
      if (!map.has(item.ticker)) {
        map.set(item.ticker, {
          ticker: item.ticker,
          name: item.name,
          type: item.type,
          quantity: 0,
          cost: 0,
          currentPrice: item.currentPrice,
          firstDate: item.date,
          transactions: 0
        });
      }

      const pos = map.get(item.ticker);
      if (item.side === "correction") {
        pos.cost = Math.max(0, pos.quantity * item.avgPrice);
      } else if (item.side === "sell") {
        const averageCost = pos.quantity > 0 ? pos.cost / pos.quantity : 0;
        const soldQuantity = Math.min(item.quantity, pos.quantity);
        pos.quantity -= soldQuantity;
        pos.cost -= soldQuantity * averageCost;
      } else {
        pos.quantity += item.quantity;
        pos.cost += item.quantity * item.price;
      }

      if (item.side !== "correction") {
        pos.currentPrice = priceOf(state, item.ticker, item.currentPrice || pos.currentPrice);
        pos.firstDate = item.date < pos.firstDate ? item.date : pos.firstDate;
        pos.transactions += 1;
      }
    });

  return [...map.values()]
    .filter((pos) => pos.quantity > 0)
    .map((pos) => {
      const avgPrice = averagePriceFor(state, pos);
      const cost = avgPrice * pos.quantity;
      const value = pos.quantity * pos.currentPrice;
      const gain = value - cost;
      return {
        ...pos,
        avgPrice,
        cost,
        value,
        gain,
        gainPct: cost ? gain / cost : 0
      };
    })
    .sort((a, b) => b.value - a.value);
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

function dcaPlanQuantity(plan) {
  const assets = Array.isArray(plan.assets) ? plan.assets : [];
  if (assets.length) return assets.reduce((sum, asset) => sum + Number(asset.quantity || 0), 0);
  const quantity = Number(plan.quantity);
  if (Number.isFinite(quantity) && quantity > 0) return quantity;
  const amount = Number(plan.amount);
  const price = Number(plan.price);
  return Number.isFinite(amount) && Number.isFinite(price) && price > 0 ? amount / price : 0;
}

function dcaPlanValue(state, plan) {
  const assets = normalizeDcaAssets(plan);
  if (assets.length) {
    return assets.reduce((sum, asset) => sum + asset.quantity * priceOf(state, asset.ticker, Number(plan.price) || 0), 0);
  }
  const amount = Number(plan.amount);
  if (Number.isFinite(amount) && amount > 0) return amount;
  return dcaPlanQuantity(plan) * (Number(plan.price) || 0);
}

function totals(state) {
  const list = positions(state);
  const cost = list.reduce((sum, item) => sum + item.cost, 0);
  const value = list.reduce((sum, item) => sum + item.value, 0);
  const gain = value - cost;
  const dcaMonthly = (state.dcas || []).filter((plan) => plan.active).reduce((sum, plan) => {
    const valuePerRun = dcaPlanValue(state, plan);
    if (plan.frequency === "weekly") return sum + valuePerRun * 52 / 12;
    if (plan.frequency === "quarterly") return sum + valuePerRun / 3;
    return sum + valuePerRun;
  }, 0);

  return { list, cost, value, gain, gainPct: cost ? gain / cost : 0, dcaMonthly };
}
