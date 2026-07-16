import { expect, test } from '@playwright/test';

const BASE_ORIGIN = 'http://127.0.0.1:4175';
const HISTORY_DAYS = 1095;

function runtimeMonitor(page) {
  const errors = [];
  const externalRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.protocol.startsWith('http') && url.origin !== BASE_ORIGIN) externalRequests.push(request.url());
  });
  return {
    assertClean() {
      expect(errors, 'browserruntime bevat fouten').toEqual([]);
      expect(externalRequests, 'netwerk staat uit maar er waren externe requests').toEqual([]);
    },
  };
}

function localDateKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function marketWindow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en', {
    timeZone: 'Europe/Amsterdam', year: 'numeric', month: 'numeric', day: 'numeric',
  }).formatToParts(new Date()).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
  const end = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (HISTORY_DAYS - 1));
  const event = new Date(start);
  event.setUTCDate(event.getUTCDate() + 365);
  return { startDate: localDateKey(start), eventDate: localDateKey(event) };
}

function backupFixture(schemaVersion) {
  const { startDate, eventDate } = marketWindow();
  const baseState = {
    watchlist: [], alerts: [], dcaPlans: [], watchAssets: [], liveHistory: {}, yahooMap: {},
  };
  if (schemaVersion === 4) {
    const pricesA = Array.from({ length: HISTORY_DAYS }, (_, index) =>
      +(100 * Math.exp(0.00025 * index + 0.015 * Math.sin(index / 17))).toFixed(8));
    const pricesB = Array.from({ length: HISTORY_DAYS }, (_, index) =>
      +(80 * Math.exp(0.00018 * index - 0.012 * Math.sin(index / 23))).toFixed(8));
    const marketEntry = prices => ({
      schemaVersion: 2, startDate, prices, quality: 'o'.repeat(HISTORY_DAYS),
      source: 'e2e', anchorConfidence: 'verified',
    });
    return {
      schemaVersion,
      meta: { app: 'Vermogen', kind: 'vermogen-backup', exportedAt: new Date().toISOString() },
      state: {
        ...baseState,
        transactions: [
          { id: '1-deposit', date: eventDate, type: 'deposit', amount: 1000 },
          { id: '2-buy-a', date: eventDate, type: 'buy', asset: 'V4A', qty: 4, price: 100, external: false },
          { id: '3-buy-b', date: eventDate, type: 'buy', asset: 'V4B', qty: 2, price: 80, external: false },
        ],
        assets: [
          { id: 'V4A', name: 'Versie vier A', type: 'ETF', histSource: 'e2e' },
          { id: 'V4B', name: 'Versie vier B', type: 'ETF', histSource: 'e2e' },
        ],
        market: { V4A: marketEntry(pricesA), V4B: marketEntry(pricesB) },
        reconciliation: { assets: { V4A: 4, V4B: 2 }, cash: 440, date: `${eventDate}T12:00:00.000Z` },
      },
    };
  }

  const id = `V${schemaVersion}`;
  const prices = new Array(HISTORY_DAYS).fill(100);
  const transactions = schemaVersion === 2
    ? [{ id: 'legacy-buy', date: eventDate, type: 'buy', asset: id, qty: 1, price: 100 }]
    : [
        { id: '1-deposit', date: eventDate, type: 'deposit', amount: 500 },
        { id: '2-buy', date: eventDate, type: 'buy', asset: id, qty: 2, price: 100, external: false },
      ];
  return {
    schemaVersion,
    meta: { app: 'Vermogen', kind: 'vermogen-backup', exportedAt: new Date().toISOString() },
    state: {
      ...baseState,
      transactions,
      assets: [{ id, name: `Versie ${schemaVersion}`, type: 'ETF', histSource: 'e2e' }],
      prices: { [id]: prices },
      provenance: { [id]: new Array(HISTORY_DAYS).fill(true) },
      reconciliation: schemaVersion === 3
        ? { assets: { [id]: 2 }, cash: 300, date: `${eventDate}T12:00:00.000Z` }
        : undefined,
    },
  };
}

async function chooseJsonFile(page, buttonSelector, payload, name = 'synthetisch-portfolio.json') {
  const chooserPromise = page.waitForEvent('filechooser');
  await page.locator(buttonSelector).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(payload)) });
  await expect(page.locator('#import-preview-modal')).toHaveClass(/open/);
}

async function applyPreviewAndWaitForReload(page) {
  await page.locator('#import-preview-confirm').check();
  await expect(page.locator('#import-preview-apply')).toBeEnabled();
  const navigation = page.waitForEvent('framenavigated', {
    predicate: frame => frame === page.mainFrame(),
    timeout: 7_000,
  });
  await page.locator('#import-preview-apply').click();
  await navigation;
  await page.waitForLoadState('domcontentloaded');
}

test('lege staat, fail-closed importpreview en toetsenbordmodals werken als één gebruikersflow', async ({ page }) => {
  const monitor = runtimeMonitor(page);
  await page.goto('/');
  await expect(page.locator('#empty-overlay')).toBeVisible();
  await expect(page.locator('#mode-note')).toContainText('netwerk uit');

  const payload = {
    transactions: [{ date: '2025-01-02', side: 'buy', ticker: 'E2E', name: 'E2E Fonds', quantity: 2, price: 100 }],
  };
  await chooseJsonFile(page, '#empty-import', payload);
  await expect(page.locator('#import-preview-confirm')).toBeFocused();
  await expect(page.locator('#import-preview-apply')).toBeDisabled();
  expect(await page.evaluate(() => localStorage.getItem('vermogen_transactions_v4'))).toBeNull();

  await page.keyboard.press('Escape');
  await expect(page.locator('#import-preview-modal')).not.toHaveClass(/open/);
  await expect(page.locator('#empty-import')).toBeFocused();
  expect(await page.evaluate(() => localStorage.getItem('vermogen_transactions_v4'))).toBeNull();

  await chooseJsonFile(page, '#empty-import', payload);
  await applyPreviewAndWaitForReload(page);
  await expect(page.locator('#empty-overlay')).toBeHidden();
  expect(await page.evaluate(() => state.portfolio.values.at(-1))).toBeGreaterThan(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('vermogen_transactions_v4')).length)).toBe(1);

  await page.locator('[data-view="transactions"]').click();
  await expect(page.locator('#tx-table tbody')).toContainText('E2E Fonds');
  await page.locator('[data-view="dashboard"]').click();

  await page.locator('#btn-new-tx').click();
  await expect(page.locator('#tx-modal')).toHaveClass(/open/);
  await expect(page.locator('#tx-type-select')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#tx-modal')).not.toHaveClass(/open/);
  await expect(page.locator('#btn-new-tx')).toBeFocused();

  await page.locator('#btn-new-tx').click();
  await page.locator('#tx-save').focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('#tx-type-select')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('#tx-save')).toBeFocused();
  await page.keyboard.press('Escape');
  monitor.assertClean();
});

for (const schemaVersion of [2, 3, 4]) {
  test(`backup schema ${schemaVersion} doorloopt preview, restore en reload`, async ({ page }) => {
    const monitor = runtimeMonitor(page);
    const backup = backupFixture(schemaVersion);
    await page.goto('/');
    await page.locator('#import-file').setInputFiles({
      name: `backup-v${schemaVersion}.json`,
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(backup)),
    });
    await expect(page.locator('#import-preview-modal')).toHaveClass(/open/);
    await expect(page.locator('#import-preview-intro')).toContainText(`Backup schema ${schemaVersion}`);
    expect(await page.evaluate(() => localStorage.getItem('vermogen_transactions_v4'))).toBeNull();

    await applyPreviewAndWaitForReload(page);
    const expectedTransactions = schemaVersion === 4 ? 3 : schemaVersion === 3 ? 2 : 1;
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('vermogen_transactions_v4')).length)).toBe(expectedTransactions);
    expect(await page.evaluate(() => localStorage.getItem('vermogen_network_consent_v1'))).toBe('no');
    await expect(page.locator('#empty-overlay')).toBeHidden();

    await page.locator('[data-view="transactions"]').click();
    await expect(page.locator('#tx-count')).toContainText(`${expectedTransactions} boeking`);
    if (schemaVersion === 4) {
      await expect(page.locator('#recon-status')).toContainText('sluiten volledig aan');
      await page.locator('[data-view="insights"]').click();
      await expect(page.locator('#ef-sampling')).toContainText('730 gezamenlijke waargenomen intervallen');
      await expect(page.locator('#corr-sampling')).toContainText('730 gezamenlijke waargenomen intervallen');
      await page.locator('#stress-buttons button').first().click();
      await expect(page.locator('#stress-result')).toContainText('cash');
    }
    monitor.assertClean();
  });
}

test('service-workerupdate verwijdert een oude shellcache en bestuurt de herladen app', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Cache-updatepad wordt één keer in Chromium afgedekt.');
  const monitor = runtimeMonitor(page);
  await page.goto('/icon.svg');
  await page.evaluate(async () => { await caches.open('vermogen-v20'); });
  await page.goto('/');
  const cacheNames = await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    return caches.keys();
  });
  expect(cacheNames).toContain('vermogen-v21');
  await expect.poll(async () => page.evaluate(async () => (await caches.keys()).includes('vermogen-v20'))).toBe(false);
  await page.reload();
  expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await expect(page.locator('#empty-overlay')).toBeVisible();
  monitor.assertClean();
});
