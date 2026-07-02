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

const { PortfolioMath } = sandbox;
assert.ok(PortfolioMath && typeof PortfolioMath.positions === "function", "PortfolioMath namespace ontbreekt");

const {
  convertQuoteToEur,
  dcaDates,
  parsePriceCsv,
  parsePriceNumber,
  parseYahooChartQuote,
  positions,
  realizedGains,
  realizedGainForYear,
  resolveEquityQuoteSymbol,
  totals
} = PortfolioMath;

const fixture = JSON.parse(await readFile(new URL("../fixtures/demo-portfolio.json", import.meta.url), "utf8"));

assert.equal(parsePriceNumber("€1.234,56"), 1234.56);
assert.equal(parsePriceNumber("1234.56"), 1234.56);
assert.equal(parsePriceNumber("1,234.56"), 1234.56);
assert.equal(parsePriceNumber("1234,56"), 1234.56);
assert.equal(parsePriceNumber(""), 0);

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

// Maandelijkse DCA op de 31e mag niet overlopen naar de volgende maand.
assert.deepEqual(JSON.parse(JSON.stringify(dcaDates("2026-01-31", "monthly", "2026-04-30"))), [
  "2026-01-31",
  "2026-02-28",
  "2026-03-31",
  "2026-04-30"
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

// Verkopen: gemiddelde kostprijs blijft staan en gerealiseerd resultaat wordt vastgelegd.
const sellState = {
  prices: { VWCE: 120 },
  transactions: [
    { ticker: "VWCE", name: "Vanguard FTSE All-World", type: "ETF", side: "buy", date: "2025-01-01", quantity: 10, price: 100, currentPrice: 120 },
    { ticker: "VWCE", name: "Vanguard FTSE All-World", type: "ETF", side: "sell", date: "2025-06-01", quantity: 4, price: 150, currentPrice: 120 }
  ]
};
const sellPosition = positions(sellState).find((item) => item.ticker === "VWCE");
assert.equal(sellPosition.quantity, 6);
assert.equal(sellPosition.cost, 600);
assert.equal(Number(sellPosition.realizedGain.toFixed(2)), 200);

const realizedRows = realizedGains(sellState);
assert.equal(realizedRows.length, 1);
assert.equal(Number(realizedRows[0].gain.toFixed(2)), 200);
assert.equal(realizedRows[0].proceeds, 600);
assert.equal(realizedGainForYear(sellState, 2025), 200);
assert.equal(realizedGainForYear(sellState, 2024), 0);

// Oververkopen wordt geklemd op de beschikbare positie.
const oversellState = {
  prices: {},
  transactions: [
    { ticker: "BTC", name: "Bitcoin", type: "Crypto", side: "buy", date: "2025-01-01", quantity: 1, price: 50000, currentPrice: 60000 },
    { ticker: "BTC", name: "Bitcoin", type: "Crypto", side: "sell", date: "2025-02-01", quantity: 2, price: 60000, currentPrice: 60000 }
  ]
};
assert.equal(positions(oversellState).length, 0);
assert.equal(Number(realizedGains(oversellState)[0].gain.toFixed(2)), 10000);

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
