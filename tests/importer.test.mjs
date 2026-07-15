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

test('een API-sleutel opslaan schakelt netwerktoestemming niet stilzwijgend in', () => {
  const rt = createRuntime(FILES);

  assert.equal(rt.evaluate(`setAlphaVantageApiKey('TESTKEY123456')`), true);
  assert.equal(rt.evaluate(`Boolean(alphaVantageApiKey())`), true);
  assert.equal(rt.evaluate(`networkConsentEnabled()`), false);
});

test('Yahoo accepteert geldige korte historie van een nieuwe notering', async () => {
  const timestamps = Array.from({ length: 5 }, (_, i) => 1_780_000_000 + i * 86_400);
  const closes = timestamps.map((_, i) => 20 + i);
  const rt = createRuntime(FILES, {
    fetchImpl: async () => ({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({
        chart: { result: [{
          timestamp: timestamps,
          indicators: { quote: [{ close: closes }] },
          meta: { currency: 'USD', shortName: 'Nieuwe notering' },
        }] },
      }),
    }),
  });
  rt.storage.setItem('vermogen_network_consent_v1', 'yes');

  const result = await rt.evaluate(`fetchYahooChart('SPCX')`);

  assert.equal(result.points.length, 5);
  assert.equal(result.currency, 'USD');
  assert.equal(result.name, 'Nieuwe notering');
});

test('watchlist gebruikt Alpha Vantage wanneer de browser Yahoo blokkeert', async () => {
  const storage = new MemoryStorage({
    vermogen_network_consent_v1: 'yes',
    vermogen_alpha_vantage_key_v1: 'TESTKEY123456',
  });
  const jsonResponse = body => ({
    ok: true,
    headers: { get: () => 'application/json' },
    json: async () => body,
  });
  let alphaCalls = 0;
  let yahooCalls = 0;
  const rt = createRuntime(['js/data.js', 'js/catalog.js', 'js/importer.js'], {
    storage,
    fetchImpl: async url => {
      const target = String(url);
      if (target.startsWith('https://query1.finance.yahoo.com/')) {
        yahooCalls++;
        throw new TypeError('CORS blocked');
      }
      if (target.includes('function=SYMBOL_SEARCH')) {
        throw new Error('Een gewone Amerikaanse ticker mag geen extra zoekrequest doen');
      }
      if (target.includes('function=TIME_SERIES_DAILY')) {
        alphaCalls++;
        return jsonResponse({ 'Time Series (Daily)': {
          '2026-07-10': { '4. close': '145.30' },
          '2026-07-09': { '4. close': '152.16' },
          '2026-07-08': { '4. close': '148.30' },
          '2026-07-07': { '4. close': '149.47' },
          '2026-07-06': { '4. close': '160.42' },
        } });
      }
      if (target.startsWith('https://api.frankfurter.dev/')) {
        return jsonResponse({ rates: { '2020-01-01': { EUR: 0.9 } } });
      }
      throw new Error(`Onverwachte URL: ${target}`);
    },
  });

  const result = await rt.evaluate(`addWatchAsset({ id: 'SPCX', name: 'SPCX', type: 'Aandeel' })`);

  assert.equal(result.ok, true);
  assert.equal(alphaCalls, 1);
  assert.equal(yahooCalls, 0);
  assert.equal(rt.evaluate(`assetById('SPCX').name`), 'SPCX');
  assert.equal(rt.evaluate(`assetById('SPCX').histSource`), 'alpha');
  assert.ok(Math.abs(rt.evaluate(`lastPrice('SPCX')`) - 130.77) < 1e-9);
  assert.equal(JSON.parse(storage.getItem('vermogen_livehist_v1')).SPCX.src, 'alpha');
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
