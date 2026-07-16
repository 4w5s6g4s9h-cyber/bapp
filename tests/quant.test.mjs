import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntime } from './helpers/runtime.mjs';

test('gezamenlijke koerssample sluit doorgetrokken beursweekenden uit', () => {
  const rt = createRuntime(['js/data.js', 'js/quant.js']);
  const result = rt.evaluate(`(() => {
    const stock = new Array(HISTORY_DAYS).fill(100);
    const crypto = new Array(HISTORY_DAYS).fill(100);
    const stockQuality = new Array(HISTORY_DAYS).fill(PRICE_QUALITY.RECONSTRUCTED);
    const cryptoQuality = new Array(HISTORY_DAYS).fill(PRICE_QUALITY.RECONSTRUCTED);
    let stockLog = Math.log(100), cryptoObservedLog = Math.log(100), k = 0;
    const start = HISTORY_DAYS - 141;
    for (let i = start; i < HISTORY_DAYS; i++) {
      const weekday = MARKET.dates[i].getDay();
      const tradingDay = weekday !== 0 && weekday !== 6;
      if (tradingDay) {
        const stockReturn = 0.006 * Math.sin(k / 3) + 0.003 * Math.cos(k / 7);
        const cryptoReturn = -0.85 * stockReturn + 0.0015 * Math.sin(k / 5);
        stockLog += stockReturn;
        cryptoObservedLog += cryptoReturn;
        stock[i] = Math.exp(stockLog);
        crypto[i] = Math.exp(cryptoObservedLog);
        stockQuality[i] = PRICE_QUALITY.OBSERVED;
        cryptoQuality[i] = PRICE_QUALITY.OBSERVED;
        k++;
      } else {
        stock[i] = i > 0 ? stock[i - 1] : 100;
        crypto[i] = Math.exp(cryptoObservedLog + (weekday === 6 ? 0.08 : -0.06));
        stockQuality[i] = PRICE_QUALITY.CARRIED;
        cryptoQuality[i] = PRICE_QUALITY.OBSERVED;
      }
    }
    registerAsset({ id: 'STK', name: 'Stock', type: 'Aandeel' }, stock, null, stockQuality);
    registerAsset({ id: 'CRY', name: 'Crypto', type: 'Crypto' }, crypto, null, cryptoQuality);
    const sample = jointObservedReturnSample(['STK', 'CRY'], 140);
    const analysis = correlationAnalysis(['STK', 'CRY'], 140);
    const allObserved = sample.observationIndices.every(index =>
      isObservedPrice('STK', index) && isObservedPrice('CRY', index));
    const hasWeekendGap = sample.intervalDays.some(days => days > 1);
    return {
      sampleCount: sample.sampleCount,
      periodsPerYear: sample.periodsPerYear,
      allObserved,
      hasWeekendGap,
      available: analysis.available,
      correlation: analysis.matrix[0]?.[1],
    };
  })()`);
  assert.ok(result.sampleCount >= 90);
  assert.ok(result.periodsPerYear > 240 && result.periodsPerYear < 275);
  assert.equal(result.allObserved, true);
  assert.equal(result.hasWeekendGap, true);
  assert.equal(result.available, true);
  assert.ok(result.correlation < -0.9);
});

test('frontier blokkeert een te kleine gezamenlijke steekproef en gebruikt daarna marktfrequentie', () => {
  const rt = createRuntime(['js/data.js', 'js/quant.js']);
  const result = rt.evaluate(`(() => {
    const pa = Array.from({ length: HISTORY_DAYS }, (_, i) => 100 * Math.exp(0.0003 * i + 0.01 * Math.sin(i / 9)));
    const pb = Array.from({ length: HISTORY_DAYS }, (_, i) => 80 * Math.exp(0.0002 * i - 0.008 * Math.sin(i / 11)));
    const qa = new Array(HISTORY_DAYS).fill(PRICE_QUALITY.RECONSTRUCTED);
    const qb = new Array(HISTORY_DAYS).fill(PRICE_QUALITY.RECONSTRUCTED);
    for (let i = HISTORY_DAYS - 50; i < HISTORY_DAYS; i++) qa[i] = qb[i] = PRICE_QUALITY.OBSERVED;
    registerAsset({ id: 'AAA', name: 'A', type: 'ETF' }, pa, null, qa);
    registerAsset({ id: 'BBB', name: 'B', type: 'ETF' }, pb, null, qb);
    const positions = [
      { asset: assetById('AAA'), value: 600, price: pa.at(-1) },
      { asset: assetById('BBB'), value: 400, price: pb.at(-1) },
    ];
    const blocked = efficientFrontier(positions, 100);
    for (let i = HISTORY_DAYS - 100; i < HISTORY_DAYS; i++) qa[i] = qb[i] = PRICE_QUALITY.OBSERVED;
    MARKET.quality.AAA = qa;
    MARKET.quality.BBB = qb;
    const available = efficientFrontier(positions, 120);
    return {
      blocked: blocked.available,
      blockedSamples: blocked.sampling.sampleCount,
      available: available.available,
      availableSamples: available.sampling.sampleCount,
      pointCount: available.points?.length,
      annualization: available.sampling.periodsPerYear,
    };
  })()`);
  assert.equal(result.blocked, false);
  assert.equal(result.blockedSamples, 49);
  assert.equal(result.available, true);
  assert.equal(result.availableSamples, 99);
  assert.equal(result.pointCount, 120);
  assert.ok(Math.abs(result.annualization - 365) < 1e-9);
});

test('wegingen en stress-test nemen cash mee in dezelfde totaalnoemer', () => {
  const rt = createRuntime(['js/data.js', 'js/quant.js']);
  const result = rt.evaluate(`(() => {
    const asset = { id: 'ONE', name: 'One', type: 'ETF' };
    const positions = [{ asset, value: 600, price: 100 }];
    const allocation = portfolioAllocation(positions, 400);
    const stress = applyStress(positions, { shocks: { ETF: -0.5 } }, 400);
    return {
      assetWeight: allocation.weights[0].weight,
      cashWeight: allocation.cashWeight,
      weightSum: allocation.concentrationWeights.reduce((sum, value) => sum + value, 0),
      before: stress.before,
      after: stress.after,
      lossPct: stress.lossPct,
    };
  })()`);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    assetWeight: 0.6,
    cashWeight: 0.4,
    weightSum: 1,
    before: 1000,
    after: 700,
    lossPct: -30.000000000000004,
  });
});

test('alertweging gebruikt totale portefeuille inclusief cash', () => {
  const rt = createRuntime(['js/data.js', 'js/ml.js', 'js/alerts.js']);
  const result = rt.evaluate(`(() => {
    const prices = new Array(HISTORY_DAYS).fill(100);
    registerAsset({ id: 'ALR', name: 'Alert', type: 'ETF' }, prices, new Array(HISTORY_DAYS).fill(true));
    const date = MARKET.dates.at(-1).toISOString();
    const txs = [
      { id: 'd', date, type: 'deposit', amount: 1000 },
      { id: 'b', date, type: 'buy', asset: 'ALR', qty: 6, price: 100 },
    ];
    const portfolio = computePortfolioSeries(txs);
    localStorage.setItem(ALERT_KEY, JSON.stringify([{
      id: 'weight', asset: 'ALR', metric: 'weight', op: '>', threshold: 50, triggered: false,
    }]));
    const checked = checkAlerts(txs, portfolio);
    return { value: checked.alerts[0].value, triggered: checked.alerts[0].triggered };
  })()`);
  assert.equal(result.value, 60);
  assert.equal(result.triggered, true);
});

test('afgeleide portefeuillefuncties hergebruiken één expliciete ledger', () => {
  const rt = createRuntime(['js/data.js', 'js/quant.js']);
  const result = rt.evaluate(`(() => {
    const prices = new Array(HISTORY_DAYS).fill(100);
    registerAsset({ id: 'LED', name: 'Ledger', type: 'ETF' }, prices, new Array(HISTORY_DAYS).fill(true));
    const date = MARKET.dates.at(-1).toISOString();
    const txs = [
      { id: 'd', date, type: 'deposit', amount: 1000 },
      { id: 'b', date, type: 'buy', asset: 'LED', qty: 5, price: 100 },
    ];
    const original = buildPortfolioLedger;
    let builds = 0;
    buildPortfolioLedger = (...args) => { builds++; return original(...args); };
    const portfolio = computePortfolioSeries(txs);
    const positions = computePositions(txs, portfolio.ledger);
    const invested = totalInvested(txs, portfolio.ledger);
    const pnl = dailyPortfolioPnl(txs, portfolio.values, HISTORY_DAYS - 1, portfolio.ledger);
    const twr = twrSeries(txs, portfolio.values, portfolio.ledger);
    const reconciliation = reconcilePortfolio(txs, { assets: { LED: 5 }, cash: 500 }, portfolio.ledger);
    return { builds, positions: positions.length, invested, pnl: pnl.pnl, twr: twr.at(-1), reconciled: reconciliation.balanced };
  })()`);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    builds: 1,
    positions: 1,
    invested: 1000,
    pnl: 0,
    twr: 0,
    reconciled: true,
  });
});
