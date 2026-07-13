/* ============================================================
   ml.js — machine learning in de browser
   - Feedforward neuraal netwerk (tanh) met backpropagation
   - Koersvoorspelling met onzekerheidsband
   - Technische indicatoren (RSI, MACD, SMA)
   - Ensemble-signaal (koop/houd/verkoop)
   - Monte Carlo vermogensprojectie
   ============================================================ */

// ---------- Neuraal netwerk ----------
class NeuralNet {
  constructor(sizes, rng = Math.random) {
    this.sizes = sizes;
    this.weights = []; // [layer][out][in]
    this.biases = [];  // [layer][out]
    for (let l = 0; l < sizes.length - 1; l++) {
      const nIn = sizes[l], nOut = sizes[l + 1];
      const scale = Math.sqrt(2 / nIn); // He-achtige init
      const W = [], B = [];
      for (let o = 0; o < nOut; o++) {
        const row = [];
        for (let i = 0; i < nIn; i++) row.push((rng() * 2 - 1) * scale);
        W.push(row); B.push(0);
      }
      this.weights.push(W); this.biases.push(B);
    }
  }

  // forward pass; bewaart activaties voor backprop
  forward(x) {
    const acts = [x];
    let a = x;
    const L = this.weights.length;
    for (let l = 0; l < L; l++) {
      const W = this.weights[l], B = this.biases[l];
      const out = new Array(W.length);
      for (let o = 0; o < W.length; o++) {
        let z = B[o];
        const row = W[o];
        for (let i = 0; i < row.length; i++) z += row[i] * a[i];
        out[o] = (l === L - 1) ? z : Math.tanh(z); // lineaire output
      }
      acts.push(out); a = out;
    }
    return acts;
  }

  predict(x) {
    const acts = this.forward(x);
    return acts[acts.length - 1][0];
  }

  // één SGD-stap op één sample; retourneert squared error
  trainSample(x, y, lr) {
    const acts = this.forward(x);
    const L = this.weights.length;
    const out = acts[L][0];
    const err = out - y;

    // delta's per laag (achterstevoren)
    let delta = [err]; // output is lineair -> delta = err
    for (let l = L - 1; l >= 0; l--) {
      const W = this.weights[l], B = this.biases[l];
      const aPrev = acts[l];
      // delta voor vorige laag berekenen vóór gewichten updaten
      let prevDelta = null;
      if (l > 0) {
        prevDelta = new Array(aPrev.length).fill(0);
        for (let o = 0; o < W.length; o++) {
          const d = delta[o];
          const row = W[o];
          for (let i = 0; i < row.length; i++) prevDelta[i] += row[i] * d;
        }
        for (let i = 0; i < aPrev.length; i++) {
          const a = aPrev[i];
          prevDelta[i] *= (1 - a * a); // tanh'
        }
      }
      // update
      for (let o = 0; o < W.length; o++) {
        const d = delta[o];
        const row = W[o];
        for (let i = 0; i < row.length; i++) row[i] -= lr * d * aPrev[i];
        B[o] -= lr * d;
      }
      if (prevDelta) delta = prevDelta;
    }
    return err * err;
  }
}

// ---------- Dataset uit koersen ----------
function buildDataset(prices, window = 20) {
  const rets = [];
  for (let i = 1; i < prices.length; i++) rets.push(Math.log(prices[i] / prices[i - 1]));
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const std = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length) || 1e-8;
  const norm = rets.map(r => (r - mean) / std);

  const X = [], Y = [];
  for (let i = window; i < norm.length; i++) {
    X.push(norm.slice(i - window, i));
    Y.push(norm[i]);
  }
  return { X, Y, mean, std, window, lastWindow: norm.slice(norm.length - window) };
}

/**
 * Traint een netwerk asynchroon (in chunks, zodat de UI live meebeweegt).
 * onProgress(epoch, loss, net) wordt na elke epoch aangeroepen.
 * Retourneert een handle met cancel().
 */
function trainNetworkAsync(prices, { epochs = 150, lr = 0.012, hidden = [24, 12], window = 20, seed = 42, onProgress, onDone }) {
  const ds = buildDataset(prices, window);
  const rng = mulberry32(seed);
  const net = new NeuralNet([window, ...hidden, 1], rng);
  const n = ds.X.length;
  const order = Array.from({ length: n }, (_, i) => i);

  let epoch = 0, cancelled = false;
  const losses = [];

  function shuffle() {
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
  }

  function step() {
    if (cancelled) return;
    const t0 = performance.now();
    // zoveel epochs als in ~14ms past (blijft vloeiend op 60fps)
    while (epoch < epochs && performance.now() - t0 < 14) {
      shuffle();
      let sum = 0;
      const decayLr = lr * (1 - 0.6 * epoch / epochs);
      for (let k = 0; k < n; k++) sum += net.trainSample(ds.X[order[k]], ds.Y[order[k]], decayLr);
      losses.push(sum / n);
      epoch++;
    }
    if (onProgress) onProgress(epoch, losses, net);
    if (epoch < epochs) {
      requestAnimationFrame(step);
    } else {
      // residu-std voor de onzekerheidsband
      let se = 0;
      for (let k = 0; k < n; k++) { const e = net.predict(ds.X[k]) - ds.Y[k]; se += e * e; }
      const residStd = Math.sqrt(se / n);
      if (onDone) onDone({ net, ds, losses, residStd, samples: n });
    }
  }
  requestAnimationFrame(step);
  return { cancel() { cancelled = true; } };
}

/**
 * Recursieve voorspelling: horizon dagen vooruit vanaf de laatste koers.
 * Retourneert {median, upper, lower} als prijsreeksen.
 */
function forecastPrices(model, lastClose, horizon = 30) {
  const { net, ds, residStd } = model;
  const win = [...ds.lastWindow];
  const median = [], upper = [], lower = [];
  let logP = Math.log(lastClose);
  let cumVar = 0;

  for (let h = 0; h < horizon; h++) {
    let predNorm = net.predict(win);
    // demp extreme voorspellingen (recursieve drift-explosie voorkomen)
    predNorm = Math.max(-1.5, Math.min(1.5, predNorm)) * 0.6;
    const ret = predNorm * ds.std + ds.mean;
    logP += ret;
    cumVar += (residStd * ds.std) ** 2;
    // Indicatieve residuband. Dit is geen gekalibreerd betrouwbaarheidsinterval:
    // model- en regimesonzekerheid zitten niet in deze eenvoudige band.
    const band = 1.28 * Math.sqrt(cumVar);
    median.push(Math.exp(logP));
    upper.push(Math.exp(logP + band));
    lower.push(Math.exp(logP - band));
    win.shift(); win.push(predNorm);
  }
  return { median, upper, lower };
}

// ---------- Technische indicatoren ----------
function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev = values[0];
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i < values.length; i++) {
    const ch = values[i] - values[i - 1];
    const gain = Math.max(ch, 0), loss = Math.max(-ch, 0);
    if (i <= period) {
      avgGain += gain / period; avgLoss += loss / period;
      if (i === period) out[i] = 100 - 100 / (1 + (avgLoss === 0 ? 100 : avgGain / avgLoss));
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      out[i] = 100 - 100 / (1 + (avgLoss === 0 ? 100 : avgGain / avgLoss));
    }
  }
  return out;
}

function macd(values, fast = 12, slow = 26, signalP = 9) {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const macdLine = values.map((_, i) => emaFast[i] - emaSlow[i]);
  const signal = ema(macdLine, signalP);
  const hist = macdLine.map((m, i) => m - signal[i]);
  return { macdLine, signal, hist };
}

function annualizedVol(prices, days = CALENDAR_DAYS_PER_YEAR) {
  const slice = prices.slice(-days - 1);
  const rets = [];
  for (let i = 1; i < slice.length; i++) rets.push(Math.log(slice[i] / slice[i - 1]));
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const varr = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length;
  return Math.sqrt(varr * CALENDAR_DAYS_PER_YEAR);
}

function annualizedReturn(prices, days = CALENDAR_DAYS_PER_YEAR) {
  const slice = prices.slice(-days - 1);
  return Math.pow(slice[slice.length - 1] / slice[0], CALENDAR_DAYS_PER_YEAR / (slice.length - 1)) - 1;
}

function maxDrawdown(values) {
  let peak = -Infinity, mdd = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    if (peak > 0) mdd = Math.max(mdd, 1 - v / peak);
  }
  return mdd;
}

function sharpeRatio(values, rf = 0.02) {
  const rets = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1] > 0) rets.push(values[i] / values[i - 1] - 1);
  }
  return sharpeFromReturns(rets, rf);
}

/** Sharpe op reeds cashflow-gecorrigeerde kalenderdagrendementen. */
function sharpeFromReturns(returns, rf = 0.02) {
  const rets = returns.filter(r => Number.isFinite(r));
  if (rets.length < 2) return 0;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const std = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length) || 1e-9;
  return ((mean * CALENDAR_DAYS_PER_YEAR) - rf) / (std * Math.sqrt(CALENDAR_DAYS_PER_YEAR));
}

// ---------- Ensemble-signaal ----------
/**
 * Combineert momentum (RSI), trend (SMA50 vs SMA200), MACD en
 * eventueel de NN-voorspelling tot één score in [-1, 1].
 */
function computeSignal(prices, nnForecastPct = null) {
  const r = rsi(prices, 14);
  const lastRsi = r[r.length - 1] ?? 50;
  const sma50 = sma(prices, 50), sma200 = sma(prices, 200);
  const s50 = sma50[sma50.length - 1], s200 = sma200[sma200.length - 1];
  const { hist } = macd(prices);
  const lastHist = hist[hist.length - 1] || 0;
  const price = prices[prices.length - 1];

  // componenten in [-1, 1]
  const rsiScore = lastRsi < 30 ? 1 : lastRsi > 70 ? -1 : (50 - lastRsi) / 40;
  const trendScore = s50 && s200 ? Math.max(-1, Math.min(1, (s50 / s200 - 1) * 12)) : 0;
  const macdScore = Math.max(-1, Math.min(1, (lastHist / price) * 150));
  const nnScore = nnForecastPct === null ? 0 : Math.max(-1, Math.min(1, nnForecastPct / 6));

  const hasNN = nnForecastPct !== null;
  const score = hasNN
    ? 0.25 * rsiScore + 0.3 * trendScore + 0.15 * macdScore + 0.3 * nnScore
    : 0.35 * rsiScore + 0.42 * trendScore + 0.23 * macdScore;

  const label = score > 0.18 ? 'Koop' : score < -0.18 ? 'Verkoop' : 'Houd';
  const strength = Math.min(100, Math.round(Math.abs(score) * 100));
  return { score, label, strength, rsi: lastRsi, trendScore };
}

// ---------- Monte Carlo ----------
/**
 * Simuleert vermogensontwikkeling met maandelijkse inleg.
 * Retourneert percentielbanden (p5..p95) per maand + eindwaarden.
 */
function monteCarlo({ startValue, monthly, years, sims, mu, sigma, seed = 1234 }) {
  const rng = mulberry32(seed);
  const gauss = gaussianFactory(rng);
  const months = years * 12;
  const dtMu = mu / 12, dtSig = sigma / Math.sqrt(12);

  const paths = []; // enkel een handvol voor visual
  const monthValues = Array.from({ length: months + 1 }, () => new Array(sims));

  for (let s = 0; s < sims; s++) {
    let v = startValue;
    monthValues[0][s] = v;
    const keep = s < 40; // eerste 40 paden tekenen
    const path = keep ? [v] : null;
    for (let m = 1; m <= months; m++) {
      v = v * Math.exp((dtMu - 0.5 * dtSig * dtSig) + dtSig * gauss()) + monthly;
      monthValues[m][s] = v;
      if (keep) path.push(v);
    }
    if (keep) paths.push(path);
  }

  const pct = (arr, p) => {
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = (sorted.length - 1) * p;
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  };

  const bands = { p5: [], p25: [], p50: [], p75: [], p95: [] };
  for (let m = 0; m <= months; m++) {
    const mv = monthValues[m];
    bands.p5.push(pct(mv, 0.05));
    bands.p25.push(pct(mv, 0.25));
    bands.p50.push(pct(mv, 0.50));
    bands.p75.push(pct(mv, 0.75));
    bands.p95.push(pct(mv, 0.95));
  }
  const totalContrib = startValue + monthly * months;
  return { bands, paths, months, totalContrib };
}

/* ============================================================
   Uitbreidingen: signaal per dag, ridge-regressie, model-arena,
   anomaliedetectie (voor backtest, arena en asset-analyse)
   ============================================================ */

/** Ensemble-score per dag (zelfde formule als computeSignal, technisch deel). */
function dailySignalScores(prices) {
  const r = rsi(prices, 14);
  const s50 = sma(prices, 50), s200 = sma(prices, 200);
  const { hist } = macd(prices);
  const out = new Array(prices.length).fill(0);
  for (let i = 0; i < prices.length; i++) {
    const rsiV = r[i] ?? 50;
    const rsiScore = rsiV < 30 ? 1 : rsiV > 70 ? -1 : (50 - rsiV) / 40;
    const trendScore = (s50[i] && s200[i]) ? Math.max(-1, Math.min(1, (s50[i] / s200[i] - 1) * 12)) : 0;
    const macdScore = Math.max(-1, Math.min(1, ((hist[i] || 0) / prices[i]) * 150));
    out[i] = 0.35 * rsiScore + 0.42 * trendScore + 0.23 * macdScore;
  }
  return out;
}

/** Lost A·x = b op met Gauss-eliminatie (partial pivoting). */
function solveLinearSystem(A, b) {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / d;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / (row[i] || 1e-12));
}

/** Ridge-regressie via normaalvergelijkingen. Retourneert [bias, w1..wn]. */
function ridgeRegression(X, y, lambda = 1.0) {
  const n = X.length, d = X[0].length + 1; // +1 bias
  const A = Array.from({ length: d }, () => new Array(d).fill(0));
  const b = new Array(d).fill(0);
  for (let k = 0; k < n; k++) {
    const row = [1, ...X[k]];
    for (let i = 0; i < d; i++) {
      b[i] += row[i] * y[k];
      for (let j = i; j < d; j++) A[i][j] += row[i] * row[j];
    }
  }
  for (let i = 0; i < d; i++) for (let j = 0; j < i; j++) A[i][j] = A[j][i];
  for (let i = 1; i < d; i++) A[i][i] += lambda; // bias niet regulariseren
  return solveLinearSystem(A, b);
}

/**
 * Model-arena: vier echte expanding-window folds. Elke fold bepaalt
 * normalisatie uitsluitend uit het trainingsvenster, traint opnieuw en
 * evalueert op het chronologisch volgende, onaangeraakte testvenster.
 */
function modelArena(prices, window = 20) {
  const rets = [];
  for (let i = 1; i < prices.length; i++) rets.push(Math.log(prices[i] / prices[i - 1]));
  const sampleCount = rets.length - window;
  if (sampleCount < 100) throw new Error('Minimaal 121 koersdagen nodig voor walk-forward validatie.');
  const foldCount = 4;
  const initialTrainSamples = Math.max(60, Math.floor(sampleCount * 0.6));
  const testSize = Math.max(10, Math.floor((sampleCount - initialTrainSamples) / foldCount));
  const totals = {
    'Neuraal netwerk': { hit: 0, error: 0, count: 0 },
    'Ridge-regressie': { hit: 0, error: 0, count: 0 },
    'Naïef momentum': { hit: 0, error: 0, count: 0 },
  };

  const record = (name, predicted, actual) => {
    const acc = totals[name];
    if (Math.sign(predicted) === Math.sign(actual) && actual !== 0) acc.hit++;
    acc.error += Math.abs(predicted - actual);
    acc.count++;
  };

  for (let fold = 0; fold < foldCount; fold++) {
    const trainEnd = window + initialTrainSamples + fold * testSize;
    const testEnd = fold === foldCount - 1 ? rets.length : Math.min(rets.length, trainEnd + testSize);
    if (testEnd <= trainEnd) continue;

    const trainReturns = rets.slice(0, trainEnd);
    const mean = trainReturns.reduce((sum, value) => sum + value, 0) / trainReturns.length;
    const std = Math.sqrt(trainReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / trainReturns.length) || 1e-8;
    const feature = k => rets.slice(k - window, k).map(r => (r - mean) / std);
    const target = k => (rets[k] - mean) / std;
    const X = [], Y = [];
    for (let k = window; k < trainEnd; k++) { X.push(feature(k)); Y.push(target(k)); }

    const rng = mulberry32(99 + fold);
    const net = new NeuralNet([window, 16, 8, 1], rng);
    const order = Array.from({ length: X.length }, (_, i) => i);
    for (let epoch = 0; epoch < 45; epoch++) {
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      const lr = 0.01 * (1 - 0.5 * epoch / 45);
      for (const k of order) net.trainSample(X[k], Y[k], lr);
    }
    const weights = ridgeRegression(X, Y, 1.0);

    for (let k = trainEnd; k < testEnd; k++) {
      const x = feature(k), actual = rets[k];
      const nnPred = net.predict(x) * std + mean;
      let ridgePredNorm = weights[0];
      for (let i = 0; i < window; i++) ridgePredNorm += weights[i + 1] * x[i];
      record('Neuraal netwerk', nnPred, actual);
      record('Ridge-regressie', ridgePredNorm * std + mean, actual);
      record('Naïef momentum', rets[k - 1], actual);
    }
  }

  const results = Object.entries(totals).map(([name, result]) => ({
    name,
    hit: result.count ? result.hit / result.count * 100 : 0,
    mae: result.count ? result.error / result.count * 100 : 0,
  }));
  const best = [...results].sort((a, b) => b.hit - a.hit)[0];
  return { results, best, testDays: totals['Neuraal netwerk'].count, folds: foldCount };
}

/** Anomaliedetectie: dagen met |z-score| van het rendement > drempel. */
function detectAnomalies(prices, zThreshold = 3) {
  const rets = [];
  for (let i = 1; i < prices.length; i++) rets.push(Math.log(prices[i] / prices[i - 1]));
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const std = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length) || 1e-9;
  const out = [];
  for (let i = 0; i < rets.length; i++) {
    const z = (rets[i] - mean) / std;
    if (Math.abs(z) > zThreshold) out.push({ index: i + 1, z });
  }
  return out;
}
