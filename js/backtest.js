/* ============================================================
   backtest.js — toetst AI-strategieën op historische data

   Drie strategieën naast kopen-en-vasthouden, zonder look-ahead
   (signaal van gisteren bepaalt positie van vandaag), met 0,15%
   transactiekosten per positiewissel:

   1. Klassiek   — long zodra ensemble-score > drempel, anders cash.
                   Eenvoudig, maar wisselt vaak → kosten + whipsaw.
   2. Hysterese  — instappen boven (drempel + 0,10), pas uitstappen
                   onder (drempel − 0,10). De "dode zone" voorkomt
                   heen-en-weer springen rond de drempel.
   3. Trend + vol-target — alleen long als SMA50 > SMA200 (trendfilter)
                   en de positiegrootte schaalt omgekeerd met de
                   recente volatiliteit (doel: 20% jaarvol). Minder
                   diepe drawdowns, rustiger ritme.
   ============================================================ */

const BT_COST = 0.0015; // 0,15% per (gedeeltelijke) positiewissel

function realizedVol20(prices, i) {
  // geannualiseerde vol over de laatste 20 dagen vóór i
  let sum = 0, sum2 = 0, n = 0;
  for (let k = Math.max(1, i - 19); k <= i; k++) {
    const r = Math.log(prices[k] / prices[k - 1]);
    sum += r; sum2 += r * r; n++;
  }
  if (n < 5) return 0.3;
  const mean = sum / n;
  return Math.sqrt(Math.max(0, sum2 / n - mean * mean) * CALENDAR_DAYS_PER_YEAR);
}

/**
 * Draait alle strategieën over de laatste `days` dagen.
 * Retourneert { dates, buyhold, strategies:[{id,name,color,curve,trades,metrics}] }.
 */
function computeBacktest(assetId, { days = 730, threshold = 0.05 } = {}) {
  const all = MARKET.prices[assetId];
  days = Math.min(days, all.length);
  const scores = dailySignalScores(all);
  const s50 = sma(all, 50), s200 = sma(all, 200);
  const start = all.length - days;
  const prices = all.slice(start);
  const dates = MARKET.dates.slice(start);

  const buyhold = prices.map(p => 100 * (p / prices[0]));

  // gewenste weging per strategie op dag i (op basis van dag i-1)
  const stratDefs = [
    {
      id: 'klassiek', name: 'Klassiek', color: '#7c6bff',
      weight: (i, prev) => (scores[start + i - 1] > threshold ? 1 : 0),
    },
    {
      id: 'hysterese', name: 'Hysterese', color: '#22d3ee',
      weight: (i, prev) => {
        const sc = scores[start + i - 1];
        if (prev === 0 && sc > threshold + 0.10) return 1;
        if (prev === 1 && sc < threshold - 0.10) return 0;
        return prev;
      },
    },
    {
      id: 'voltarget', name: 'Trend + vol-target', color: '#34d399',
      weight: (i) => {
        const gi = start + i - 1;
        if (!s50[gi] || !s200[gi] || s50[gi] <= s200[gi]) return 0;
        const rv = realizedVol20(all, gi);
        // doelvol 20%; afronden op stappen van 0,25 om micro-trades te vermijden
        const w = Math.min(1, 0.20 / Math.max(rv, 0.05));
        return Math.round(w * 4) / 4;
      },
    },
  ];

  const strategies = stratDefs.map(def => {
    const curve = new Array(days);
    const trades = [];
    let eq = 100, w = 0;
    curve[0] = 100;
    for (let i = 1; i < days; i++) {
      const target = def.weight(i, w);
      if (target !== w) {
        eq *= 1 - BT_COST * Math.abs(target - w);
        trades.push({ idx: i, type: target > w ? 'buy' : 'sell' });
        w = target;
      }
      eq *= 1 + w * (prices[i] / prices[i - 1] - 1);
      curve[i] = eq;
    }

    // round-trip win-rate (volledige uit-en-thuis cycli)
    let wins = 0, roundTrips = 0, entryEq = null;
    for (const t of trades) {
      if (t.type === 'buy' && entryEq === null) entryEq = curve[t.idx];
      else if (t.type === 'sell' && entryEq !== null && curve[t.idx] !== undefined) {
        roundTrips++;
        if (curve[t.idx] > entryEq) wins++;
        entryEq = null;
      }
    }
    if (entryEq !== null) { roundTrips++; if (curve[days - 1] > entryEq) wins++; }

    // gemiddelde blootstelling
    let expo = 0, w2 = 0;
    for (let i = 1; i < days; i++) { w2 = def.weight(i, w2); expo += w2; }

    return {
      ...def, curve, trades,
      metrics: {
        ret: curve[days - 1] - 100,
        dd: maxDrawdown(curve) * 100,
        trades: trades.length,
        winRate: roundTrips ? (wins / roundTrips) * 100 : null,
        exposure: (expo / (days - 1)) * 100,
        sharpe: sharpeRatio(curve),
      },
    };
  });

  return {
    dates, buyhold, strategies, threshold,
    bhMetrics: { ret: buyhold[days - 1] - 100, dd: maxDrawdown(buyhold) * 100, sharpe: sharpeRatio(buyhold) },
  };
}

/** Speelt de backtest dag-voor-dag af op een canvas. */
function playBacktest(canvas, bt, { speed = 4, onDone } = {}) {
  let upto = 2, cancelled = false;
  const n = bt.buyhold.length;
  function frame() {
    if (cancelled) return;
    upto = Math.min(n, upto + speed);
    drawBacktestChart(canvas, bt, upto);
    if (upto < n) requestAnimationFrame(frame);
    else if (onDone) onDone();
  }
  requestAnimationFrame(frame);
  return { cancel() { cancelled = true; } };
}

/* ============================================================
   Auto-tune: walk-forward drempeloptimalisatie
   Zoekt de beste signaaldrempel op de eerste 70% van de data
   (in-sample) en toont wat die keuze daarna waard was op de
   laatste 30% (out-of-sample) — de enige eerlijke maatstaf.
   ============================================================ */
function autoTuneBacktest(assetId, { days = 730 } = {}) {
  const all = MARKET.prices[assetId];
  days = Math.min(days, all.length);
  const scores = dailySignalScores(all);
  const start = all.length - days;
  const prices = all.slice(start);
  const isEnd = Math.floor(days * 0.7);

  // simuleert één variant over [i0, i1); retourneert rendement in %
  function run(thr, i0, i1, hyst) {
    let eq = 100, w = 0;
    for (let i = i0 + 1; i < i1; i++) {
      const sc = scores[start + i - 1];
      let target;
      if (hyst) target = w === 0 ? (sc > thr + 0.10 ? 1 : 0) : (sc < thr - 0.10 ? 0 : 1);
      else target = sc > thr ? 1 : 0;
      if (target !== w) { eq *= 1 - BT_COST * Math.abs(target - w); w = target; }
      eq *= 1 + w * (prices[i] / prices[i - 1] - 1);
    }
    return eq - 100;
  }

  const results = [];
  for (const hyst of [false, true]) {
    let best = null;
    for (let thr = -0.15; thr <= 0.301; thr += 0.025) {
      const isRet = run(thr, 0, isEnd, hyst);
      if (!best || isRet > best.isRet) best = { thr: Math.round(thr * 1000) / 1000, isRet };
    }
    best.oosRet = run(best.thr, isEnd, days, hyst);
    best.name = hyst ? 'Hysterese' : 'Klassiek';
    results.push(best);
  }

  const bhIS = (prices[isEnd - 1] / prices[0] - 1) * 100;
  const bhOOS = (prices[days - 1] / prices[isEnd] - 1) * 100;
  const isDays = isEnd, oosDays = days - isEnd;
  return { results, bhIS, bhOOS, isDays, oosDays };
}
