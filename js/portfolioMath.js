(() => {
function parsePriceNumber(value) {
  const raw = String(value ?? "").replace(/[€\s]/g, "");
  if (!raw) return 0;
  const hasComma = raw.includes(",");
  const hasDot = raw.includes(".");
  let normalized = raw;
  if (hasComma && hasDot) {
    // Het laatste scheidingsteken is het decimaalteken (1.234,56 vs 1,234.56).
    normalized = raw.lastIndexOf(",") > raw.lastIndexOf(".")
      ? raw.replace(/\./g, "").replace(",", ".")
      : raw.replace(/,/g, "");
  } else if (hasComma) {
    normalized = raw.replace(",", ".");
  }
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

function addMonthsClamped(date, months) {
  // Voorkomt overflow (31 jan + 1 maand mag niet 3 maart worden).
  const result = new Date(date.getFullYear(), date.getMonth() + months, 1);
  const daysInMonth = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
  result.setDate(Math.min(date.getDate(), daysInMonth));
  return result;
}

function dcaDates(start, frequency, end) {
  const dates = [];
  const startDate = new Date(`${start}T00:00:00`);
  const last = new Date(`${end}T00:00:00`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(last.getTime())) return dates;

  let step = 0;
  let cursor = new Date(startDate);
  while (cursor <= last) {
    dates.push(dateToISO(cursor));
    step += 1;
    if (frequency === "weekly") {
      cursor = new Date(startDate);
      cursor.setDate(startDate.getDate() + 7 * step);
    } else {
      cursor = addMonthsClamped(startDate, (frequency === "quarterly" ? 3 : 1) * step);
    }
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

function positionEvents(state) {
  const correctionEvents = Object.entries(state.avgPriceCorrections || {}).map(([ticker, correction]) => ({
    ticker,
    side: "correction",
    date: correction.date || dateToISO(new Date()),
    avgPrice: Number(correction.avgPrice),
    order: 1
  })).filter((item) => Number.isFinite(item.avgPrice) && item.avgPrice >= 0);
  const transactionEvents = (state.transactions || []).map((item) => ({ ...item, order: 0 }));
  return [...transactionEvents, ...correctionEvents]
    .sort((a, b) => new Date(a.date) - new Date(b.date) || a.order - b.order);
}

function positions(state) {
  const map = new Map();
  positionEvents(state).forEach((item) => {
    if (!map.has(item.ticker)) {
      map.set(item.ticker, {
        ticker: item.ticker,
        name: item.name,
        type: item.type,
        quantity: 0,
        cost: 0,
        realizedGain: 0,
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
      pos.realizedGain += soldQuantity * (item.price - averageCost);
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

function realizedGains(state) {
  // Gerealiseerd resultaat per verkoop, op basis van gemiddelde kostprijs
  // (inclusief handmatige gemiddelde-prijs-correcties, net als positions()).
  const running = new Map();
  const rows = [];
  positionEvents(state).forEach((item) => {
    const entry = running.get(item.ticker) || { quantity: 0, cost: 0 };
    if (item.side === "correction") {
      entry.cost = Math.max(0, entry.quantity * item.avgPrice);
    } else if (item.side === "sell") {
      const averageCost = entry.quantity > 0 ? entry.cost / entry.quantity : 0;
      const soldQuantity = Math.min(item.quantity, entry.quantity);
      entry.quantity -= soldQuantity;
      entry.cost -= soldQuantity * averageCost;
      if (soldQuantity > 0) {
        rows.push({
          ticker: item.ticker,
          date: item.date,
          quantity: soldQuantity,
          proceeds: soldQuantity * item.price,
          costBasis: soldQuantity * averageCost,
          gain: soldQuantity * (item.price - averageCost)
        });
      }
    } else {
      entry.quantity += item.quantity;
      entry.cost += item.quantity * item.price;
    }
    running.set(item.ticker, entry);
  });
  return rows;
}

function realizedGainForYear(state, year) {
  const prefix = String(year);
  return realizedGains(state)
    .filter((row) => String(row.date || "").startsWith(prefix))
    .reduce((sum, row) => sum + row.gain, 0);
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

// ---- Rendement- en risicostatistiek (puur, geen state) ----

const MS_PER_YEAR = 31557600000;

// Money-weighted rendement (XIRR) via bisectie op de netto contante waarde.
// flows: [{ date: "YYYY-MM-DD" of ms, amount }] met minstens één negatieve
// (inleg) en één positieve (waarde/verkoop) flow. Retourneert jaarrendement
// als fractie, of null wanneer er geen oplosbare wortel is.
function xirr(flows) {
  const points = (flows || [])
    .map((flow) => ({
      t: typeof flow.date === "number" ? flow.date : new Date(`${flow.date}T00:00:00`).getTime(),
      amount: Number(flow.amount)
    }))
    .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.amount) && point.amount !== 0);
  if (points.length < 2) return null;
  if (!points.some((point) => point.amount < 0) || !points.some((point) => point.amount > 0)) return null;
  const t0 = Math.min(...points.map((point) => point.t));
  const years = points.map((point) => ({ y: (point.t - t0) / MS_PER_YEAR, amount: point.amount }));
  const npv = (rate) => years.reduce((sum, point) => sum + point.amount / Math.pow(1 + rate, point.y), 0);
  let lo = -0.9999;
  let hi = 10;
  let npvLo = npv(lo);
  if (npvLo * npv(hi) > 0) return null;
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2;
    const npvMid = npv(mid);
    if (Math.abs(npvMid) < 1e-7) return mid;
    if (npvLo * npvMid < 0) hi = mid;
    else {
      lo = mid;
      npvLo = npvMid;
    }
  }
  return (lo + hi) / 2;
}

// Time-weighted rendement over een reeks [{ value, invested }] (chronologisch).
// Stortingen/onttrekkingen (verschil in invested) worden per stap uitgefilterd,
// zodat alleen marktrendement telt.
function timeWeightedReturn(series) {
  if (!Array.isArray(series) || series.length < 2) return null;
  let growth = 1;
  let steps = 0;
  for (let i = 1; i < series.length; i += 1) {
    const prev = series[i - 1];
    const cur = series[i];
    if (!(prev.value > 0)) continue;
    const flow = (Number(cur.invested) || 0) - (Number(prev.invested) || 0);
    const stepReturn = (cur.value - flow) / prev.value;
    if (!Number.isFinite(stepReturn) || stepReturn <= 0) continue;
    growth *= stepReturn;
    steps += 1;
  }
  return steps ? growth - 1 : null;
}

// Grootste piek-naar-dal-daling als fractie (negatief getal), plus de indexen.
function maxDrawdown(values) {
  let peak = -Infinity;
  let peakIndex = 0;
  let worst = 0;
  let worstPeakIndex = 0;
  let worstTroughIndex = 0;
  (values || []).forEach((value, index) => {
    if (value > peak) {
      peak = value;
      peakIndex = index;
    }
    if (peak > 0) {
      const drawdown = value / peak - 1;
      if (drawdown < worst) {
        worst = drawdown;
        worstPeakIndex = peakIndex;
        worstTroughIndex = index;
      }
    }
  });
  return { drawdown: worst, peakIndex: worstPeakIndex, troughIndex: worstTroughIndex };
}

// Flow-gecorrigeerde maandrendementen uit een reeks [{ date|t, value, invested }].
function monthlyReturns(series, minValue = 0) {
  // minValue filtert maanden weg waarin de portefeuille nog verwaarloosbaar
  // klein was: een sprong van 50 naar 150 euro is geen bruikbaar rendement.
  if (!Array.isArray(series) || series.length < 2) return [];
  const byMonth = new Map();
  series.forEach((point) => {
    const ms = point.t ?? new Date(`${point.date}T00:00:00`).getTime();
    if (!Number.isFinite(ms)) return;
    const key = new Date(ms).toISOString().slice(0, 7);
    byMonth.set(key, point); // laatste punt per maand wint
  });
  const months = [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, point]) => point);
  const returns = [];
  for (let i = 1; i < months.length; i += 1) {
    const prev = months[i - 1];
    const cur = months[i];
    if (!(prev.value > 0) || prev.value < minValue) continue;
    const flow = (Number(cur.invested) || 0) - (Number(prev.invested) || 0);
    const stepReturn = (cur.value - flow) / prev.value - 1;
    if (Number.isFinite(stepReturn) && stepReturn > -1) returns.push(stepReturn);
  }
  return returns;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function stdev(values) {
  if (!values || values.length < 2) return 0;
  const avg = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

// Pearson-correlatie tussen twee even lange reeksen.
function correlation(a, b) {
  if (!a || !b || a.length !== b.length || a.length < 3) return null;
  const meanA = mean(a);
  const meanB = mean(b);
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  const denom = Math.sqrt(varA * varB);
  return denom > 0 ? cov / denom : null;
}

function quantile(sortedValues, q) {
  if (!sortedValues.length) return 0;
  const pos = (sortedValues.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sortedValues[base + 1];
  return next === undefined ? sortedValues[base] : sortedValues[base] + rest * (next - sortedValues[base]);
}

// Monte-Carlo-projectie van portefeuillewaarde met maandelijkse inleg.
// samples: eigen historische maandrendementen (bootstrap) — bij te weinig
// samples wordt normaal getrokken met opgegeven jaarlijkse mu/sigma.
function monteCarloProjection({ startValue, monthly, months, samples = [], mu = 0.06, sigma = 0.15, runs = 500, random = Math.random }) {
  const useBootstrap = samples.length >= 24;
  const muMonthly = Math.pow(1 + mu, 1 / 12) - 1;
  const sigmaMonthly = sigma / Math.sqrt(12);
  const normal = () => {
    const u1 = Math.max(random(), 1e-12);
    const u2 = random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };
  const drawReturn = useBootstrap
    ? () => samples[Math.floor(random() * samples.length)]
    : () => muMonthly + sigmaMonthly * normal();
  const paths = [];
  for (let run = 0; run < runs; run += 1) {
    let value = startValue;
    const path = new Array(months);
    for (let month = 0; month < months; month += 1) {
      value = Math.max(0, value * (1 + drawReturn()) + monthly);
      path[month] = value;
    }
    paths.push(path);
  }
  const p10 = new Array(months);
  const p50 = new Array(months);
  const p90 = new Array(months);
  const column = new Array(runs);
  for (let month = 0; month < months; month += 1) {
    for (let run = 0; run < runs; run += 1) column[run] = paths[run][month];
    column.sort((a, b) => a - b);
    p10[month] = quantile(column, 0.1);
    p50[month] = quantile(column, 0.5);
    p90[month] = quantile(column, 0.9);
  }
  const endValues = paths.map((path) => path[months - 1]).sort((a, b) => a - b);
  return { p10, p50, p90, endValues, method: useBootstrap ? "bootstrap" : "normaal" };
}

// Namespace zodat tracker.js kan delegeren zonder botsende globale namen.
globalThis.PortfolioMath = {
  parsePriceNumber,
  parsePriceCsv,
  EQUITY_QUOTE_SYMBOLS,
  resolveEquityQuoteSymbol,
  parseYahooChartQuote,
  convertQuoteToEur,
  addMonthsClamped,
  dcaDates,
  dateToISO,
  priceOf,
  averagePriceFor,
  positions,
  realizedGains,
  realizedGainForYear,
  normalizeDcaAssets,
  dcaPlanQuantity,
  dcaPlanValue,
  totals,
  xirr,
  timeWeightedReturn,
  maxDrawdown,
  monthlyReturns,
  mean,
  stdev,
  correlation,
  quantile,
  monteCarloProjection
};
})();
