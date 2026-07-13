import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntime } from './helpers/runtime.mjs';

test('cashflows tellen niet als dagwinst of rendement', () => {
  const rt = createRuntime(['js/data.js']);
  const result = rt.evaluate(`(() => {
    const prices = new Array(HISTORY_DAYS).fill(100);
    registerAsset({ id: 'TEST', name: 'Test', type: 'ETF' }, prices, new Array(HISTORY_DAYS).fill(true));
    const txs = [{ id: 't1', date: MARKET.dates[HISTORY_DAYS - 1].toISOString(), type: 'buy', asset: 'TEST', qty: 1, price: 100 }];
    const values = computePortfolioSeries(txs).values;
    const flat = { adjusted: cashflowAdjustedReturns(txs, values).returns.at(-1), ...dailyPortfolioPnl(txs, values) };
    MARKET.prices.TEST[HISTORY_DAYS - 1] = 110;
    const risen = computePortfolioSeries(txs).values;
    return { flat, up: { adjusted: cashflowAdjustedReturns(txs, risen).returns.at(-1), ...dailyPortfolioPnl(txs, risen) } };
  })()`);
  assert.equal(result.flat.adjusted, 0);
  assert.equal(result.flat.pnl, 0);
  assert.ok(Math.abs(result.up.adjusted - 0.1) < 1e-12);
  assert.equal(result.up.pnl, 10);
});

test('model-arena gebruikt meerdere deterministische walk-forward-folds', () => {
  const rt = createRuntime(['js/data.js', 'js/ml.js', 'js/quant.js']);
  const arena = rt.evaluate(`(() => {
    const prices = Array.from({ length: 500 }, (_, i) => 100 * Math.exp(0.0003 * i + 0.015 * Math.sin(i / 11)));
    return modelArena(prices);
  })()`);
  assert.equal(arena.folds, 4);
  assert.ok(arena.testDays >= 100);
  assert.equal(arena.results.length, 3);
  assert.ok(arena.results.every(row => Number.isFinite(row.hit) && Number.isFinite(row.mae)));
});

test('DCA-signaal kijkt niet voorbij het historische inlegmoment', () => {
  const rt = createRuntime(['js/data.js', 'js/ml.js', 'js/dca.js']);
  const values = rt.evaluate(`(() => {
    const base = new Array(HISTORY_DAYS).fill(100);
    for (let i = 0; i <= 25; i++) base[i] = 100 + i;
    registerAsset({ id: 'DCA', name: 'DCA', type: 'ETF' }, base, new Array(HISTORY_DAYS).fill(true));
    const before = dcaAiMultiplier('DCA', 25);
    for (let i = 26; i < HISTORY_DAYS; i++) MARKET.prices.DCA[i] = i % 2 ? 1 : 10000;
    return [before, dcaAiMultiplier('DCA', 25)];
  })()`);
  assert.equal(values[0], values[1]);
});
