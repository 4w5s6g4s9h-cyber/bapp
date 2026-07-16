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
  assert.equal(JSON.parse(storage.getItem('vermogen_transactions_v4'))[0].external, true);
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

test('generieke schema-v4 JSON bewaart cash, interne trades, dividend en splits', () => {
  const rt = createRuntime(FILES);
  const payload = JSON.stringify({ transactions: [
    { id: 'cash', date: '2026-07-01', type: 'deposit', amount: 1000 },
    { id: 'buy', date: '2026-07-02', type: 'buy', asset: 'V4X', qty: 10, price: 100, external: false },
    { id: 'div', date: '2026-07-03', type: 'dividend', asset: 'V4X', amount: 20 },
    { id: 'split', date: '2026-07-04', type: 'split', asset: 'V4X', ratio: 2 },
  ] });
  const result = rt.evaluate(`(() => {
    const imported = importPortfolioJSON(${JSON.stringify(payload)});
    const txs = JSON.parse(localStorage.getItem(TX_KEY));
    const ledger = buildPortfolioLedger(txs);
    return { imported, txs, cash: ledger.cash, qty: ledger.positions.V4X.qty, external: ledger.externalFlows.reduce((a, b) => a + b, 0) };
  })()`);
  assert.equal(result.imported.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.txs.map(tx => tx.type))), ['deposit', 'buy', 'dividend', 'split']);
  assert.equal(result.txs[1].external, false);
  assert.equal(result.cash, 20);
  assert.equal(result.qty, 20);
  assert.equal(result.external, 1000);
});

test('DEGIRO-import boekt expliciete transactiekosten en blijft direct extern afgerekend', () => {
  const rt = createRuntime(FILES);
  const result = rt.evaluate(`(() => {
    registerAsset({ id: 'NL0000000001', name: 'Degiro ETF', type: 'ETF' }, new Array(HISTORY_DAYS).fill(110), new Array(HISTORY_DAYS).fill(true));
    const csv = [
      'Datum,ISIN,Aantal,Waarde EUR,Transactiekosten EUR,Belasting EUR,Product,Order ID',
      '01-07-2026,NL0000000001,2,200,-2.50,-0.50,Degiro ETF,order-fee',
    ].join('\\n');
    const txs = [];
    const imported = importTransactionCSV(csv, txs);
    return { imported, tx: txs[0], invested: totalInvested(txs) };
  })()`);
  assert.equal(result.imported.ok, true);
  assert.equal(result.tx.price, 100);
  assert.equal(result.tx.fee, 2.5);
  assert.equal(result.tx.tax, 0.5);
  assert.equal(result.tx.external, true);
  assert.equal(result.invested, 203);
});

test('Bitvavo-cashfunding maakt trades intern en behoudt brokerfees', () => {
  const rt = createRuntime(FILES);
  const result = rt.evaluate(`(() => {
    registerAsset({ id: 'BTC', name: 'Bitcoin', type: 'Crypto' }, new Array(HISTORY_DAYS).fill(50000), new Array(HISTORY_DAYS).fill(true));
    const csv = [
      'Date,Currency,Type,Amount,Quote Price,Timezone,Transaction ID,Fee,Fee Currency',
      '2026-07-01,EUR,deposit,1000,1,UTC,cash-in,0,EUR',
      '2026-07-02,BTC,buy,0.01,50000,UTC,buy-one,1,EUR',
    ].join('\\n');
    const txs = [];
    const imported = importTransactionCSV(csv, txs);
    const ledger = buildPortfolioLedger(txs);
    return { imported, txs, cash: ledger.cash, invested: totalInvested(txs) };
  })()`);
  assert.equal(result.imported.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.txs.map(tx => tx.type))), ['deposit', 'buy']);
  assert.equal(result.txs[1].external, false);
  assert.equal(result.txs[1].fee, 1);
  assert.equal(result.cash, 499);
  assert.equal(result.invested, 1000);
});

test('Bitvavo assetdeposit wordt transfer en stakingreward blijft een interne nulbasis-toename', () => {
  const rt = createRuntime(FILES);
  const result = rt.evaluate(`(() => {
    registerAsset({ id: 'BTC', name: 'Bitcoin', type: 'Crypto' }, new Array(HISTORY_DAYS).fill(100), new Array(HISTORY_DAYS).fill(true));
    const csv = [
      'Date,Currency,Type,Amount,Quote Price,Timezone,Transaction ID',
      '2026-07-01,BTC,deposit,0.1,0,UTC,asset-in',
      '2026-07-02,BTC,staking,0.01,0,UTC,reward',
    ].join('\\n');
    const txs = [];
    const imported = importTransactionCSV(csv, txs);
    const ledger = buildPortfolioLedger(txs);
    return { imported, txs, qty: ledger.positions.BTC.qty, cost: ledger.positions.BTC.cost, invested: totalInvested(txs) };
  })()`);
  assert.equal(result.imported.ok, true);
  assert.equal(result.imported.transfers, 1);
  assert.equal(result.imported.estimatedTransfers, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(result.txs.map(tx => tx.type))), ['transfer_in', 'transfer_in']);
  assert.equal(result.txs[1].externalValue, 0);
  assert.ok(Math.abs(result.qty - 0.11) < 1e-12);
  assert.equal(result.cost, 10);
  assert.equal(result.invested, 10);
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

test('automatisch verversen heeft een afzonderlijke opt-in en vaste vensters', () => {
  const rt = createRuntime(FILES);
  const now = 1_800_000_000_000;

  assert.equal(rt.evaluate('autoRefreshEnabled()'), false);
  assert.equal(rt.evaluate('networkConsentEnabled()'), false);
  rt.evaluate('setAutoRefreshEnabled(true)');
  assert.equal(rt.evaluate('autoRefreshEnabled()'), true);
  assert.equal(rt.evaluate('networkConsentEnabled()'), false);
  assert.equal(rt.evaluate(`isPriceRefreshDue(${now - 30 * 60 * 1000}, CRYPTO_AUTO_REFRESH_MS, ${now})`), false);
  assert.equal(rt.evaluate(`isPriceRefreshDue(${now - 61 * 60 * 1000}, CRYPTO_AUTO_REFRESH_MS, ${now})`), true);
  assert.equal(rt.evaluate(`isPriceRefreshDue(${now - 23 * 60 * 60 * 1000}, STOCK_AUTO_REFRESH_MS, ${now})`), false);
  assert.equal(rt.evaluate(`isPriceRefreshDue(${now - 25 * 60 * 60 * 1000}, STOCK_AUTO_REFRESH_MS, ${now})`), true);
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

test('Yahoo wijst een lege koersreeks beheerst af', async () => {
  const rt = createRuntime(FILES, {
    fetchImpl: async () => ({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({
        chart: { result: [{
          timestamp: [1_780_000_000],
          indicators: { quote: [{ close: [null] }] },
          meta: { currency: 'EUR', regularMarketPrice: 10 },
        }] },
      }),
    }),
  });
  rt.storage.setItem('vermogen_network_consent_v1', 'yes');

  assert.equal(await rt.evaluate(`fetchYahooChart('EMPTY')`), null);
});

test('automatische dagkoersen selecteren maximaal tien oudste assets', () => {
  const now = 1_800_000_000_000;
  const stockWindow = 24 * 60 * 60 * 1000;
  const liveHistory = Object.fromEntries(Array.from({ length: 12 }, (_, i) => {
    const id = 'S' + String(i).padStart(2, '0');
    return [id, { at: i === 11 ? now - stockWindow / 2 : now - 2 * stockWindow + i * 1000 }];
  }));
  liveHistory.S01.at = now - 3 * stockWindow;
  const storage = new MemoryStorage({
    vermogen_livehist_v1: JSON.stringify(liveHistory),
  });
  const rt = createRuntime(FILES, { storage });
  rt.evaluate(`Array.from({ length: 12 }, (_, i) => {
    const id = 'S' + String(i).padStart(2, '0');
    registerAsset({ id, name: id, type: 'Aandeel' }, new Array(HISTORY_DAYS).fill(100), new Array(HISTORY_DAYS).fill(true));
  })`);

  const selected = rt.evaluate(`autoStockRefreshIds(${now})`);
  assert.equal(selected.length, 10);
  assert.equal(selected[0], 'S01');
  assert.equal(selected[1], 'S00');
  assert.equal(selected.includes('S10'), false);
  assert.equal(selected.includes('S11'), false);
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

test('dynamische CoinGecko-koppeling overleeft reload en bewaart de uurkoers', async () => {
  const storage = new MemoryStorage({ vermogen_network_consent_v1: 'yes' });
  const now = Date.now();
  const history = Array.from({ length: 35 }, (_, index) => [now - (34 - index) * 86400000, 10 + index]);
  const jsonResponse = body => ({ ok: true, status: 200, json: async () => body });
  const first = createRuntime(['js/data.js', 'js/catalog.js', 'js/importer.js'], {
    storage,
    fetchImpl: async url => {
      assert.match(String(url), /\/coins\/privacy-coin\/market_chart/);
      return jsonResponse({ prices: history });
    },
  });

  const added = await first.evaluate(`addWatchAsset({ id: 'PRV', name: 'Privacy Coin', type: 'Crypto', cg: 'privacy-coin' })`);
  assert.equal(added.ok, true);
  assert.equal(JSON.parse(storage.getItem('vermogen_watchassets_v1'))[0].cg, 'privacy-coin');

  let liveUrl = '';
  const providerSeconds = Math.floor(Date.now() / 1000) - 30;
  const reload = createRuntime(['js/data.js', 'js/catalog.js', 'js/importer.js'], {
    storage,
    fetchImpl: async url => {
      liveUrl = String(url);
      return jsonResponse({ 'privacy-coin': { eur: 42.25, last_updated_at: providerSeconds } });
    },
  });
  reload.evaluate('loadWatchAssets(); applyLiveHistory()');
  const updated = await reload.evaluate('fetchLivePrices()');
  const saved = JSON.parse(storage.getItem('vermogen_livehist_v1')).PRV;

  assert.equal(JSON.stringify(updated), JSON.stringify(['PRV']));
  assert.match(liveUrl, /ids=privacy-coin/);
  assert.match(liveUrl, /include_last_updated_at=true/);
  assert.equal(reload.evaluate(`assetById('PRV').cg`), 'privacy-coin');
  assert.equal(reload.evaluate(`lastPrice('PRV')`), 42.25);
  assert.equal(saved.cg, 'privacy-coin');
  assert.equal(saved.quoteAt, providerSeconds * 1000);
  assert.deepEqual(saved.points.find(([index]) => index === 1094), [1094, 42.25]);
});

test('een opgeslagen spotkoers herschaalt geïmporteerde historie niet bij reload', async () => {
  const storage = new MemoryStorage({ vermogen_network_consent_v1: 'yes' });
  const response = { bitcoin: { eur: 200, last_updated_at: Math.floor(Date.now() / 1000) } };
  const first = createRuntime(FILES, {
    storage,
    fetchImpl: async () => ({ ok: true, json: async () => response }),
  });
  first.evaluate(`registerAsset({ id: 'BTC', name: 'Bitcoin', type: 'Crypto', histSource: 'import' }, Array.from({ length: HISTORY_DAYS }, (_, i) => 100 + i / 100), new Array(HISTORY_DAYS).fill(true))`);
  await first.evaluate('fetchLivePrices()');
  assert.equal(JSON.parse(storage.getItem('vermogen_livehist_v1')).BTC.spotOnly, true);

  const reload = createRuntime(FILES, { storage });
  const result = reload.evaluate(`(() => {
    registerAsset({ id: 'BTC', name: 'Bitcoin', type: 'Crypto', histSource: 'import' }, Array.from({ length: HISTORY_DAYS }, (_, i) => 100 + i / 100), new Array(HISTORY_DAYS).fill(true));
    applyLiveHistory();
    return { first: MARKET.prices.BTC[0], last: lastPrice('BTC'), source: assetById('BTC').histSource };
  })()`);
  assert.equal(result.first, 100);
  assert.equal(result.last, 200);
  assert.equal(result.source, 'import');
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
    setAutoRefreshEnabled(true);
    savePriceRefreshMeta({ cryptoSuccessAt: Date.now() });
    return importPortfolioJSON(JSON.stringify(backup));
  })()`);
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(rt.storage.getItem('vermogen_watchlist_v1')), ['ETF']);
  assert.equal(rt.storage.getItem('vermogen_network_consent_v1'), 'no');
  assert.equal(rt.storage.getItem('vermogen_auto_refresh_v1'), null);
  assert.equal(rt.storage.getItem('vermogen_price_refresh_meta_v1'), null);
});

test('schema-v3-backup herstelt alle boekingstypen en brokerreconciliatie', () => {
  const rt = createRuntime(FILES);
  const result = rt.evaluate(`(() => {
    const prices = new Array(HISTORY_DAYS).fill(100);
    const provenance = new Array(HISTORY_DAYS).fill(true);
    const backup = {
      schemaVersion: 3,
      meta: { app: 'Vermogen', kind: 'vermogen-backup' },
      state: {
        transactions: [
          { id: 'd', date: '2026-01-01', type: 'deposit', amount: 1000 },
          { id: 'b', date: '2026-01-02', type: 'buy', asset: 'ETF', qty: 5, price: 100, fee: 2, external: false },
          { id: 'i', date: '2026-01-03', type: 'dividend', asset: 'ETF', amount: 10 },
        ],
        assets: [{ id: 'ETF', name: 'ETF', type: 'ETF', histSource: 'import' }],
        prices: { ETF: prices }, provenance: { ETF: provenance },
        watchlist: [], alerts: [], dcaPlans: [], watchAssets: [], liveHistory: {}, yahooMap: {},
        reconciliation: { assets: { ETF: 5 }, cash: 508, date: '2026-07-01T12:00:00.000Z' },
      },
    };
    const restored = importPortfolioJSON(JSON.stringify(backup));
    return {
      restored,
      txs: JSON.parse(localStorage.getItem(TX_KEY)),
      reconciliation: JSON.parse(localStorage.getItem(RECONCILIATION_KEY)),
    };
  })()`);
  assert.equal(result.restored.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.txs.map(tx => tx.type))), ['deposit', 'buy', 'dividend']);
  assert.equal(result.txs[1].external, false);
  assert.equal(result.reconciliation.assets.ETF, 5);
  assert.equal(result.reconciliation.cash, 508);
});

test('onbekende backupversies worden expliciet geweigerd', () => {
  const rt = createRuntime(FILES);
  const result = rt.evaluate(`importPortfolioJSON(JSON.stringify({ schemaVersion: 99, meta: { kind: 'vermogen-backup' }, state: {} }))`);
  assert.equal(result.ok, false);
  assert.match(result.error, /Backupversie 99/);
});
