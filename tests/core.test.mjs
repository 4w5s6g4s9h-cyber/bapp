import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntime, MemoryStorage } from './helpers/runtime.mjs';

test('cashflows tellen niet als dagwinst of rendement', () => {
  const rt = createRuntime(['js/data.js']);
  const result = rt.evaluate(`(() => {
    const prices = new Array(HISTORY_DAYS).fill(100);
    registerAsset({ id: 'TEST', name: 'Test', type: 'ETF' }, prices, new Array(HISTORY_DAYS).fill(true));
    const txs = [{ id: 't1', date: MARKET.dates[HISTORY_DAYS - 1].toISOString(), type: 'buy', asset: 'TEST', qty: 1, price: 100, external: true }];
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

test('v3-transacties migreren eenmalig naar schema v4 zonder waarderingsbreuk', () => {
  const storage = new MemoryStorage({
    vermogen_transactions_v3: JSON.stringify([
      { id: 'legacy-buy', date: '2025-01-02T12:00:00.000Z', type: 'buy', asset: 'vwce', qty: 2, price: 100 },
      { id: 'legacy-transfer', date: '2025-02-02T12:00:00.000Z', type: 'buy', asset: 'btc', qty: 0.1, price: 20000, transfer: true },
    ]),
  });
  const rt = createRuntime(['js/data.js'], { storage });
  const result = rt.evaluate(`(() => {
    const txs = loadTransactions();
    return { txs, current: localStorage.getItem(TX_KEY), legacy: localStorage.getItem(LEGACY_TX_KEY) };
  })()`);
  assert.equal(result.txs.length, 2);
  assert.equal(result.txs[0].external, true);
  assert.equal(result.txs[0].currency, 'EUR');
  assert.equal(result.txs[1].type, 'transfer_in');
  assert.equal(result.txs[1].price, 20000);
  assert.equal(result.legacy, null);
  assert.ok(result.current.includes('"external":true'));
});

test('interne herbalancering verandert de externe inleg en totale waarde niet', () => {
  const rt = createRuntime(['js/data.js']);
  const result = rt.evaluate(`(() => {
    registerAsset({ id: 'AAA', name: 'A', type: 'ETF' }, new Array(HISTORY_DAYS).fill(100), new Array(HISTORY_DAYS).fill(true));
    registerAsset({ id: 'BBB', name: 'B', type: 'ETF' }, new Array(HISTORY_DAYS).fill(200), new Array(HISTORY_DAYS).fill(true));
    const d = offset => MARKET.dates[HISTORY_DAYS - 1 - offset].toISOString();
    const txs = [
      { id: '1', date: d(3), type: 'deposit', amount: 1000 },
      { id: '2', date: d(2), type: 'buy', asset: 'AAA', qty: 10, price: 100 },
      { id: '3', date: d(1), type: 'sell', asset: 'AAA', qty: 10, price: 100 },
      { id: '4', date: d(0), type: 'buy', asset: 'BBB', qty: 5, price: 200 },
    ];
    const portfolio = computePortfolioSeries(txs);
    return {
      value: portfolio.values.at(-1), cash: portfolio.cash,
      invested: totalInvested(txs), flows: portfolio.externalFlows.filter(Boolean),
      positions: computePositions(txs).map(p => [p.asset.id, p.qty]), issues: portfolio.ledger.issues,
    };
  })()`);
  assert.equal(result.value, 1000);
  assert.equal(result.cash, 0);
  assert.equal(result.invested, 1000);
  assert.deepEqual(JSON.parse(JSON.stringify(result.flows)), [1000]);
  assert.deepEqual(JSON.parse(JSON.stringify(result.positions)), [['BBB', 5]]);
  assert.equal(result.issues.length, 0);
});

test('kosten, dividend en gemiddelde kostbasis sluiten boekhoudkundig aan', () => {
  const rt = createRuntime(['js/data.js']);
  const result = rt.evaluate(`(() => {
    registerAsset({ id: 'LEDGER', name: 'Ledger', type: 'ETF' }, new Array(HISTORY_DAYS).fill(120), new Array(HISTORY_DAYS).fill(true));
    const d = offset => MARKET.dates[HISTORY_DAYS - 1 - offset].toISOString();
    const txs = [
      { id: '1', date: d(3), type: 'deposit', amount: 1100 },
      { id: '2', date: d(2), type: 'buy', asset: 'LEDGER', qty: 10, price: 100, fee: 10 },
      { id: '3', date: d(1), type: 'dividend', asset: 'LEDGER', amount: 20 },
      { id: '4', date: d(0), type: 'sell', asset: 'LEDGER', qty: 5, price: 120, fee: 5, tax: 5 },
    ];
    const portfolio = computePortfolioSeries(txs);
    const position = computePositions(txs)[0];
    return {
      cash: portfolio.cash, value: portfolio.values.at(-1), invested: totalInvested(txs),
      fees: portfolio.ledger.fees, taxes: portfolio.ledger.taxes, income: portfolio.ledger.income,
      realized: portfolio.ledger.realized, qty: position.qty, cost: position.cost,
      avgPrice: position.avgPrice, unrealized: position.gain,
    };
  })()`);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    cash: 700, value: 1300, invested: 1100,
    fees: 15, taxes: 5, income: 20,
    realized: 85, qty: 5, cost: 505, avgPrice: 101, unrealized: 95,
  });
});

test('splits behouden totale kostbasis en ongeldige verkopen worden fail-closed genegeerd', () => {
  const rt = createRuntime(['js/data.js']);
  const result = rt.evaluate(`(() => {
    registerAsset({ id: 'SPLT', name: 'Split', type: 'Aandeel' }, new Array(HISTORY_DAYS).fill(50), new Array(HISTORY_DAYS).fill(true));
    const d = offset => MARKET.dates[HISTORY_DAYS - 1 - offset].toISOString();
    const txs = [
      { id: '1', date: d(2), type: 'buy', asset: 'SPLT', qty: 10, price: 100, external: true },
      { id: '2', date: d(1), type: 'split', asset: 'SPLT', ratio: 2 },
      { id: '3', date: d(0), type: 'sell', asset: 'SPLT', qty: 21, price: 50, external: true },
    ];
    const portfolio = computePortfolioSeries(txs);
    const position = computePositions(txs)[0];
    return {
      qty: position.qty, cost: position.cost, avgPrice: position.avgPrice,
      value: portfolio.values.at(-1), invested: totalInvested(txs),
      issueCodes: portfolio.ledger.issues.map(issue => issue.code),
    };
  })()`);
  assert.equal(result.qty, 20);
  assert.equal(result.cost, 1000);
  assert.equal(result.avgPrice, 50);
  assert.equal(result.value, 1000);
  assert.equal(result.invested, 1000);
  assert.deepEqual(JSON.parse(JSON.stringify(result.issueCodes)), ['oversell']);
});

test('assettransfers gebruiken afzonderlijke kostbasis en externe waarde', () => {
  const rt = createRuntime(['js/data.js']);
  const result = rt.evaluate(`(() => {
    registerAsset({ id: 'MOVE', name: 'Move', type: 'Crypto' }, new Array(HISTORY_DAYS).fill(120), new Array(HISTORY_DAYS).fill(true));
    const d = offset => MARKET.dates[HISTORY_DAYS - 1 - offset].toISOString();
    const txs = [
      { id: '1', date: d(1), type: 'transfer_in', asset: 'MOVE', qty: 10, price: 100, costBasis: 800, externalValue: 1000 },
      { id: '2', date: d(0), type: 'transfer_out', asset: 'MOVE', qty: 4, price: 120, externalValue: 480 },
    ];
    const portfolio = computePortfolioSeries(txs);
    const position = computePositions(txs)[0];
    return { cash: portfolio.cash, value: portfolio.values.at(-1), invested: totalInvested(txs), qty: position.qty, cost: position.cost };
  })()`);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { cash: 0, value: 720, invested: 520, qty: 6, cost: 480 });
});

test('brokerreconciliatie vergelijkt aantallen en cash met expliciete toleranties', () => {
  const rt = createRuntime(['js/data.js']);
  const result = rt.evaluate(`(() => {
    const empty = loadReconciliation();
    registerAsset({ id: 'REC', name: 'Recon', type: 'ETF' }, new Array(HISTORY_DAYS).fill(120), new Array(HISTORY_DAYS).fill(true));
    const date = MARKET.dates[HISTORY_DAYS - 1].toISOString();
    const txs = [
      { id: '1', date, type: 'deposit', amount: 1000 },
      { id: '2', date, type: 'buy', asset: 'REC', qty: 5, price: 100 },
    ];
    const exact = reconcilePortfolio(txs, { assets: { REC: 5 }, cash: 500, date });
    const mismatch = reconcilePortfolio(txs, { assets: { REC: 4.5 }, cash: 499, date });
    const saved = saveReconciliation({ assets: { REC: 5 }, cash: 500 });
    const loaded = loadReconciliation();
    return { empty, exact, mismatch, saved, loaded };
  })()`);
  const resultPlain = JSON.parse(JSON.stringify(result));
  assert.equal(resultPlain.empty.date, null);
  assert.equal(resultPlain.exact.complete, true);
  assert.equal(resultPlain.exact.balanced, true);
  assert.equal(resultPlain.mismatch.balanced, false);
  assert.equal(resultPlain.mismatch.rows[0].difference, -0.5);
  assert.equal(resultPlain.mismatch.cash.difference, -1);
  assert.equal(resultPlain.saved.assets.REC, 5);
  assert.equal(resultPlain.loaded.cash, 500);
});

test('XIRR volgt de 365-dagenconventie en verwerkt onregelmatige cashflows', () => {
  const rt = createRuntime(['js/data.js', 'js/quant.js']);
  const result = rt.evaluate(`(() => {
    const microsoftExample = [
      { date: '2008-01-01', amount: -10000 },
      { date: '2008-03-01', amount: 2750 },
      { date: '2008-10-30', amount: 4250 },
      { date: '2009-02-15', amount: 3250 },
      { date: '2009-04-01', amount: 2750 },
    ];
    const end = MARKET.dates[HISTORY_DAYS - 1];
    const start = new Date(end.getTime() - 365 * 86400000);
    const portfolioRate = portfolioXirr([{ id: 'd', date: start.toISOString(), type: 'deposit', amount: 100 }], 110, end);
    const exampleRate = xirr(microsoftExample);
    return { exampleRate, exampleNpv: xnpv(exampleRate, microsoftExample), portfolioRate };
  })()`);
  assert.ok(Math.abs(result.exampleRate - 0.373362535) < 1e-8);
  assert.ok(Math.abs(result.exampleNpv) < 1e-5);
  assert.ok(Math.abs(result.portfolioRate - 0.1) < 1e-10);
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

test('DCA op een weekend wacht op de eerste werkelijk waargenomen handelsdag', () => {
  const rt = createRuntime(['js/data.js', 'js/ml.js', 'js/dca.js'], { now: '2026-07-14T12:00:00+02:00' });
  const result = rt.evaluate(`(() => {
    const prices = new Array(HISTORY_DAYS).fill(90);
    const quality = new Array(HISTORY_DAYS).fill(PRICE_QUALITY.RECONSTRUCTED);
    const set = (date, price, state) => {
      const index = dateToIndexUnclamped(localDateFromKey(date));
      prices[index] = price;
      quality[index] = state;
    };
    set('2026-07-10', 100, PRICE_QUALITY.OBSERVED);
    set('2026-07-11', 100, PRICE_QUALITY.CARRIED);
    set('2026-07-12', 100, PRICE_QUALITY.CARRIED);
    set('2026-07-13', 110, PRICE_QUALITY.OBSERVED);
    registerAsset({ id: 'WKDCA', name: 'Weekend DCA', type: 'ETF' }, prices, quality.map(qualityIsReliable), quality);
    saveDcaPlans([{
      id: 'weekend', name: 'Weekendplan', asset: 'WKDCA', amount: 110, day: 11,
      mode: 'fixed', active: true, createdAt: '2026-06-01T12:00:00.000Z', lastRun: '2026-06-11T12:00:00.000Z',
    }]);
    const txs = [];
    const created = executeDuePlans(txs);
    return {
      count: created.length,
      executionDate: created[0] ? localDateKey(new Date(created[0].date)) : null,
      price: created[0]?.price,
      weekendObserved: isObservedPrice('WKDCA', dateToIndexUnclamped(localDateFromKey('2026-07-11'))),
    };
  })()`);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    count: 1, executionDate: '2026-07-13', price: 110, weekendObserved: false,
  });
});
