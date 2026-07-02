import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

// Load classic JS into a VM sandbox to execute it in Node ESM context
const code = await readFile(new URL("../js/portfolioMath.js", import.meta.url), "utf8");
const sandbox = {
  console,
  Intl,
  Math,
  Number,
  String,
  Map,
  Object,
  Date,
  Error
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;

runInNewContext(code, sandbox);

const {
  convertQuoteToEur,
  dcaDates,
  parsePriceCsv,
  parsePriceNumber,
  parseYahooChartQuote,
  positions,
  resolveEquityQuoteSymbol,
  totals
} = sandbox;

const fixture = JSON.parse(await readFile(new URL("../fixtures/demo-portfolio.json", import.meta.url), "utf8"));

assert.equal(parsePriceNumber("€1.234,56"), 1234.56);
assert.equal(parsePriceNumber("1234.56"), 1234.56);

assert.deepEqual(JSON.parse(JSON.stringify(parsePriceCsv("ticker;price\nBTC;52650,25\nVWCE;162.36"))), {
  BTC: 52650.25,
  VWCE: 162.36
});

assert.equal(resolveEquityQuoteSymbol("VWCE"), "VWCE.DE");
assert.equal(resolveEquityQuoteSymbol("tsla"), "TSLA");

const yahooQuote = parseYahooChartQuote({
  chart: {
    result: [{
      meta: {
        symbol: "TSLA",
        regularMarketPrice: 406.43,
        currency: "USD",
        regularMarketTime: 1781294400,
        longName: "Tesla, Inc."
      }
    }]
  }
});
assert.deepEqual(JSON.parse(JSON.stringify(yahooQuote)), {
  symbol: "TSLA",
  price: 406.43,
  currency: "USD",
  regularMarketTime: 1781294400,
  name: "Tesla, Inc."
});
assert.equal(Number(convertQuoteToEur(yahooQuote, { USD_EUR: 0.86453 }).priceEur.toFixed(2)), 351.37);
assert.equal(convertQuoteToEur({ ...yahooQuote, currency: "GBP" }, { USD_EUR: 0.86453 }), null);
assert.equal(parseYahooChartQuote({ chart: { result: [{ meta: { symbol: "BAD", regularMarketPrice: 0, currency: "USD" } }] } }), null);

assert.deepEqual(JSON.parse(JSON.stringify(dcaDates("2026-01-01", "monthly", "2026-03-01"))), [
  "2026-01-01",
  "2026-02-01",
  "2026-03-01"
]);

const list = positions(fixture);
const vwce = list.find((item) => item.ticker === "VWCE");
const btc = list.find((item) => item.ticker === "BTC");

assert.equal(vwce.quantity, 8);
assert.equal(vwce.cost, 800);
assert.equal(vwce.value, 960);
assert.equal(btc.value, 6500);

const total = totals(fixture);
assert.equal(total.cost, 5800);
assert.equal(total.value, 7460);
assert.equal(total.dcaMonthly, 300);

const correctedState = {
  prices: { VWCE: 120 },
  avgPriceCorrections: {
    VWCE: { avgPrice: 80, date: "2026-02-01" }
  },
  transactions: [
    { ticker: "VWCE", name: "Vanguard FTSE All-World", type: "ETF", side: "buy", date: "2026-01-01", quantity: 10, price: 100, currentPrice: 120 },
    { ticker: "VWCE", name: "Vanguard FTSE All-World", type: "ETF", side: "buy", date: "2026-03-01", quantity: 2, price: 120, currentPrice: 120 }
  ]
};
const correctedPosition = positions(correctedState).find((item) => item.ticker === "VWCE");
assert.equal(correctedPosition.quantity, 12);
assert.equal(correctedPosition.cost, 1040);
assert.equal(Number(correctedPosition.avgPrice.toFixed(2)), 86.67);

const multiAssetDcaState = {
  prices: { VWCE: 120, BTC: 65000 },
  transactions: [],
  dcas: [{
    active: true,
    frequency: "monthly",
    assets: [
      { ticker: "VWCE", quantity: 2, type: "ETF" },
      { ticker: "BTC", quantity: 0.01, type: "Crypto" }
    ]
  }]
};
assert.equal(totals(multiAssetDcaState).dcaMonthly, 890);

const screenshotState = {
  prices: {
    CR1: 100,
    CR2: 50,
    ETF1: 20,
    STK1: 10
  },
  transactions: [
    ["CR1", "Demo Crypto 1", "Crypto", 2, 100],
    ["CR2", "Demo Crypto 2", "Crypto", 3, 50],
    ["ETF1", "Demo ETF", "ETF", 10, 20],
    ["STK1", "Demo Stock", "Aandeel", 4, 10]
  ].map(([ticker, name, type, quantity, price]) => ({
    ticker,
    name,
    type,
    side: "buy",
    date: "2026-01-01",
    quantity,
    price,
    currentPrice: price
  }))
};

const screenshotTotal = totals(screenshotState);
assert.equal(Number(screenshotTotal.list.find((item) => item.ticker === "CR1").value.toFixed(2)), 200);
assert.equal(Number(screenshotTotal.list.filter((item) => item.type === "Crypto").reduce((sum, item) => sum + item.value, 0).toFixed(2)), 350);
assert.equal(Number(screenshotTotal.list.filter((item) => item.type !== "Crypto").reduce((sum, item) => sum + item.value, 0).toFixed(2)), 240);

const expectedCryptoQuantities = {
  CR1: 2,
  CR2: 3
};

Object.entries(expectedCryptoQuantities).forEach(([ticker, quantity]) => {
  assert.equal(screenshotTotal.list.find((item) => item.ticker === ticker).quantity, quantity);
});

const changedPriceState = {
  ...screenshotState,
  prices: {
    ...screenshotState.prices,
    CR1: screenshotState.prices.CR1 * 1.2,
    CR2: screenshotState.prices.CR2 * 0.8
  }
};
const changedPriceTotal = totals(changedPriceState);
Object.entries(expectedCryptoQuantities).forEach(([ticker, quantity]) => {
  assert.equal(changedPriceTotal.list.find((item) => item.ticker === ticker).quantity, quantity);
});
assert.notEqual(
  Number(changedPriceTotal.list.find((item) => item.ticker === "CR1").value.toFixed(2)),
  Number(screenshotTotal.list.find((item) => item.ticker === "CR1").value.toFixed(2))
);

console.log("portfolioMath tests passed");
