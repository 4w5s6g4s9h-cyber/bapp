/* ============================================================
   quant.js — kwantitatieve analyse
   - Efficient frontier (Markowitz) met herbalanceringsadvies
   - Stress-test scenario's
   - Correlatiematrix
   - Benchmark-vergelijking (zelfde cashflows in VWRL)
   ============================================================ */

// ---------- rendementenmatrix & statistiek ----------
const MIN_JOINT_RETURN_SAMPLES = 60;

/**
 * Bouwt rendementen uitsluitend tussen datums waarop álle assets een werkelijk
 * waargenomen koers hebben. Zo worden beursweekenden niet als nulrendement voor
 * aandelen naast een echt cryptorendement gezet.
 */
function jointObservedReturnSample(ids, days = 730) {
  const assetIds = Array.isArray(ids) ? ids.map(normalizeAssetId) : [];
  const end = HISTORY_DAYS - 1;
  const requestedDays = Number.isFinite(Number(days)) ? Math.max(1, Math.floor(Number(days))) : 730;
  const start = Math.max(0, end - requestedDays);
  if (!assetIds.length || assetIds.some(id => !id || !MARKET.prices[id])) {
    return {
      ids: assetIds, returns: assetIds.map(() => []), observationIndices: [],
      intervalDays: [], sampleCount: 0, spanDays: 0, periodsPerYear: 0,
      firstDate: null, lastDate: null,
    };
  }

  const observationIndices = [];
  for (let index = start; index <= end; index++) {
    if (assetIds.every(id => isObservedPrice(id, index))) observationIndices.push(index);
  }
  const returns = assetIds.map(() => []);
  const intervalDays = [];
  for (let row = 1; row < observationIndices.length; row++) {
    const from = observationIndices[row - 1], to = observationIndices[row];
    intervalDays.push(to - from);
    for (let asset = 0; asset < assetIds.length; asset++) {
      const prices = MARKET.prices[assetIds[asset]];
      returns[asset].push(Math.log(prices[to] / prices[from]));
    }
  }
  const sampleCount = Math.max(0, observationIndices.length - 1);
  const spanDays = sampleCount ? observationIndices.at(-1) - observationIndices[0] : 0;
  return {
    ids: assetIds, returns, observationIndices, intervalDays, sampleCount, spanDays,
    periodsPerYear: spanDays > 0 ? sampleCount / spanDays * CALENDAR_DAYS_PER_YEAR : 0,
    firstDate: observationIndices.length ? localDateKey(MARKET.dates[observationIndices[0]]) : null,
    lastDate: observationIndices.length ? localDateKey(MARKET.dates[observationIndices.at(-1)]) : null,
  };
}

function returnsMatrix(ids, days = 730) {
  return jointObservedReturnSample(ids, days).returns;
}

function meanOf(a) { return a.reduce((s, v) => s + v, 0) / a.length; }

function covariance(a, b, ma, mb) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - ma) * (b[i] - mb);
  return s / a.length;
}

function correlationAnalysis(ids, days = 730, minSamples = MIN_JOINT_RETURN_SAMPLES) {
  const sampling = jointObservedReturnSample(ids, days);
  const R = sampling.returns;
  const minimum = Number.isFinite(Number(minSamples)) ? Math.max(2, Math.floor(Number(minSamples))) : MIN_JOINT_RETURN_SAMPLES;
  if (sampling.sampleCount < minimum) {
    return { available: false, matrix: [], sampling, reason: `Minimaal ${minimum} gezamenlijke waargenomen rendementsintervallen nodig.` };
  }
  const means = R.map(meanOf);
  const n = sampling.ids.length;
  const cov = Array.from({ length: n }, () => new Array(n));
  for (let i = 0; i < n; i++)
    for (let j = i; j < n; j++) {
      cov[i][j] = cov[j][i] = covariance(R[i], R[j], means[i], means[j]);
    }
  if (cov.some((row, index) => !Number.isFinite(row[index]) || row[index] <= 1e-18)) {
    return { available: false, matrix: [], sampling, reason: 'De gezamenlijke steekproef bevat te weinig koersvariatie voor correlatie.' };
  }
  const corr = Array.from({ length: n }, () => new Array(n));
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      corr[i][j] = i === j ? 1 : cov[i][j] / Math.sqrt(cov[i][i] * cov[j][j]);
    }
  return { available: true, matrix: corr, sampling, reason: '' };
}

function correlationMatrix(ids, days = 730) {
  return correlationAnalysis(ids, days).matrix;
}

// ---------- Efficient frontier ----------
/**
 * Sampelt nSamples willekeurige portefeuilles (Dirichlet-gewichten) en
 * berekent (σ, μ, Sharpe). Retourneert puntenwolk, frontier-envelop,
 * huidige portefeuille en max-Sharpe punt (elk met weights).
 */
function efficientFrontier(positions, nSamples = 3500, days = 730) {
  const portfolioPositions = Array.isArray(positions) ? positions : [];
  const ids = portfolioPositions.map(p => p.asset.id);
  const total = portfolioPositions.reduce((s, p) => s + p.value, 0);
  const sampling = jointObservedReturnSample(ids, days);
  if (portfolioPositions.length < 2 || total <= 0 || sampling.sampleCount < MIN_JOINT_RETURN_SAMPLES) {
    return {
      available: false, ids, positions: portfolioPositions, total, sampling,
      reason: portfolioPositions.length < 2
        ? 'Minimaal 2 posities nodig voor portefeuille-optimalisatie.'
        : total <= 0
          ? 'De belegde waarde moet positief zijn voor portefeuille-optimalisatie.'
          : `Minimaal ${MIN_JOINT_RETURN_SAMPLES} gezamenlijke waargenomen rendementsintervallen nodig.`,
    };
  }
  const curW = portfolioPositions.map(p => p.value / total);

  const R = sampling.returns;
  const means = R.map(meanOf);
  const annualization = sampling.periodsPerYear;
  const mu = means.map(m => m * annualization);
  const n = ids.length;
  const cov = Array.from({ length: n }, () => new Array(n));
  for (let i = 0; i < n; i++)
    for (let j = i; j < n; j++) {
      cov[i][j] = cov[j][i] = covariance(R[i], R[j], means[i], means[j]) * annualization;
    }

  const portStats = (w) => {
    let m = 0, v = 0;
    for (let i = 0; i < n; i++) {
      m += w[i] * mu[i];
      for (let j = 0; j < n; j++) v += w[i] * w[j] * cov[i][j];
    }
    const sig = Math.sqrt(Math.max(v, 1e-12));
    return { mu: m, sig, sharpe: (m - 0.02) / sig };
  };

  const rng = mulberry32(2024);
  const points = [];
  let maxSharpe = null;
  const sampleTarget = Number.isFinite(Number(nSamples)) ? Math.max(1, Math.floor(Number(nSamples))) : 3500;
  for (let k = 0; k < sampleTarget; k++) {
    const w = new Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) { w[i] = -Math.log(rng() || 1e-12); sum += w[i]; }
    for (let i = 0; i < n; i++) w[i] /= sum;
    const st = portStats(w);
    const pt = { ...st, weights: w };
    points.push(pt);
    if (!maxSharpe || st.sharpe > maxSharpe.sharpe) maxSharpe = pt;
  }

  // frontier: per risico-bucket het hoogste rendement
  const sigMin = Math.min(...points.map(p => p.sig));
  const sigMax = Math.max(...points.map(p => p.sig));
  const BINS = 60;
  const best = new Array(BINS).fill(null);
  for (const p of points) {
    const b = Math.min(BINS - 1, Math.floor(((p.sig - sigMin) / (sigMax - sigMin || 1)) * BINS));
    if (!best[b] || p.mu > best[b].mu) best[b] = p;
  }
  // envelop monotoon maken vanaf min-variance punt
  const frontier = [];
  let peak = -Infinity;
  for (const p of best) {
    if (!p) continue;
    if (p.mu > peak) { peak = p.mu; frontier.push(p); }
  }

  const current = { ...portStats(curW), weights: curW };
  return { available: true, ids, points, frontier, current, maxSharpe, total, mu, positions: portfolioPositions, sampling };
}

/** Vertaalt doelgewichten naar concrete koop/verkoop-orders. */
function rebalanceAdvice(ef, target) {
  const rows = [];
  for (let i = 0; i < ef.ids.length; i++) {
    const pos = ef.positions[i];
    const targetVal = target.weights[i] * ef.total;
    const delta = targetVal - pos.value;
    if (Math.abs(delta) < ef.total * 0.01) continue; // < 1% verschil: negeren
    rows.push({
      asset: pos.asset,
      action: delta > 0 ? 'Koop' : 'Verkoop',
      amount: Math.abs(delta),
      qty: Math.abs(delta) / pos.price,
      fromPct: (pos.value / ef.total) * 100,
      toPct: target.weights[i] * 100,
    });
  }
  return rows.sort((a, b) => b.amount - a.amount);
}

// ---------- Stress-test scenario's ----------
const STRESS_SCENARIOS = [
  { id: 'crash2008', icon: '📉', name: 'Crash 2008', desc: 'wereldwijde financiële crisis', shocks: { Aandeel: -0.45, ETF: -0.38, Crypto: -0.60 } },
  { id: 'cryptowinter', icon: '🥶', name: 'Crypto-winter', desc: 'crypto implodeert, aandelen rimpelen mee', shocks: { Aandeel: -0.08, ETF: -0.05, Crypto: -0.75 } },
  { id: 'rente', icon: '🏦', name: 'Rente +2%', desc: 'centrale banken verkrappen hard', shocks: { Aandeel: -0.18, ETF: -0.14, Crypto: -0.25 } },
  { id: 'zwaan', icon: '🦢', name: 'Zwarte zwaan', desc: 'onvoorspelbare systeemschok', shocks: { Aandeel: -0.30, ETF: -0.28, Crypto: -0.45 } },
];

function applyStress(positions, scenario, cash = 0) {
  const rows = (Array.isArray(positions) ? positions : []).map(p => {
    const shock = scenario?.shocks?.[p.asset.type] ?? -0.25;
    return { asset: p.asset, before: p.value, loss: p.value * shock, after: p.value * (1 + shock), shock };
  });
  const cashValue = Number.isFinite(Number(cash)) ? Number(cash) : 0;
  const before = rows.reduce((s, r) => s + r.before, cashValue);
  const after = rows.reduce((s, r) => s + r.after, cashValue);
  const lossPct = before > 0 ? (after / before - 1) * 100 : 0;
  // hersteltijd bij 6%/jaar
  const years = before > 0 && after > 0 ? Math.log(before / after) / Math.log(1.06) : Infinity;
  return { rows, cash: cashValue, before, after, lossPct, recoveryYears: Math.max(0, years) };
}

// ---------- Benchmark: zelfde cashflows in één ETF ----------
function benchmarkSeries(txs, benchId = 'VWCE', ledger = null) {
  const bench = MARKET.prices[benchId];
  if (!bench) return null;
  const flows = computeCashflowSeries(txs, ledger);
  const values = new Array(HISTORY_DAYS).fill(null);
  let units = 0, started = false;
  for (let i = 0; i < HISTORY_DAYS; i++) {
    if (Math.abs(flows[i]) > 1e-12) {
      units = Math.max(0, units + flows[i] / bench[i]);
      if (flows[i] > 0) started = true;
    }
    if (started) values[i] = units * bench[i];
  }
  return values;
}

// ---------- Geldgewogen rendement (XIRR) ----------
function xnpv(rate, cashflows) {
  if (!Number.isFinite(rate) || rate <= -1 || !Array.isArray(cashflows) || cashflows.length < 2) return NaN;
  const ordered = cashflows
    .map(flow => ({ date: new Date(flow.date), amount: Number(flow.amount) }))
    .filter(flow => Number.isFinite(flow.date.getTime()) && Number.isFinite(flow.amount))
    .sort((a, b) => a.date - b.date);
  if (ordered.length < 2) return NaN;
  const t0 = ordered[0].date.getTime();
  return ordered.reduce((sum, flow) => {
    const years = (flow.date.getTime() - t0) / 86400000 / 365;
    return sum + flow.amount / ((1 + rate) ** years);
  }, 0);
}

/**
 * Jaarlijks geldgewogen rendement voor onregelmatige cashflows. De uitkomst
 * is een fractie (0,10 = 10%); null betekent dat geen betrouwbare wortel
 * bestaat, bijvoorbeeld doordat alle cashflows hetzelfde teken hebben.
 */
function xirr(cashflows, guess = 0.1) {
  const byDate = new Map();
  for (const flow of Array.isArray(cashflows) ? cashflows : []) {
    const date = new Date(flow?.date), amount = Number(flow?.amount);
    if (!Number.isFinite(date.getTime()) || !Number.isFinite(amount) || Math.abs(amount) < 1e-12) continue;
    const key = date.toISOString().slice(0, 10);
    byDate.set(key, (byDate.get(key) || 0) + amount);
  }
  const flows = [...byDate.entries()]
    .map(([date, amount]) => ({ date: new Date(`${date}T12:00:00.000Z`), amount }))
    .filter(flow => Math.abs(flow.amount) >= 1e-12)
    .sort((a, b) => a.date - b.date);
  if (flows.length < 2 || !flows.some(flow => flow.amount > 0) || !flows.some(flow => flow.amount < 0)) return null;

  const scale = flows.reduce((sum, flow) => sum + Math.abs(flow.amount), 0);
  const tolerance = Math.max(1e-9, scale * 1e-10);
  const t0 = flows[0].date.getTime();
  const npvAndDerivative = (rate) => {
    if (!Number.isFinite(rate) || rate <= -1) return { value: NaN, derivative: NaN };
    let value = 0, derivative = 0;
    for (const flow of flows) {
      const years = (flow.date.getTime() - t0) / 86400000 / 365;
      value += flow.amount / ((1 + rate) ** years);
      derivative -= years * flow.amount / ((1 + rate) ** (years + 1));
    }
    return { value, derivative };
  };

  let rate = Number.isFinite(guess) && guess > -1 ? guess : 0.1;
  for (let iteration = 0; iteration < 100; iteration++) {
    const { value, derivative } = npvAndDerivative(rate);
    if (Math.abs(value) <= tolerance) return rate;
    if (!Number.isFinite(value) || !Number.isFinite(derivative) || Math.abs(derivative) < 1e-14) break;
    const next = rate - value / derivative;
    if (!Number.isFinite(next) || next <= -0.999999999 || next > 1e9) break;
    if (Math.abs(next - rate) <= 1e-12) return next;
    rate = next;
  }

  const grid = [-0.999999, -0.9999, -0.999, -0.99, -0.9, -0.75, -0.5, -0.25, 0, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 100, 1000, 1e6];
  let previousRate = grid[0], previousValue = npvAndDerivative(previousRate).value;
  for (let i = 1; i < grid.length; i++) {
    let currentRate = grid[i], currentValue = npvAndDerivative(currentRate).value;
    if (Math.abs(currentValue) <= tolerance) return currentRate;
    if (Number.isFinite(previousValue) && Number.isFinite(currentValue) && Math.sign(previousValue) !== Math.sign(currentValue)) {
      let low = previousRate, high = currentRate;
      for (let iteration = 0; iteration < 200; iteration++) {
        const mid = (low + high) / 2;
        const midValue = npvAndDerivative(mid).value;
        if (Math.abs(midValue) <= tolerance || high - low <= 1e-12) return mid;
        if (Math.sign(midValue) === Math.sign(previousValue)) low = mid;
        else high = mid;
      }
      return (low + high) / 2;
    }
    previousRate = currentRate;
    previousValue = currentValue;
  }
  return null;
}

function portfolioXirr(txs, finalValue, valuationDate = MARKET.dates[HISTORY_DAYS - 1]) {
  const end = new Date(valuationDate);
  const value = Number(finalValue);
  if (!Number.isFinite(end.getTime()) || !Number.isFinite(value) || value < 0) return null;
  const flows = externalCashflowEvents(txs)
    .filter(flow => new Date(flow.date) <= end)
    .map(flow => ({ date: flow.date, amount: -flow.amount }));
  if (value > 0) flows.push({ date: end.toISOString(), amount: value });
  return xirr(flows);
}

// ---------- Tijdgewogen rendement (TWR) ----------
/**
 * TWR corrigeert voor stortingen en opnames: elke dag wordt het rendement
 * berekend t.o.v. de waarde ná de cashflow van die dag, en die dagrendementen
 * worden meetkundig geschakeld. Zo tellen je eigen inleg-momenten niet mee
 * als "rendement" (in tegenstelling tot winst t.o.v. netto-inleg).
 * Retourneert een cumulatieve reeks (fractie, 0 = startpunt) op het datumgrid.
 */
function twrSeries(txs, values, ledger = null) {
  const cumulative = cumulativeFromReturns(cashflowAdjustedReturns(txs, values, ledger).returns);
  return cumulative.map(v => v === null ? null : v - 1);
}

/** TWR tussen twee gridindices (fractie). */
function twrBetween(series, i0, i1) {
  const a = series[i0], b = series[i1];
  if (a === null || b === null) return null;
  return (1 + b) / (1 + a) - 1;
}

/** TWR per kalenderjaar binnen het datavenster. */
function twrPerYear(series, fromIndex = 0) {
  const out = [];
  let year = null, startIdx = null;
  for (let i = Math.max(0, fromIndex); i < HISTORY_DAYS; i++) {
    if (series[i] === null) continue;
    const y = MARKET.dates[i].getFullYear();
    if (y !== year) {
      if (year !== null) out.push({ year, pct: twrBetween(series, startIdx, i - 1) * 100, partial: startIdx > fromIndex && out.length === 0 });
      year = y; startIdx = i;
    }
  }
  if (year !== null) out.push({ year, pct: twrBetween(series, startIdx, HISTORY_DAYS - 1) * 100, partial: out.length === 0 && startIdx > fromIndex });
  return out.filter(r => r.pct !== null);
}
