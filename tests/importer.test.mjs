import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntime, MemoryStorage } from './helpers/runtime.mjs';

const FILES = ['js/data.js', 'js/importer.js'];

function genericPortfolio() {
  const history = Array.from({ length: 30 }, (_, i) => ({
    date: new Date(Date.now() - (29 - i) * 86400000).toISOString().slice(0, 10),
    price: 90 + i,
  }));
  return JSON.stringify({
    transactions: [{ id: 'broker-1', date: new Date().toISOString(), side: 'buy', ticker: 'SAFE', quantity: 2, price: 100, name: 'Safe ETF' }],
    histories: { SAFE: history },
  });
}

test('identieke JSON-herimport bewaart assetdefinities en overleeft reload', () => {
  const storage = new MemoryStorage();
  const first = createRuntime(FILES, { storage });
  assert.equal(first.evaluate(`importPortfolioJSON(${JSON.stringify(genericPortfolio())}).ok`), true);
  assert.equal(JSON.parse(storage.getItem('vermogen_custom_v1')).assets.length, 1);
  assert.equal(first.evaluate(`importPortfolioJSON(${JSON.stringify(genericPortfolio())}).ok`), true);
  assert.equal(JSON.parse(storage.getItem('vermogen_custom_v1')).assets.length, 1);

  const reload = createRuntime(FILES, { storage });
  assert.equal(reload.evaluate('ASSETS.length'), 1);
  assert.equal(reload.evaluate('ASSETS[0].id'), 'SAFE');
  assert.equal(reload.evaluate('MARKET.prices.SAFE.length'), 1095);
});

test('geïmporteerde labels worden onschadelijk gemaakt', () => {
  const rt = createRuntime(FILES);
  const payload = JSON.stringify({
    transactions: [{ date: '2026-07-01', side: 'buy', ticker: 'XSS', quantity: 1, price: 10, name: '<img src=x onerror=alert(1)>' }],
  });
  const result = rt.evaluate(`importPortfolioJSON(${JSON.stringify(payload)})`);
  assert.equal(result.ok, true);
  assert.doesNotMatch(rt.evaluate('ASSETS[0].name'), /[<>]/);
});

test('mislukte backuprestore verandert bestaande opslag niet', () => {
  const storage = new MemoryStorage({ vermogen_keep: 'ongewijzigd', vermogen_mode: 'oud' });
  const rt = createRuntime(FILES, { storage });
  const bad = JSON.stringify({ schemaVersion: 2, meta: { kind: 'vermogen-backup' }, state: { transactions: [], assets: [{}], prices: {} } });
  const result = rt.evaluate(`importPortfolioJSON(${JSON.stringify(bad)})`);
  assert.equal(result.ok, false);
  assert.equal(storage.getItem('vermogen_keep'), 'ongewijzigd');
  assert.equal(storage.getItem('vermogen_mode'), 'oud');
});

test('te diep geneste import wordt beheerst afgewezen', () => {
  const rt = createRuntime(FILES);
  let nested = {};
  for (let i = 0; i < 70; i++) nested = { child: nested };
  const result = rt.evaluate(`importPortfolioJSON(${JSON.stringify(JSON.stringify(nested))})`);
  assert.equal(result.ok, false);
  assert.match(result.error, /te diep genest/);
});

test('CSV-dedupe behoudt afzonderlijke orders met andere prijs', () => {
  const rt = createRuntime(FILES);
  const result = rt.evaluate(`(() => {
    registerAsset({ id: 'BTC', name: 'Bitcoin', type: 'Crypto' }, new Array(HISTORY_DAYS).fill(100), new Array(HISTORY_DAYS).fill(true));
    const csv = [
      'Date,Currency,Type,Amount,Quote Price,Timezone,Transaction ID',
      '2026-07-01,BTC,buy,0.1,50000,UTC,one',
      '2026-07-01,BTC,buy,0.1,51000,UTC,two',
    ].join('\\n');
    const txs = [];
    const one = importTransactionCSV(csv, txs);
    const two = importTransactionCSV(csv, txs);
    return { one, two, txs };
  })()`);
  assert.equal(result.one.added, 2);
  assert.equal(result.two.added, 0);
  assert.equal(result.txs.length, 2);
  assert.equal(JSON.stringify(result.txs.map(tx => tx.price)), JSON.stringify([50000, 51000]));
});

test('netwerk staat standaard uit en veroorzaakt geen impliciete fetch', async () => {
  const rt = createRuntime(FILES);
  rt.evaluate(`registerAsset({ id: 'BTC', name: 'Bitcoin', type: 'Crypto' }, new Array(HISTORY_DAYS).fill(100), new Array(HISTORY_DAYS).fill(false))`);
  const result = await rt.evaluate('fetchLivePrices()');
  assert.equal(result, null);
  assert.equal(rt.fetchCalls(), 0);
});

test('backuprestore zet voorkeuren terug maar netwerktoestemming uit', () => {
  const rt = createRuntime(FILES);
  const result = rt.evaluate(`(() => {
    const prices = new Array(HISTORY_DAYS).fill(100);
    const backup = {
      schemaVersion: 2,
      meta: { app: 'Vermogen', kind: 'vermogen-backup' },
      state: {
        transactions: [{ id: 'x', date: new Date().toISOString(), type: 'buy', asset: 'ETF', qty: 1, price: 100 }],
        assets: [{ id: 'ETF', name: 'ETF', type: 'ETF', histSource: 'import' }],
        prices: { ETF: prices }, provenance: { ETF: new Array(HISTORY_DAYS).fill(true) },
        watchlist: ['ETF'], alerts: [{ id: 'a', asset: 'ETF', metric: 'price', op: '>', threshold: 120 }],
        dcaPlans: [], watchAssets: [], liveHistory: {}, yahooMap: {},
      },
    };
    localStorage.setItem(NETWORK_CONSENT_KEY, 'yes');
    return importPortfolioJSON(JSON.stringify(backup));
  })()`);
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(rt.storage.getItem('vermogen_watchlist_v1')), ['ETF']);
  assert.equal(rt.storage.getItem('vermogen_network_consent_v1'), 'no');
});
