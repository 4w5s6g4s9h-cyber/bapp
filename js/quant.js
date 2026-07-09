/* ============================================================
   quant.js — kwantitatieve analyse
   - Efficient frontier (Markowitz) met herbalanceringsadvies
   - Stress-test scenario's
   - Correlatiematrix
   - Benchmark-vergelijking (zelfde cashflows in VWRL)
   ============================================================ */

// ---------- rendementenmatrix & statistiek ----------
function returnsMatrix(ids, days = 504) {
  return ids.map(id => {
    const p = MARKET.prices[id].slice(-(days + 1));
    const r = new Array(p.length - 1);
    for (let i = 1; i < p.length; i++) r[i - 1] = Math.log(p[i] / p[i - 1]);
    return r;
  });
}

function meanOf(a) { return a.reduce((s, v) => s + v, 0) / a.length; }

function covariance(a, b, ma, mb) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - ma) * (b[i] - mb);
  return s / a.length;
}

function correlationMatrix(ids, days = 504) {
  const R = returnsMatrix(ids, days);
  const means = R.map(meanOf);
  const n = ids.length;
  const cov = Array.from({ length: n }, () => new Array(n));
  for (let i = 0; i < n; i++)
    for (let j = i; j < n; j++) {
      cov[i][j] = cov[j][i] = covariance(R[i], R[j], means[i], means[j]);
    }
  const corr = Array.from({ length: n }, () => new Array(n));
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      corr[i][j] = cov[i][j] / (Math.sqrt(cov[i][i] * cov[j][j]) || 1e-12);
    }
  return corr;
}

// ---------- Efficient frontier ----------
/**
 * Sampelt nSamples willekeurige portefeuilles (Dirichlet-gewichten) en
 * berekent (σ, μ, Sharpe). Retourneert puntenwolk, frontier-envelop,
 * huidige portefeuille en max-Sharpe punt (elk met weights).
 */
function efficientFrontier(positions, nSamples = 3500) {
  const ids = positions.map(p => p.asset.id);
  const total = positions.reduce((s, p) => s + p.value, 0);
  const curW = positions.map(p => p.value / total);

  const R = returnsMatrix(ids);
  const means = R.map(meanOf);
  const mu = means.map(m => m * 252);
  const n = ids.length;
  const cov = Array.from({ length: n }, () => new Array(n));
  for (let i = 0; i < n; i++)
    for (let j = i; j < n; j++) {
      cov[i][j] = cov[j][i] = covariance(R[i], R[j], means[i], means[j]) * 252;
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
  for (let k = 0; k < nSamples; k++) {
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
  return { ids, points, frontier, current, maxSharpe, total, mu, positions };
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

function applyStress(positions, scenario) {
  const rows = positions.map(p => {
    const shock = scenario.shocks[p.asset.type] ?? -0.25;
    return { asset: p.asset, before: p.value, loss: p.value * shock, after: p.value * (1 + shock), shock };
  });
  const before = rows.reduce((s, r) => s + r.before, 0);
  const after = rows.reduce((s, r) => s + r.after, 0);
  const lossPct = (after / before - 1) * 100;
  // hersteltijd bij 6%/jaar
  const years = Math.log(before / after) / Math.log(1.06);
  return { rows, before, after, lossPct, recoveryYears: Math.max(0, years) };
}

// ---------- Benchmark: zelfde cashflows in één ETF ----------
function benchmarkSeries(txs, benchId = 'VWCE') {
  const bench = MARKET.prices[benchId];
  if (!bench) return null;
  const flows = txs
    .map(tx => ({ idx: dateToIndex(tx.date), cash: (tx.type === 'buy' ? 1 : -1) * tx.qty * tx.price }))
    .sort((a, b) => a.idx - b.idx);
  const values = new Array(HISTORY_DAYS).fill(null);
  let units = 0, f = 0, started = false;
  for (let i = 0; i < HISTORY_DAYS; i++) {
    while (f < flows.length && flows[f].idx <= i) {
      units = Math.max(0, units + flows[f].cash / bench[i]);
      started = true; f++;
    }
    if (started) values[i] = units * bench[i];
  }
  return values;
}

// ---------- Tijdgewogen rendement (TWR) ----------
/**
 * TWR corrigeert voor stortingen en opnames: elke dag wordt het rendement
 * berekend t.o.v. de waarde ná de cashflow van die dag, en die dagrendementen
 * worden meetkundig geschakeld. Zo tellen je eigen inleg-momenten niet mee
 * als "rendement" (in tegenstelling tot winst t.o.v. netto-inleg).
 * Retourneert een cumulatieve reeks (fractie, 0 = startpunt) op het datumgrid.
 */
function twrSeries(txs, values) {
  const flows = new Array(HISTORY_DAYS).fill(0);
  for (const tx of txs) {
    flows[dateToIndex(tx.date)] += (tx.type === 'buy' ? 1 : -1) * tx.qty * tx.price;
  }
  const series = new Array(HISTORY_DAYS).fill(null);
  let cum = 1, started = false;
  for (let i = 1; i < HISTORY_DAYS; i++) {
    const v0 = values[i - 1], v1 = values[i];
    if (!started) {
      if (v0 > 0) { started = true; series[i - 1] = 0; }
      else continue;
    }
    // flow aan het begin van dag i: koop verhoogt de basis vóór het dagrendement
    const base = v0 + flows[i];
    if (base > 1e-9) cum *= v1 / base;
    series[i] = cum - 1;
  }
  return series;
}

/** TWR tussen twee gridindices (fractie). */
function twrBetween(series, i0, i1) {
  const a = series[i0], b = series[i1];
  if (a === null || b === null) return null;
  return (1 + b) / (1 + a) - 1;
}

/** TWR per kalenderjaar binnen het datavenster. */
function twrPerYear(series) {
  const out = [];
  let year = null, startIdx = null;
  for (let i = 0; i < HISTORY_DAYS; i++) {
    if (series[i] === null) continue;
    const y = MARKET.dates[i].getFullYear();
    if (y !== year) {
      if (year !== null) out.push({ year, pct: twrBetween(series, startIdx, i - 1) * 100, partial: startIdx > 0 && out.length === 0 });
      year = y; startIdx = i;
    }
  }
  if (year !== null) out.push({ year, pct: twrBetween(series, startIdx, HISTORY_DAYS - 1) * 100, partial: out.length === 0 && startIdx > 0 });
  return out.filter(r => r.pct !== null);
}
