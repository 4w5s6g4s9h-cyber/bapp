/* ============================================================
   app.js — state, views & interactie
   ============================================================ */

const state = {
  txs: loadTransactions(),
  range: { start: HISTORY_DAYS - 182, end: HISTORY_DAYS - 1 },
  showBenchmark: false,
  chartMode: 'line',        // line | candles | compare
  compareSet: new Set(),
  selectedAsset: null,
  models: {},               // assetId -> getraind model
  training: null,
  mcTimer: null,
  portfolio: null,
  backtest: { data: null, playing: null },
  ef: null,                 // efficient frontier cache
  watchlist: null,          // wordt bij init geladen
  holdingsSort: { key: 'value', dir: -1 },
};

const $ = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);
const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

function analysisAvailable(assetId, days = 365) {
  return Boolean(assetId && MARKET.prices[assetId] && hasReliableHistory(assetId, days));
}

function portfolioAnalysisAvailable(positions, days = 365) {
  return positions.length > 0 && positions.every(p => analysisAvailable(p.asset.id, days));
}

function unavailableHTML(days = 365) {
  return `<div class="palette-empty">Analyse geblokkeerd: minimaal 90% bron-gedekte koerswaarden over ${days} kalenderdagen nodig. Importeer historie of haal die na toestemming op bij Instellingen.</div>`;
}

/* ---------- helpers ---------- */
function animateValue(el, from, to, fmt, dur = 700) {
  if (prefersReducedMotion) { setValueNow(el, fmt(to)); return; }
  if (el._anim) cancelAnimationFrame(el._anim);
  const t0 = performance.now();
  function frame(t) {
    const p = Math.min(1, (t - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = fmt(from + (to - from) * eased);
    if (p < 1) el._anim = requestAnimationFrame(frame);
    else el._anim = null;
  }
  el._anim = requestAnimationFrame(frame);
}

function setValueNow(el, text) {
  if (el._anim) { cancelAnimationFrame(el._anim); el._anim = null; }
  el.textContent = text;
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 3000);
}

function setAIStatus(text) { $('#ai-status-text').textContent = text; }

function invalidateDerived() {
  state.portfolio = null;
  state.ef = null;
  state.backtest.data = null;
}

/* ============================================================
   NAVIGATIE
   ============================================================ */
$$('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('.nav-item').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const view = btn.dataset.view;
    $$('.view').forEach(v => v.classList.remove('active'));
    $(`#view-${view}`).classList.add('active');
    if (view === 'asset') renderAssetView();
    if (view === 'mllab') renderMLLab();
    if (view === 'backtest') renderBacktestView();
    if (view === 'insights') renderInsights();
    if (view === 'transactions') renderTransactions();
    if (view === 'dca') renderDca();
    if (view === 'settings') renderSettings();
    if (view === 'dashboard') renderDashboard(false);
    updateEmptyOverlay();
  });
});

function gotoView(view) { $(`.nav-item[data-view="${view}"]`).click(); }

/* ============================================================
   SELECTS (opnieuw opbouwen na import)
   ============================================================ */
function rebuildAssetSelects() {
  for (const sel of [$('#asset-select'), $('#tx-asset'), $('#bt-asset'), $('#dca-asset')]) {
    const cur = sel.value;
    sel.innerHTML = '';
    if (sel.id === 'tx-asset') {
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = 'Geen asset / cashrekening';
      sel.appendChild(empty);
    }
    ASSETS.forEach(a => {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = `${a.name} (${a.id})`;
      sel.appendChild(opt);
    });
    if (cur && assetById(cur)) sel.value = cur;
  }
}

/* ============================================================
   DASHBOARD
   ============================================================ */
let prevTotal = 0;
let brushHandle = null;

function renderDashboard(animate = true) {
  ensureCurrentMarketGrid();
  state.portfolio = computePortfolioSeries(state.txs);
  const { values } = state.portfolio;
  const positions = computePositions(state.txs);
  const total = values[values.length - 1];
  const invested = totalInvested(state.txs);
  const todayResult = dailyPortfolioPnl(state.txs, values);
  const dayDelta = todayResult.pnl;
  const dayPct = todayResult.pct * 100;
  const currentReliable = positions.length > 0 && positions.every(p => isReliablePrice(p.asset.id, HISTORY_DAYS - 1));
  const dayReliable = currentReliable && positions.every(p => isObservedPrice(p.asset.id, HISTORY_DAYS - 1) && isObservedPrice(p.asset.id, HISTORY_DAYS - 2));
  const historyReliable = portfolioAnalysisAvailable(positions, 730);
  const totReturn = total - invested;
  const totPct = invested > 0 ? (totReturn / invested) * 100 : 0;
  const moneyWeighted = currentReliable ? portfolioXirr(state.txs, total) : null;

  $('#today-date').textContent = new Intl.DateTimeFormat('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());

  if (animate) animateValue($('#kpi-total'), prevTotal, total, v => fmtEUR.format(v), 900);
  else setValueNow($('#kpi-total'), fmtEUR.format(total));
  prevTotal = total;

  const deltaEl = $('#kpi-total-delta');
  deltaEl.textContent = dayReliable ? `${fmtSignedEUR(dayDelta)} (${fmtPct(dayPct)}) vandaag` : 'dagresultaat niet beschikbaar zonder echte dagkoersen';
  deltaEl.className = 'kpi-delta ' + (dayReliable ? (dayDelta >= 0 ? 'up' : 'down') : 'muted');

  $('#kpi-day').textContent = dayReliable ? fmtSignedEUR(dayDelta) : '—';
  const dayPctEl = $('#kpi-day-pct');
  dayPctEl.textContent = dayReliable ? fmtPct(dayPct) : 'onvoldoende waargenomen dagkoersen';
  dayPctEl.className = 'kpi-delta ' + (dayReliable ? (dayDelta >= 0 ? 'up' : 'down') : 'muted');

  $('#kpi-return').textContent = fmtSignedEUR(totReturn);
  const retEl = $('#kpi-return-pct');
  state.twr = twrSeries(state.txs, values);
  const twrStartBoundary = HISTORY_DAYS - 730;
  const twrStart = state.twr.findIndex((value, index) => index >= twrStartBoundary && value !== null);
  const twrTotal = twrStart >= 0 ? twrBetween(state.twr, twrStart, HISTORY_DAYS - 1) : null;
  const ytdIdx = MARKET.dates.findIndex(d => d.getFullYear() === new Date().getFullYear());
  const twrYtd = ytdIdx >= 0 ? twrBetween(state.twr, Math.max(ytdIdx, state.twr.findIndex(v => v !== null)), HISTORY_DAYS - 1) : null;
  if (twrTotal !== null && historyReliable) {
    retEl.textContent = `TWR ${fmtPct(twrTotal * 100, 1)} (2j)`
      + (moneyWeighted !== null ? ` · XIRR ${fmtPct(moneyWeighted * 100, 1)}/jr` : '')
      + (twrYtd !== null ? ` · YTD ${fmtPct(twrYtd * 100, 1)}` : '');
    retEl.title = 'TWR corrigeert voor externe geldstromen; XIRR is het geannualiseerde geldgewogen rendement op basis van de exacte cashflowdatums.';
    retEl.className = 'kpi-delta ' + (twrTotal >= 0 ? 'up' : 'down');
  } else {
    retEl.textContent = moneyWeighted !== null
      ? `XIRR ${fmtPct(moneyWeighted * 100, 1)}/jr`
      : currentReliable ? `${fmtPct(totPct)} t.o.v. netto-inleg` : 'historisch rendement geblokkeerd';
    retEl.title = currentReliable ? 'XIRR gebruikt de exacte datums en omvang van externe geldstromen; onvoldoende bron-gedekte historie voor TWR.' : 'De huidige waardering bevat gereconstrueerde koersen.';
    retEl.className = 'kpi-delta ' + (currentReliable ? (totReturn >= 0 ? 'up' : 'down') : 'muted');
  }

  $('#kpi-invested').textContent = fmtEUR.format(invested);
  $('#kpi-positions').textContent = `${positions.length} posities · cash ${fmtEUR.format(state.portfolio.cash)}`;

  renderPortfolioChart();
  renderDashboardBrush();
  renderAllocation(positions, total, state.portfolio.cash);
  renderHoldings(positions);
  renderWatchlist();
}

function renderPortfolioChart() {
  const { values } = state.portfolio;
  const { start, end } = state.range;
  const slice = values.slice(start, end + 1);
  const labels = MARKET.dates.slice(start, end + 1);
  const up = slice[slice.length - 1] >= slice[0];

  const reliable = portfolioAnalysisAvailable(computePositions(state.txs), Math.min(730, end - start + 1));
  const series = [{ name: reliable ? 'Portefeuille' : 'Portefeuille (deels gereconstrueerd)', color: up ? '#34d399' : '#fb7185', values: slice, fill: true, width: 2.4 }];
  if (state.showBenchmark) {
    const bench = benchmarkSeries(state.txs, 'VWCE');
    if (bench && reliable && analysisAvailable('VWCE', Math.min(730, end - start + 1))) {
      series.push({ name: 'Alles-in-VWCE', color: '#fbbf24', values: bench.slice(start, end + 1), dash: '6 5', width: 1.8 });
    }
  }
  renderLineChart($('#portfolio-chart'), { labels, series, yFmt: v => compactEUR(v) });
}

function renderDashboardBrush() {
  brushHandle = renderBrush($('#portfolio-brush'), state.portfolio.values, state.range, (s, e) => {
    state.range = { start: s, end: e };
    $$('#tf-selector button').forEach(b => b.classList.remove('active'));
    renderPortfolioChart();
  });
}

$('#tf-selector').addEventListener('click', e => {
  const btn = e.target.closest('button');
  if (!btn) return;
  $$('#tf-selector button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const days = parseInt(btn.dataset.days, 10);
  const n = state.portfolio.values.length;
  state.range = days === 0
    ? { start: 0, end: n - 1 }
    : { start: Math.max(0, n - days), end: n - 1 };
  renderPortfolioChart();
  if (brushHandle) brushHandle.setRange(state.range.start, state.range.end);
});

$('#btn-benchmark').addEventListener('click', () => {
  if (!assetById('VWCE') || !analysisAvailable('VWCE', 730)) { toast('⚠️ Benchmark vereist minimaal 90% bron-gedekte VWCE-historie over twee jaar'); return; }
  state.showBenchmark = !state.showBenchmark;
  $('#btn-benchmark').classList.toggle('on', state.showBenchmark);
  renderPortfolioChart();
});

function renderAllocation(positions, total, cash = 0) {
  // dust-posities (< 1% van totaal) samenvoegen tot "Overig"
  const denominator = Math.max(total, 1e-9);
  const main = positions.filter(p => p.value / denominator >= 0.01);
  const rest = positions.filter(p => p.value / denominator < 0.01);
  const segments = main.map(p => ({ name: p.asset.name, value: p.value, color: p.asset.color }));
  const restSum = rest.reduce((s, p) => s + p.value, 0);
  if (restSum > 0) segments.push({ name: `Overig (${rest.length})`, value: restSum, color: '#5c6580' });
  if (cash > 0.005) segments.push({ name: 'Cash', value: cash, color: '#22d3ee' });
  renderDonut($('#allocation-donut'), $('#allocation-legend'), segments, compactEUR(total));
}

function renderHoldings(positions) {
  const tbody = $('#holdings-table tbody');
  tbody.innerHTML = '';

  // rijen verrijken en sorteren op de gekozen kolom
  const rows = positions.map(p => {
    const prices = MARKET.prices[p.asset.id];
    const reliable = analysisAvailable(p.asset.id, 365);
    const sig = reliable ? computeSignal(prices, state.models[p.asset.id]?.forecastPct ?? null) : { label: '—', score: 0 };
    const day = isObservedPrice(p.asset.id, HISTORY_DAYS - 1) && isObservedPrice(p.asset.id, HISTORY_DAYS - 2)
      ? (prices[prices.length - 1] / prices[prices.length - 2] - 1) * 100 : null;
    return {
      p, sig,
      name: p.asset.name.toLowerCase(),
      price: p.price,
      day: day ?? -Infinity,
      dayDisplay: day,
      qty: p.qty, value: p.value, gainPct: p.gainPct,
      signal: sig.score,
    };
  });
  const { key, dir } = state.holdingsSort;
  rows.sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0) * dir);
  $$('#holdings-head th').forEach(th => {
    th.classList.remove('sorted-asc', 'sorted-desc');
    if (th.dataset.sort === key) th.classList.add(dir === 1 ? 'sorted-asc' : 'sorted-desc');
  });

  for (const row of rows) {
    const p = row.p, sig = row.sig, day = row.dayDisplay;
    const prices = MARKET.prices[p.asset.id];
    const spark = prices.slice(-7);

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><div class="asset-cell">
        <div class="asset-dot" style="background:${p.asset.color}">${escapeHTML(p.asset.id.slice(0, 4))}</div>
        <div><div class="asset-name">${escapeHTML(p.asset.name)}</div><div class="asset-ticker">${escapeHTML(p.asset.id)} · ${escapeHTML(p.asset.type)}</div></div>
      </div></td>
      <td>${fmtEUR2.format(p.price)}</td>
      <td>${day === null ? '<span class="muted">—</span>' : `<span class="pct ${day >= 0 ? 'up' : 'down'}">${fmtPct(day)}</span>`}</td>
      <td>${fmtNum.format(p.qty)}</td>
      <td><b>${fmtEUR.format(p.value)}</b></td>
      <td><span class="pct ${p.gain >= 0 ? 'up' : 'down'}">${fmtSignedEUR(p.gain)}<br><span style="font-size:11px">${fmtPct(p.gainPct, 1)}</span></span></td>
      <td>${sparklineSVG(spark)}</td>
      <td>${sig.label === '—' ? '<span class="muted" title="Onvoldoende bron-gedekte koershistorie">—</span>' : `<span class="signal-badge signal-${sig.label.toLowerCase()}">${sig.label}</span>`}</td>`;
    tr.addEventListener('click', () => {
      state.selectedAsset = p.asset.id;
      gotoView('asset');
    });
    tbody.appendChild(tr);
  }
}

/* ============================================================
   WATCHLIST
   ============================================================ */
const WATCH_KEY = 'vermogen_watchlist_v1';

function loadWatchlist() {
  try {
    const ids = JSON.parse(localStorage.getItem(WATCH_KEY)) || [];
    return new Set(ids.filter(id => assetById(id)));
  } catch (e) { return new Set(); }
}
function saveWatchlist() { localStorage.setItem(WATCH_KEY, JSON.stringify([...state.watchlist])); }

function renderWatchlist() {
  const positions = computePositions(state.txs);
  const held = new Set(positions.map(p => p.asset.id));

  const tbody = $('#watch-table tbody');
  tbody.innerHTML = '';
  $('#watch-empty').style.display = state.watchlist.size ? 'none' : '';
  for (const id of state.watchlist) {
    const a = assetById(id);
    if (!a) continue;
    const prices = MARKET.prices[id];
    const last = prices[prices.length - 1];
    const day = isObservedPrice(id, HISTORY_DAYS - 1) && isObservedPrice(id, HISTORY_DAYS - 2)
      ? (last / prices[prices.length - 2] - 1) * 100 : null;
    const m1 = marketCoverage(id, HISTORY_DAYS - 31) >= ANALYSIS_MIN_COVERAGE ? (last / prices[prices.length - 31] - 1) * 100 : null;
    const m3 = marketCoverage(id, HISTORY_DAYS - 91) >= ANALYSIS_MIN_COVERAGE ? (last / prices[prices.length - 91] - 1) * 100 : null;
    const sig = analysisAvailable(id, 365) ? computeSignal(prices, state.models[id]?.forecastPct ?? null) : null;
    const metric = value => value === null ? '<span class="muted">—</span>' : `<span class="pct ${value >= 0 ? 'up' : 'down'}">${fmtPct(value, 1)}</span>`;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><div class="asset-cell">
        <div class="asset-dot" style="background:${a.color}">${escapeHTML(a.id.slice(0, 4))}</div>
        <div><div class="asset-name">${escapeHTML(a.name)}</div><div class="asset-ticker">${escapeHTML(a.id)} · ${escapeHTML(a.type)}${held.has(id) ? ' · in bezit' : ''}</div></div>
      </div></td>
      <td>${fmtEUR2.format(last)}</td>
      <td>${metric(day)}</td>
      <td>${metric(m1)}</td>
      <td>${metric(m3)}</td>
      <td>${sig ? `<span class="signal-badge signal-${sig.label.toLowerCase()}">${sig.label}</span>` : '<span class="muted">—</span>'}</td>
      <td><button class="tx-del" title="Niet meer volgen">★</button></td>`;
    tr.addEventListener('click', e => {
      if (e.target.closest('.tx-del')) return;
      state.selectedAsset = id;
      gotoView('asset');
    });
    tr.querySelector('.tx-del').addEventListener('click', () => {
      state.watchlist.delete(id);
      saveWatchlist();
      if (a.watchOnly) { removeWatchAsset(id); rebuildAssetSelects(); }
      renderWatchlist();
      toast(`☆ ${a.name} verwijderd uit watchlist`);
    });
    tbody.appendChild(tr);
  }
}

/* ---------- watchlist-zoekveld met suggesties ---------- */
function addToWatch(id) {
  state.watchlist.add(id);
  saveWatchlist();
  renderWatchlist();
  toast(`★ ${assetById(id).name} toegevoegd aan watchlist`);
}

async function addEntryToWatch(entry) {
  toast(`📡 Koersdata ophalen voor ${entry.name}…`);
  const result = await addWatchAsset(entry);
  if (!result.ok) { toast('⚠️ ' + result.error); return; }
  rebuildAssetSelects();
  addToWatch(entry.id);
}

async function searchCryptoAndWatch(query) {
  if (!networkConsentEnabled()) { toast('⚠️ Sta eerst externe koersdata toe bij Instellingen'); return; }
  try {
    const res = await fetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(query)}`, { credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!res.ok) throw new Error('Netwerkfout');
    const data = await res.json();
    const coin = data.coins?.[0];
    if (!coin) { toast(`⚠️ Geen crypto gevonden voor "${query}"`); return; }
    await addEntryToWatch({ id: normalizeAssetId(coin.symbol), name: cleanDisplayText(coin.name, 80), type: 'Crypto', cg: cleanDisplayText(coin.id, 100) });
  } catch (e) { toast('⚠️ CoinGecko-zoekopdracht mislukt'); }
}

function buildWatchSuggestions(q) {
  const ql = q.trim().toLowerCase();
  if (!ql) return [];
  const held = new Set(computePositions(state.txs).map(p => p.asset.id));
  const out = [];
  for (const a of ASSETS) {
    if (state.watchlist.has(a.id)) continue;
    if (a.id.toLowerCase().includes(ql) || a.name.toLowerCase().includes(ql)) {
      out.push({ icon: '◉', label: `${a.name} (${a.id})`, type: a.type + (held.has(a.id) ? ' · in bezit' : ''), run: () => addToWatch(a.id) });
    }
  }
  for (const c of CATALOG) {
    if (assetById(c.id) || state.watchlist.has(c.id)) continue;
    if (c.id.toLowerCase().includes(ql) || c.name.toLowerCase().includes(ql)) {
      out.push({ icon: '★', label: `${c.name} (${c.id})`, type: c.type + ' · catalogus', run: () => addEntryToWatch(c) });
    }
  }
  const t = q.trim().toUpperCase();
  if (/^[A-Z0-9.\-]{1,10}$/.test(t)) {
    out.push({ icon: '🔎', label: `Zoek ticker "${t}" op de beurs`, type: 'Yahoo Finance', run: () => addEntryToWatch({ id: t, name: t, type: 'Aandeel' }) });
  }
  if (ql.length >= 3) {
    out.push({ icon: '🔎', label: `Zoek "${q.trim()}" als crypto`, type: 'CoinGecko', run: () => searchCryptoAndWatch(q.trim()) });
  }
  return out.slice(0, 8);
}

{
  const input = $('#watch-search');
  const box = $('#watch-suggest');
  let items = [], timer = null;

  function renderSuggest() {
    if (!items.length) { box.style.display = 'none'; return; }
    box.style.display = '';
    box.innerHTML = items.map((it, i) => `
      <div class="suggest-item" data-i="${i}">
        <span>${escapeHTML(it.icon)}</span>${escapeHTML(it.label)}<span class="s-type">${escapeHTML(it.type)}</span>
      </div>`).join('');
    box.querySelectorAll('.suggest-item').forEach(el => {
      el.addEventListener('mousedown', e => { // mousedown: vóór blur
        e.preventDefault();
        box.style.display = 'none';
        input.value = '';
        items[+el.dataset.i].run();
      });
    });
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { items = buildWatchSuggestions(input.value); renderSuggest(); }, 200);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && items.length) {
      box.style.display = 'none';
      const it = items[0];
      input.value = '';
      it.run();
    } else if (e.key === 'Escape') { box.style.display = 'none'; }
  });
  input.addEventListener('blur', () => setTimeout(() => { box.style.display = 'none'; }, 150));
  input.addEventListener('focus', () => { if (items.length && input.value.trim()) renderSuggest(); });
}

/* ============================================================
   ASSET ANALYSE
   ============================================================ */
const assetSelect = $('#asset-select');
assetSelect.addEventListener('change', () => {
  state.selectedAsset = assetSelect.value;
  renderAssetView();
});

$('#btn-retrain').addEventListener('click', () => {
  delete state.models[state.selectedAsset];
  renderAssetView();
});

$('#chart-mode').addEventListener('click', e => {
  const btn = e.target.closest('button');
  if (!btn) return;
  $$('#chart-mode button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  state.chartMode = btn.dataset.mode;
  renderAssetView();
});

function renderAssetView() {
  if (!ASSETS.length) return;
  ensureCurrentMarketGrid();
  const asset = assetById(state.selectedAsset) || ASSETS[0];
  state.selectedAsset = asset.id;
  assetSelect.value = asset.id;
  const prices = MARKET.prices[asset.id];
  const last = prices[prices.length - 1];
  const day = isObservedPrice(asset.id, HISTORY_DAYS - 1) && isObservedPrice(asset.id, HISTORY_DAYS - 2)
    ? (last / prices[prices.length - 2] - 1) * 100
    : null;

  $('#asset-title').textContent = asset.name;
  $('#asset-subtitle').textContent = `${asset.id} · ${asset.type}${asset.custom ? ' · geïmporteerd' : ''}`;
  $('#a-price').textContent = fmtEUR2.format(last);
  const dayEl = $('#a-day');
  dayEl.textContent = day === null ? 'dagresultaat niet beschikbaar' : fmtPct(day) + ' vandaag';
  dayEl.className = 'kpi-delta ' + (day === null ? 'muted' : day >= 0 ? 'up' : 'down');
  const reliable = analysisAvailable(asset.id, 500);
  $('#a-vol').textContent = reliable ? (annualizedVol(prices) * 100).toFixed(1).replace('.', ',') + '%' : '—';

  const r = rsi(prices, 14);
  const lastRsi = r[r.length - 1];
  $('#a-rsi').textContent = reliable ? lastRsi.toFixed(0) : '—';
  const rsiLabel = $('#a-rsi-label');
  rsiLabel.textContent = reliable ? (lastRsi > 70 ? 'overbought' : lastRsi < 30 ? 'oversold' : 'neutraal') : historyCoverageLabel(asset.id, 500);
  rsiLabel.className = 'kpi-delta ' + (reliable && lastRsi > 70 ? 'down' : reliable && lastRsi < 30 ? 'up' : 'muted');

  renderCompareChips();
  if (!reliable) {
    if (state.training) { state.training.cancel(); state.training = null; }
    delete state.models[asset.id];
    const histDays = 240;
    renderLineChart($('#asset-chart'), {
      labels: MARKET.dates.slice(-histDays),
      series: [{ name: asset.name, color: asset.color, values: prices.slice(-histDays), fill: true, width: 2.2 }],
      yFmt: v => compactEUR(v),
    });
    $('#forecast-note').innerHTML = `⚠️ <b>Alleen koersweergave:</b> ${historyCoverageLabel(asset.id, 500)} over de laatste 500 dagen. ML, indicatoren en signalen vereisen minimaal 90% bron-gedekte historie.`;
    $('#rsi-chart').innerHTML = unavailableHTML(500);
    $('#macd-chart').innerHTML = unavailableHTML(500);
    $('#a-signal').textContent = '—';
    $('#a-signal-conf').textContent = 'onvoldoende bron-gedekte historie';
    setAIStatus('analyse geblokkeerd');
    return;
  }
  renderRsiChart(prices);
  renderMacdChart(prices);

  if (state.models[asset.id] || state.chartMode !== 'line') {
    drawAssetChart(asset, state.models[asset.id] || null);
    updateSignalUI(asset, state.models[asset.id] || null);
    if (!state.models[asset.id]) trainAssetModel(asset);
  } else {
    drawAssetChart(asset, null);
    updateSignalUI(asset, null);
    trainAssetModel(asset);
  }
}

function renderCompareChips() {
  const holder = $('#compare-chips');
  if (state.chartMode !== 'compare') { holder.style.display = 'none'; return; }
  holder.style.display = 'flex';
  holder.innerHTML = '';
  for (const a of ASSETS) {
    const on = a.id === state.selectedAsset || state.compareSet.has(a.id);
    const chip = document.createElement('button');
    chip.className = 'chip' + (on ? ' on' : '');
    if (on) chip.style.background = a.color;
    chip.textContent = a.id;
    chip.addEventListener('click', () => {
      if (a.id === state.selectedAsset) return; // basis-asset blijft aan
      if (state.compareSet.has(a.id)) state.compareSet.delete(a.id);
      else state.compareSet.add(a.id);
      renderAssetView();
    });
    holder.appendChild(chip);
  }
}

function trainAssetModel(asset) {
  if (!analysisAvailable(asset.id, 500)) {
    setAIStatus('analyse geblokkeerd');
    return;
  }
  if (state.training) state.training.cancel();
  const prices = MARKET.prices[asset.id];
  setAIStatus(`traint op ${asset.id}…`);

  state.training = trainNetworkAsync(prices.slice(-500), {
    epochs: 120,
    seed: (asset.seed || 1) + 7,
    onProgress: () => {},
    onDone: (model) => {
      state.training = null;
      const fc = forecastPrices(model, prices[prices.length - 1], 30);
      const forecastPct = (fc.median[fc.median.length - 1] / prices[prices.length - 1] - 1) * 100;
      const full = { ...model, forecast: fc, forecastPct };
      state.models[asset.id] = full;
      setAIStatus('model actief ✓');
      if (state.selectedAsset === asset.id && $('#view-asset').classList.contains('active')) {
        drawAssetChart(asset, full);
        updateSignalUI(asset, full);
      }
    },
  });
}

function drawAssetChart(asset, model) {
  const histDays = 240;
  const prices = MARKET.prices[asset.id];
  const hist = prices.slice(-histDays);
  const labels = MARKET.dates.slice(-histDays);
  const note = $('#forecast-note');

  /* ---- candles-modus ---- */
  if (state.chartMode === 'candles') {
    const n = 100;
    renderCandles($('#asset-chart'), {
      dates: MARKET.dates.slice(-n),
      candles: synthOHLC(prices.slice(-n - 1), asset.seed || 3).slice(1),
      yFmt: v => compactEUR(v),
    });
    note.innerHTML = `🕯️ <b>Afgeleide candlesticks</b> (100 dagen): alleen slotkoersen zijn brondata; open/hoog/laag zijn indicatief uit opeenvolgende slotkoersen opgebouwd. Schakel terug naar <b>Lijn</b> voor de ML-projectie.`;
    return;
  }

  /* ---- vergelijk-modus ---- */
  if (state.chartMode === 'compare') {
    const ids = [asset.id, ...state.compareSet].filter(id => assetById(id));
    const series = ids.map(id => {
      const a = assetById(id);
      const p = MARKET.prices[id].slice(-histDays);
      return { name: a.id, color: a.color, values: p.map(v => (v / p[0]) * 100), width: 2 };
    });
    renderLineChart($('#asset-chart'), { labels, series, yFmt: v => v.toFixed(0) });
    note.innerHTML = `📊 <b>Vergelijkingsmodus</b> — alle koersen geïndexeerd op 100 bij de start (240 dagen geleden). Klik op de tickers hierboven om assets toe te voegen of te verwijderen.`;
    return;
  }

  /* ---- lijn-modus (+ forecast + anomalieën) ---- */
  const anomalies = detectAnomalies(prices.slice(-histDays - 1), 3)
    .map(a => ({ index: a.index - 1, color: '#fbbf24', z: a.z }))
    .filter(a => a.index >= 0 && a.index < histDays);

  const series = [{ name: asset.name, color: asset.color, values: [...hist], fill: true, width: 2.2 }];
  let band = null;
  let allLabels = labels;

  if (model) {
    const lastDate = labels[labels.length - 1];
    const fcLabels = [];
    for (let i = 1; i <= model.forecast.median.length; i++) {
      const d = new Date(lastDate);
      d.setDate(d.getDate() + i);
      fcLabels.push(d);
    }
    allLabels = [...labels, ...fcLabels];
    series[0].values = [...hist, ...new Array(model.forecast.median.length).fill(null)];
    series.push({
      name: 'AI-voorspelling', color: '#c4b5fd',
      values: [...new Array(histDays - 1).fill(null), hist[hist.length - 1], ...model.forecast.median],
      dash: '6 5', width: 2,
    });
    band = {
      upper: [hist[hist.length - 1], ...model.forecast.upper],
      lower: [hist[hist.length - 1], ...model.forecast.lower],
      color: 'rgba(124,107,255,0.14)',
      offset: histDays - 1,
    };
  }

  renderLineChart($('#asset-chart'), { labels: allLabels, series, band, yFmt: v => compactEUR(v), markers: anomalies });

  const anomTxt = anomalies.length
    ? ` <b>${anomalies.length} anomalie${anomalies.length > 1 ? 'ën' : ''}</b> gemarkeerd (gele stippen): dagen met een rendement van meer dan 3 standaarddeviaties — vaak nieuws-events.`
    : '';
  if (model) {
    const pct = model.forecastPct;
    note.innerHTML =
      `🧠 <b>AI-voorspelling (30 dagen):</b> het neurale netwerk verwacht een koers rond <b>${fmtEUR2.format(model.forecast.median[model.forecast.median.length - 1])}</b> ` +
      `(<b class="${pct >= 0 ? 'pct up' : 'pct down'}">${fmtPct(pct, 1)}</b>). ` +
      `De paarse band is een indicatieve residuband, geen gekalibreerd betrouwbaarheidsinterval. Getraind op ${model.samples} samples · eind-loss ${model.losses[model.losses.length - 1].toFixed(4)}.` +
      anomTxt + ` <i>Experimenteel — geen beleggingsadvies.</i>`;
  } else {
      note.innerHTML = `⏳ Het neurale netwerk traint nu op <b>${escapeHTML(asset.name)}</b> — de voorspelling verschijnt zodra de training klaar is…` + anomTxt;
  }
}

function updateSignalUI(asset, model) {
  const prices = MARKET.prices[asset.id];
  const sig = computeSignal(prices, model?.forecastPct ?? null);
  $('#a-signal').innerHTML = `<span class="signal-badge signal-${sig.label.toLowerCase()}">${sig.label}</span>`;
  $('#a-signal-conf').textContent = model
    ? `${sig.strength}% signaalsterkte · incl. NN`
    : `${sig.strength}% signaalsterkte · technisch`;
  $('#a-signal-conf').className = 'kpi-delta muted';
}

function renderRsiChart(prices) {
  const days = 240;
  const r = rsi(prices, 14).slice(-days);
  const labels = MARKET.dates.slice(-days);
  renderLineChart($('#rsi-chart'), {
    labels,
    series: [
      { name: 'RSI', color: '#22d3ee', values: r, width: 1.8 },
      { name: null, color: 'rgba(251,113,133,0.45)', values: new Array(days).fill(70), dash: '4 4', width: 1 },
      { name: null, color: 'rgba(52,211,153,0.45)', values: new Array(days).fill(30), dash: '4 4', width: 1 },
    ],
    yMin: 0, yMax: 100,
    yFmt: v => Math.round(v),
  });
}

function renderMacdChart(prices) {
  const days = 240;
  const { macdLine, signal } = macd(prices);
  const labels = MARKET.dates.slice(-days);
  renderLineChart($('#macd-chart'), {
    labels,
    series: [
      { name: 'MACD', color: '#7c6bff', values: macdLine.slice(-days), width: 1.8 },
      { name: 'Signaal', color: '#fbbf24', values: signal.slice(-days), width: 1.5, dash: '3 3' },
    ],
    yFmt: v => v.toFixed(1),
  });
}

/* ============================================================
   ML LAB
   ============================================================ */
let labTraining = null;

function renderMLLab() {
  if (!ASSETS.length) return;
  const asset = assetById(state.selectedAsset) || ASSETS[0];
  $('#nn-asset-name').textContent = asset.name;
  $('#arena-asset-name').textContent = asset.name;
  const rng = mulberry32(7);
  renderNetworkViz($('#nn-viz'), new NeuralNet([20, 24, 12, 1], rng));
  renderLossChart([]);
  runMonteCarlo();
}

function renderLossChart(losses) {
  const holder = $('#loss-chart');
  if (!losses.length) {
    holder.innerHTML = '<div style="display:grid;place-items:center;height:100%;color:#5c6580;font-size:13px">Druk op ▶ Start training om het netwerk live te trainen</div>';
    return;
  }
  renderLineChart(holder, {
    labels: losses.map((_, i) => `e${i + 1}`),
    series: [{ name: 'loss', color: '#fb7185', values: losses, fill: true, width: 2 }],
    yFmt: v => v.toFixed(3),
    yMin: 0,
  });
}

$('#btn-train').addEventListener('click', () => {
  if (labTraining) { labTraining.cancel(); labTraining = null; }
  const asset = assetById(state.selectedAsset) || ASSETS[0];
  if (!analysisAvailable(asset.id, 500)) { toast('⚠️ Training vereist minimaal 90% bron-gedekte historie over 500 dagen'); return; }
  const prices = MARKET.prices[asset.id];
  const btn = $('#btn-train');
  btn.textContent = '⏳ Trainen…';
  btn.disabled = true;
  setAIStatus(`traint op ${asset.id}…`);
  const epochs = 150;

  labTraining = trainNetworkAsync(prices.slice(-500), {
    epochs,
    seed: (asset.seed || 1) + 1,
    onProgress: (epoch, losses, net) => {
      $('#nn-epoch').textContent = `${epoch} / ${epochs}`;
      $('#nn-loss').textContent = losses[losses.length - 1]?.toFixed(4) ?? '—';
      renderLossChart(losses);
      renderNetworkViz($('#nn-viz'), net);
    },
    onDone: (model) => {
      labTraining = null;
      $('#nn-samples').textContent = `${model.samples} samples`;
      btn.textContent = '▶ Start training';
      btn.disabled = false;
      setAIStatus('model actief ✓');
      toast(`🧠 Netwerk getraind op ${asset.name} — loss ${model.losses[model.losses.length - 1].toFixed(4)}`);
      const fc = forecastPrices(model, prices[prices.length - 1], 30);
      const forecastPct = (fc.median[fc.median.length - 1] / prices[prices.length - 1] - 1) * 100;
      state.models[asset.id] = { ...model, forecast: fc, forecastPct };
    },
  });
  $('#nn-samples').textContent = '—';
});

/* ---------- model-arena ---------- */
$('#btn-arena').addEventListener('click', () => {
  const asset = assetById(state.selectedAsset) || ASSETS[0];
  const holder = $('#arena-results');
  if (!analysisAvailable(asset.id, 500)) { holder.innerHTML = unavailableHTML(500); return; }
  holder.innerHTML = '<div class="palette-empty">⚔ De drie modellen trainen en strijden nu…</div>';
  setTimeout(() => {
    let arena;
    try { arena = modelArena(MARKET.prices[asset.id].slice(-500)); }
    catch (e) { holder.innerHTML = `<div class="palette-empty">${escapeHTML(e.message)}</div>`; return; }
    const colors = { 'Neuraal netwerk': 'linear-gradient(90deg,#7c6bff,#22d3ee)', 'Ridge-regressie': 'linear-gradient(90deg,#22d3ee,#34d399)', 'Naïef momentum': 'linear-gradient(90deg,#5c6580,#9aa3bd)' };
    holder.innerHTML = `
      <div class="arena-grid">
        <div class="arena-col"><h3>Richting goed voorspeld (hit-rate)</h3><div id="arena-hit" class="bars-holder"></div></div>
        <div class="arena-col"><h3>Gemiddelde fout (MAE, lager = beter)</h3><div id="arena-mae" class="bars-holder"></div></div>
      </div>
      <div class="arena-verdict" id="arena-verdict"></div>`;
    renderMetricBars($('#arena-hit'), arena.results.map(r => ({
      name: r.name, value: r.hit, display: r.hit.toFixed(0) + '%', color: colors[r.name],
    })));
    renderMetricBars($('#arena-mae'), arena.results.map(r => ({
      name: r.name, value: r.mae, display: r.mae.toFixed(3), color: colors[r.name],
    })));
    const nn = arena.results[0], naive = arena.results[2];
    const verdict = nn.hit > naive.hit + 2
      ? `Het neurale netwerk voorspelt de richting in <b>${nn.hit.toFixed(0)}%</b> van de ${arena.testDays} out-of-sample dagen goed over ${arena.folds} folds — beter dan naïef momentum (${naive.hit.toFixed(0)}%). Dat is een bescheiden historische voorsprong, geen garantie.`
      : nn.hit > naive.hit - 2
        ? `Het verschil tussen het neurale netwerk (${nn.hit.toFixed(0)}%) en naïef momentum (${naive.hit.toFixed(0)}%) is verwaarloosbaar over ${arena.testDays} testdagen. Eerlijke les: koersvoorspelling is bruut moeilijk, en complexiteit is geen garantie.`
        : `Naïef momentum (${naive.hit.toFixed(0)}%) verslaat het neurale netwerk (${nn.hit.toFixed(0)}%) op deze ${arena.testDays} testdagen. Dit heet overfitting — het netwerk leerde patronen die niet generaliseren. Daarom is walk-forward validatie onmisbaar.`;
    $('#arena-verdict').innerHTML = `🏛️ <b>Oordeel:</b> ${verdict}`;
  }, 60);
});

/* ---------- Monte Carlo ---------- */
function mcParams() {
  return {
    years: parseInt($('#mc-years').value, 10),
    monthly: parseInt($('#mc-monthly').value, 10),
    sims: parseInt($('#mc-sims').value, 10),
  };
}

function runMonteCarlo() {
  const { years, monthly, sims } = mcParams();
  $('#mc-years-label').textContent = `${years} jaar`;
  $('#mc-monthly-label').textContent = fmtEUR.format(monthly);
  $('#mc-sims-label').textContent = sims;

  if (!state.portfolio) state.portfolio = computePortfolioSeries(state.txs);
  const values = state.portfolio.values;
  const startValue = values[values.length - 1];
  const positions = computePositions(state.txs);
  if (startValue <= 0 || !portfolioAnalysisAvailable(positions, 730)) {
    $('#mc-meta').textContent = 'onvoldoende bron-gedekte historie';
    $('#mc-results').innerHTML = unavailableHTML(730);
    const ctx = $('#mc-canvas').getContext('2d');
    ctx.clearRect(0, 0, $('#mc-canvas').width, $('#mc-canvas').height);
    return;
  }

  const adjusted = cashflowAdjustedReturns(state.txs, values).returns.slice(-731);
  const rets = adjusted.filter(r => Number.isFinite(r) && r > -1).map(r => Math.log1p(r));
  const mean = rets.reduce((s, r) => s + r, 0) / (rets.length || 1);
  const std = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length || 1));
  const mu = Math.max(-0.1, Math.min(0.14, mean * CALENDAR_DAYS_PER_YEAR * 0.6));
  const sigma = Math.max(0.08, Math.min(0.45, std * Math.sqrt(CALENDAR_DAYS_PER_YEAR)));

  const mc = monteCarlo({ startValue, monthly, years, sims, mu, sigma });
  renderMonteCarlo($('#mc-canvas'), mc, startValue);

  $('#mc-meta').textContent = `μ ${(mu * 100).toFixed(1).replace('.', ',')}% · σ ${(sigma * 100).toFixed(1).replace('.', ',')}% (cashflow-gecorrigeerd; historisch scenario)`;

  const last = mc.bands;
  const end = i => last[i][last[i].length - 1];
  $('#mc-results').innerHTML = `
    <div class="mc-result"><div class="mc-r-label">Pessimistisch (p5)</div><div class="mc-r-val" style="color:var(--red)">${compactEUR(end('p5'))}</div></div>
    <div class="mc-result"><div class="mc-r-label">Verwacht (mediaan)</div><div class="mc-r-val" style="color:var(--accent-2)">${compactEUR(end('p50'))}</div></div>
    <div class="mc-result"><div class="mc-r-label">Optimistisch (p95)</div><div class="mc-r-val" style="color:var(--green)">${compactEUR(end('p95'))}</div></div>`;
}

['mc-years', 'mc-monthly', 'mc-sims'].forEach(id => {
  $(`#${id}`).addEventListener('input', () => {
    clearTimeout(state.mcTimer);
    state.mcTimer = setTimeout(runMonteCarlo, 60);
  });
});

/* ============================================================
   BACKTEST
   ============================================================ */
const btAsset = $('#bt-asset');
btAsset.addEventListener('change', () => { runBacktest(false); });
$('#bt-threshold').addEventListener('input', () => { runBacktest(false); });
$('#bt-play').addEventListener('click', () => runBacktest(true));

function renderBacktestView() {
  if (!ASSETS.length) return;
  if (!btAsset.value) btAsset.value = state.selectedAsset;
  runBacktest(false);
}

function runBacktest(animate) {
  if (!ASSETS.length) return;
  if (state.backtest.playing) { state.backtest.playing.cancel(); state.backtest.playing = null; }
  const assetId = btAsset.value || state.selectedAsset;
  if (!analysisAvailable(assetId, 730)) {
    $('#bt-metrics tbody').innerHTML = '';
    $('#bt-verdict').innerHTML = unavailableHTML(730);
    $('#bt-tune-result').innerHTML = '';
    const ctx = $('#bt-canvas').getContext('2d');
    ctx.clearRect(0, 0, $('#bt-canvas').width, $('#bt-canvas').height);
    return;
  }
  const threshold = parseFloat($('#bt-threshold').value);
  $('#bt-threshold-label').textContent = threshold.toFixed(2).replace('.', ',');

  const bt = computeBacktest(assetId, { threshold });
  state.backtest.data = bt;

  // resultaten-tabel: B&H + alle strategieën
  const tbody = $('#bt-metrics tbody');
  const pctCell = (v, digits = 1) => `<span class="pct ${v >= 0 ? 'up' : 'down'}">${fmtPct(v, digits)}</span>`;
  const rows = [
    { name: 'Kopen & vasthouden', color: '#9aa3bd', m: { ...bt.bhMetrics, trades: 0, winRate: null, exposure: 100 } },
    ...bt.strategies.map(s => ({ name: s.name, color: s.color, m: s.metrics })),
  ];
  tbody.innerHTML = rows.map(r => `
    <tr style="cursor:default">
      <td><span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${r.color};margin-right:9px"></span><b>${r.name}</b></td>
      <td>${pctCell(r.m.ret)}</td>
      <td>${r.name === 'Kopen & vasthouden' ? '—' : pctCell(r.m.ret - bt.bhMetrics.ret)}</td>
      <td style="color:var(--red)">−${r.m.dd.toFixed(1).replace('.', ',')}%</td>
      <td>${r.m.sharpe.toFixed(2).replace('.', ',')}</td>
      <td>${r.m.trades}</td>
      <td>${r.m.winRate === null ? '—' : r.m.winRate.toFixed(0) + '%'}</td>
      <td>${r.m.exposure.toFixed(0)}%</td>
    </tr>`).join('');

  const canvas = $('#bt-canvas');
  if (animate) {
    $('#bt-play').textContent = '⏳ Speelt af…';
    $('#bt-play').disabled = true;
    state.backtest.playing = playBacktest(canvas, bt, {
      speed: 4,
      onDone: () => {
        $('#bt-play').textContent = '▶ Afspelen';
        $('#bt-play').disabled = false;
        state.backtest.playing = null;
      },
    });
  } else {
    drawBacktestChart(canvas, bt);
  }

  // oordeel
  const a = assetById(assetId);
  const bh = bt.bhMetrics;
  const best = [...bt.strategies].sort((x, y) => y.metrics.ret - x.metrics.ret)[0];
  const bestSharpe = [...bt.strategies].sort((x, y) => y.metrics.sharpe - x.metrics.sharpe)[0];
  const verdicts = [];

  if (best.metrics.ret > bh.ret + 5) {
    verdicts.push({ icon: '🏆', text: `<b>${best.name} wint op rendement:</b> ${fmtPct(best.metrics.ret, 1)} tegenover ${fmtPct(bh.ret, 1)} voor kopen-en-vasthouden op ${a.name}. Let wel: één backtest is geen bewijs — het kan periode-geluk zijn.` });
  } else {
    verdicts.push({ icon: '🪑', text: `<b>Op puur rendement wint stilzitten (${fmtPct(bh.ret, 1)})</b> of is het verschil klein. Dat is geen bug maar een les: in trendmarkten is elk uitstapmoment een gemiste kans, en elke trade kost geld.` });
  }

  if (bestSharpe.metrics.sharpe > bh.sharpe + 0.1 || bestSharpe.metrics.dd < bh.dd - 3) {
    verdicts.push({ icon: '🛡️', text: `<b>Maar kijk naar risico:</b> ${bestSharpe.name} haalt een Sharpe van ${bestSharpe.metrics.sharpe.toFixed(2)} (markt: ${bh.sharpe.toFixed(2)}) met een max. drawdown van −${bestSharpe.metrics.dd.toFixed(1)}% (markt: −${bh.dd.toFixed(1)}%). Hetzelfde of iets minder rendement met véél minder diepe dalen — dát is waar deze strategieën goed in zijn.` });
  }

  const klassiek = bt.strategies[0], hyst = bt.strategies[1];
  if (hyst.metrics.trades < klassiek.metrics.trades) {
    verdicts.push({ icon: '🔇', text: `<b>Hysterese in actie:</b> ${hyst.metrics.trades} trades in plaats van ${klassiek.metrics.trades} bij klassiek. Minder heen-en-weer gehandel rond de drempel = minder kosten en minder whipsaw-verliezen.` });
  }
  verdicts.push({ icon: '🎛️', text: `Schuif aan de <b>signaaldrempel</b> en zie hoe de resultaten verspringen. Als een strategie alleen werkt bij precies één drempelwaarde, heb je geen strategie maar een toevalstreffer (overfitting). Robuuste strategieën blijven redelijk over een héle range van drempels.` });
  $('#bt-verdict').innerHTML = verdicts.map(v => `<div class="ai-insight"><div class="ai-icon">${v.icon}</div><div>${v.text}</div></div>`).join('');
}

/* ============================================================
   INZICHTEN
   ============================================================ */
function renderInsights() {
  if (!state.portfolio) state.portfolio = computePortfolioSeries(state.txs);
  const positions = computePositions(state.txs);
  if (!positions.length) return;
  const total = state.portfolio.values[HISTORY_DAYS - 1];

  const weights = positions.map(p => p.value / total);
  const hhi = weights.reduce((s, w) => s + w * w, 0);
  const nAssets = positions.length;
  const divScore = nAssets > 1 ? Math.round((1 - (hhi - 1 / nAssets) / (1 - 1 / nAssets)) * 100) : 0;

  $('#i-div').textContent = divScore + '/100';
  const divLabel = $('#i-div-label');
  divLabel.textContent = divScore > 70 ? 'goed gespreid' : divScore > 45 ? 'kan beter' : 'geconcentreerd';
  divLabel.className = 'kpi-delta ' + (divScore > 70 ? 'up' : divScore > 45 ? 'muted' : 'down');

  renderStressButtons(positions);
  renderReturnBars($('#returns-bars'), positions.map(p => ({ name: p.asset.id, pct: p.gainPct })));

  if (!portfolioAnalysisAvailable(positions, 730)) {
    $('#i-vol').textContent = '—';
    $('#i-sharpe').textContent = '—';
    $('#i-dd').textContent = '—';
    $('#i-sharpe-label').textContent = 'onvoldoende bron-gedekte historie';
    $('#i-sharpe-label').className = 'kpi-delta muted';
    $('#ef-advice').innerHTML = unavailableHTML(730);
    $('#corr-heatmap').innerHTML = unavailableHTML(730);
    $('#twr-bars').innerHTML = unavailableHTML(730);
    $('#scatter-chart').innerHTML = unavailableHTML(730);
    $('#ai-insights').innerHTML = unavailableHTML(730);
    state.ef = null;
    return;
  }

  const adjusted = cashflowAdjustedReturns(state.txs, state.portfolio.values).returns.slice(-731);
  const rets = adjusted.filter(r => Number.isFinite(r));
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const vol = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length * CALENDAR_DAYS_PER_YEAR);
  const sharpe = sharpeFromReturns(rets);
  const wealth = cumulativeFromReturns(adjusted).filter(v => Number.isFinite(v));
  const mdd = maxDrawdown(wealth);

  $('#i-vol').textContent = (vol * 100).toFixed(1).replace('.', ',') + '%';
  $('#i-sharpe').textContent = sharpe.toFixed(2).replace('.', ',');
  const shLabel = $('#i-sharpe-label');
  shLabel.textContent = sharpe > 1.5 ? 'uitstekend' : sharpe > 1 ? 'goed' : sharpe > 0.5 ? 'redelijk' : 'matig';
  shLabel.className = 'kpi-delta ' + (sharpe > 1 ? 'up' : sharpe > 0.5 ? 'muted' : 'down');
  $('#i-dd').textContent = '−' + (mdd * 100).toFixed(1).replace('.', ',') + '%';
  renderFrontierSection(positions);
  renderCorrelation(positions);

  if (!state.twr) state.twr = twrSeries(state.txs, state.portfolio.values);
  const years = twrPerYear(state.twr, HISTORY_DAYS - 730);
  if (years.length) renderReturnBars($('#twr-bars'), years.map(y => ({ name: String(y.year), pct: y.pct })));

  const points = positions.map(p => {
    const prices = MARKET.prices[p.asset.id];
    return {
      name: p.asset.id,
      x: annualizedVol(prices) * 100,
      y: annualizedReturn(prices) * 100,
      r: 8 + Math.sqrt(p.value / total) * 26,
      color: p.asset.color,
    };
  });
  renderScatter($('#scatter-chart'), points, v => v.toFixed(0) + '%', v => v.toFixed(0) + '%');

  renderAIInsights(positions, total, { vol, sharpe, mdd, divScore, hhi });
}

/* ---------- efficient frontier ---------- */
function renderFrontierSection(positions) {
  const canvas = $('#ef-canvas');
  const advice = $('#ef-advice');
  if (positions.length < 2) {
    advice.innerHTML = '<div class="palette-empty">Minimaal 2 posities nodig voor portefeuille-optimalisatie.</div>';
    return;
  }
  if (!state.ef) state.ef = efficientFrontier(positions);
  const ef = state.ef;
  renderFrontier(canvas, {
    points: ef.points, frontier: ef.frontier, current: ef.current, maxSharpe: ef.maxSharpe,
    onPick: (pt) => showRebalanceAdvice(ef, pt),
  });
}

$('#btn-max-sharpe').addEventListener('click', () => {
  if (state.ef) showRebalanceAdvice(state.ef, state.ef.maxSharpe);
});

function showRebalanceAdvice(ef, target) {
  const rows = rebalanceAdvice(ef, target);
  const advice = $('#ef-advice');
  const head = `
    <div class="advice-head">
      <span>🎯 Gekozen portefeuille: <b>μ ${(target.mu * 100).toFixed(1).replace('.', ',')}%</b> verwacht rendement · <b>σ ${(target.sig * 100).toFixed(1).replace('.', ',')}%</b> risico · Sharpe <b>${target.sharpe.toFixed(2).replace('.', ',')}</b></span>
      <span style="color:var(--text-3)">(nu: μ ${(ef.current.mu * 100).toFixed(1).replace('.', ',')}% · σ ${(ef.current.sig * 100).toFixed(1).replace('.', ',')}% · Sharpe ${ef.current.sharpe.toFixed(2).replace('.', ',')})</span>
    </div>`;
  if (!rows.length) {
    advice.innerHTML = head + '<div class="palette-empty">Je zit al vrijwel op deze verdeling — geen transacties nodig.</div>';
    return;
  }
  advice.innerHTML = head + `
    <table class="advice-table">
      <thead><tr><th>Actie</th><th>Asset</th><th>Bedrag</th><th>≈ Aantal</th><th>Weging</th></tr></thead>
      <tbody>${rows.map(r => `
        <tr>
          <td><span class="tx-badge ${r.action === 'Koop' ? 'tx-buy' : 'tx-sell'}">${r.action}</span></td>
          <td><b>${r.asset.name}</b> <span style="color:var(--text-3)">(${r.asset.id})</span></td>
          <td><b>${fmtEUR.format(r.amount)}</b></td>
          <td>${fmtNum.format(+r.qty.toFixed(4))}</td>
          <td>${r.fromPct.toFixed(0)}% → <b>${r.toPct.toFixed(0)}%</b></td>
        </tr>`).join('')}
      </tbody>
    </table>
    <p class="explain">Gebaseerd op historische rendementen en covariantie (2 jaar) — de toekomst kan anders zijn. Geen beleggingsadvies.</p>`;
}

/* ---------- correlatie ---------- */
function renderCorrelation(positions) {
  const ids = positions.map(p => p.asset.id);
  const corr = correlationMatrix(ids);
  renderHeatmap($('#corr-heatmap'), ids, corr);
  // hoogste paar bewaren voor AI-observaties
  let maxPair = null;
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++)
      if (!maxPair || corr[i][j] > maxPair.c) maxPair = { a: ids[i], b: ids[j], c: corr[i][j] };
  state._maxCorrPair = maxPair;
}

/* ---------- stress-test ---------- */
function renderStressButtons(positions) {
  const holder = $('#stress-buttons');
  holder.innerHTML = '';
  for (const sc of STRESS_SCENARIOS) {
    const btn = document.createElement('button');
    btn.className = 'stress-btn';
    btn.innerHTML = `${sc.icon} ${sc.name}<span class="s-desc">${sc.desc}</span>`;
    btn.addEventListener('click', () => {
      $$('.stress-btn').forEach(b => b.classList.remove('on'));
      btn.classList.add('on');
      runStress(positions, sc);
    });
    holder.appendChild(btn);
  }
  $('#stress-result').innerHTML = '<div class="palette-empty">Kies een scenario om de klap op je portefeuille te zien.</div>';
}

function runStress(positions, scenario) {
  const res = applyStress(positions, scenario);
  const holder = $('#stress-result');
  holder.innerHTML = `
    <div class="stress-summary">
      <span class="s-big">${fmtPct(res.lossPct, 1)}</span>
      <span class="s-sub">${fmtEUR.format(res.before)} → <b>${fmtEUR.format(res.after)}</b></span>
      <span class="s-sub">geschat herstel: <b>~${res.recoveryYears.toFixed(1).replace('.', ',')} jaar</b> bij 6%/jr</span>
    </div>
    <div class="bars-holder" id="stress-bars"></div>`;
  renderReturnBars($('#stress-bars'), res.rows.map(r => ({ name: r.asset.id, pct: r.shock * 100 })));
}

/* ---------- AI-observaties ---------- */
function renderAIInsights(positions, total, m) {
  const insights = [];
  const top = positions[0];
  const topW = (top.value / total) * 100;

  if (topW > 35) {
    insights.push({ icon: '⚠️', text: `<b>Concentratierisico:</b> ${top.asset.name} is <b>${topW.toFixed(0)}%</b> van je portefeuille. Eén slecht kwartaal van deze positie raakt je hele vermogen — overweeg af te romen richting je breedste positie.` });
  } else {
    insights.push({ icon: '✅', text: `<b>Spreiding:</b> je grootste positie (${top.asset.name}) is ${topW.toFixed(0)}% van het geheel — geen enkele positie domineert.` });
  }

  if (state._maxCorrPair && state._maxCorrPair.c > 0.65) {
    const p = state._maxCorrPair;
    insights.push({ icon: '🔗', text: `<b>Verborgen dubbeling:</b> ${p.a} en ${p.b} bewegen sterk samen (correlatie ${p.c.toFixed(2).replace('.', ',')}). Op papier twee posities, in de praktijk grotendeels één gok.` });
  }

  const crypto = positions.filter(p => p.asset.type === 'Crypto');
  const cryptoW = crypto.reduce((s, p) => s + p.value, 0) / total * 100;
  if (cryptoW > 25) {
    insights.push({ icon: '🎢', text: `<b>Crypto-blootstelling:</b> ${cryptoW.toFixed(0)}% van je portefeuille is crypto. Dat verklaart een flink deel van je volatiliteit van ${(m.vol * 100).toFixed(0)}%.` });
  } else if (cryptoW > 0) {
    insights.push({ icon: '🪙', text: `<b>Crypto:</b> met ${cryptoW.toFixed(0)}% blootstelling blijft de impact van crypto-volatiliteit beheersbaar.` });
  }

  const best = [...positions].sort((a, b) => b.gainPct - a.gainPct)[0];
  const worst = [...positions].sort((a, b) => a.gainPct - b.gainPct)[0];
  insights.push({ icon: '🏆', text: `<b>Beste positie:</b> ${best.asset.name} met ${fmtPct(best.gainPct, 1)} rendement (${fmtSignedEUR(best.gain)}).` });
  if (worst.gainPct < 0) {
    insights.push({ icon: '📉', text: `<b>Zwakste positie:</b> ${worst.asset.name} staat op ${fmtPct(worst.gainPct, 1)}. Het AI-signaal hiervoor is momenteel "<b>${computeSignal(MARKET.prices[worst.asset.id]).label}</b>".` });
  }

  if (state.ef && state.ef.maxSharpe.sharpe > state.ef.current.sharpe + 0.15) {
    insights.push({ icon: '🎯', text: `<b>Optimalisatie mogelijk:</b> de max-Sharpe portefeuille van jouw eigen assets haalt een Sharpe van ${state.ef.maxSharpe.sharpe.toFixed(2).replace('.', ',')} tegenover ${state.ef.current.sharpe.toFixed(2).replace('.', ',')} nu. Klik in de frontier-grafiek voor het herbalanceringsadvies.` });
  }

  if (m.sharpe > 1) {
    insights.push({ icon: '🧠', text: `<b>Risico-rendement:</b> met een Sharpe-ratio van ${m.sharpe.toFixed(2)} word je goed beloond per eenheid risico. Max. drawdown was −${(m.mdd * 100).toFixed(0)}%.` });
  } else {
    insights.push({ icon: '🧠', text: `<b>Risico-rendement:</b> je Sharpe-ratio van ${m.sharpe.toFixed(2)} suggereert dat het rendement mager is voor het risico dat je loopt (max. drawdown −${(m.mdd * 100).toFixed(0)}%).` });
  }

  $('#ai-insights').innerHTML = insights.map(i =>
    `<div class="ai-insight"><div class="ai-icon">${i.icon}</div><div>${i.text}</div></div>`).join('');
}

/* ============================================================
   TRANSACTIES + IMPORT
   ============================================================ */
const TX_TYPE_UI = Object.freeze({
  buy: { label: 'Koop', className: 'tx-buy' },
  sell: { label: 'Verkoop', className: 'tx-sell' },
  deposit: { label: 'Storting', className: 'tx-cash-in' },
  withdrawal: { label: 'Opname', className: 'tx-cash-out' },
  dividend: { label: 'Dividend', className: 'tx-income' },
  interest: { label: 'Rente', className: 'tx-income' },
  fee: { label: 'Kosten', className: 'tx-cost' },
  tax: { label: 'Belasting', className: 'tx-cost' },
  split: { label: 'Split', className: 'tx-action' },
  transfer_in: { label: 'Transfer in', className: 'tx-transfer' },
  transfer_out: { label: 'Transfer uit', className: 'tx-transfer' },
});

function transactionTableValues(tx) {
  const currency = tx.currency || 'EUR';
  if (TRADE_TYPES.has(tx.type)) {
    const amount = tx.type === 'buy' ? transactionTradeGrossEur(tx) : transactionTradeNetEur(tx);
    return { qty: fmtNum.format(tx.qty), price: `${fmtNum.format(tx.price)} ${currency}`, amount };
  }
  if (TRANSFER_TYPES.has(tx.type)) {
    return { qty: fmtNum.format(tx.qty), price: `${fmtNum.format(tx.price)} ${currency}`, amount: transactionTransferValueEur(tx) };
  }
  if (tx.type === 'split') return { qty: `× ${fmtNum.format(tx.ratio)}`, price: '—', amount: null };
  const amount = transactionAmountEur(tx);
  const sign = ['withdrawal', 'fee', 'tax'].includes(tx.type) ? -1 : 1;
  return { qty: '—', price: `${fmtNum.format(tx.amount)} ${currency}`, amount: sign * amount };
}

function renderTransactions() {
  state.portfolio = computePortfolioSeries(state.txs);
  const tbody = $('#tx-table tbody');
  tbody.innerHTML = '';
  const sorted = [...state.txs].sort((a, b) => new Date(b.date) - new Date(a.date));
  $('#tx-count').textContent = `${sorted.length} boekingen · cash ${fmtEUR2.format(state.portfolio.cash)}`;
  for (const tx of sorted) {
    const typeUi = TX_TYPE_UI[tx.type] || { label: tx.type, className: 'tx-action' };
    const a = tx.asset ? (assetById(tx.asset) || { color: '#5c6580', id: tx.asset, name: tx.asset }) : null;
    const display = transactionTableValues(tx);
    const tr = document.createElement('tr');
    tr.style.cursor = 'default';
    if (tx.note) tr.title = tx.note;
    tr.innerHTML = `
      <td>${fmtDate.format(new Date(tx.date))}</td>
      <td><span class="tx-badge ${typeUi.className}">${typeUi.label}</span>${String(tx.id).startsWith('dca-') ? ' <span class="tag tag-dca">DCA</span>' : ''}${tx.external ? ' <span class="tag tag-external" title="Direct extern afgerekend">extern</span>' : ''}</td>
      <td>${a ? `<div class="asset-cell"><div class="asset-dot" style="background:${safeColor(a.color)};width:26px;height:26px;border-radius:8px;font-size:9px">${escapeHTML(a.id.slice(0, 3))}</div>${escapeHTML(a.name)}</div>` : '<span class="muted">Cashrekening</span>'}</td>
      <td>${display.qty}</td>
      <td>${display.price}</td>
      <td class="${display.amount !== null && display.amount < 0 ? 'pct down' : ''}"><b>${display.amount === null ? '—' : fmtEUR2.format(display.amount)}</b></td>
      <td><button class="tx-del" title="Verwijderen">✕</button></td>`;
    tr.querySelector('.tx-del').addEventListener('click', () => {
      state.txs = state.txs.filter(t => t.id !== tx.id);
      saveTransactions(state.txs);
      invalidateDerived();
      renderTransactions();
      toast('Transactie verwijderd');
    });
    tbody.appendChild(tr);
  }
  renderLedgerSummary();
  renderReconciliation();
  renderImportReport();
}

function renderLedgerSummary() {
  const ledger = state.portfolio?.ledger || buildPortfolioLedger(state.txs);
  const openCost = Object.values(ledger.positions).reduce((sum, position) => sum + position.cost, 0);
  const cards = [
    ['Cashsaldo', fmtEUR2.format(ledger.cash), ledger.cash < -0.005 ? 'down' : ''],
    ['Open kostbasis', fmtEUR.format(openCost), ''],
    ['Gerealiseerd resultaat', fmtSignedEUR(ledger.realized), ledger.realized >= 0 ? 'up' : 'down'],
    ['Inkomsten', fmtEUR2.format(ledger.income), ledger.income > 0 ? 'up' : ''],
    ['Kosten + belasting', fmtEUR2.format(ledger.fees + ledger.taxes), ledger.fees + ledger.taxes > 0 ? 'down' : ''],
  ];
  $('#ledger-summary').innerHTML = cards.map(([label, value, tone]) => `
    <div class="ledger-stat"><span>${label}</span><b class="${tone}">${value}</b></div>`).join('');
  const issues = ledger.issues;
  $('#ledger-issues').innerHTML = issues.length ? `
    <div class="ledger-warning"><b>⚠ ${issues.length} boekhoudkundig aandachtspunt${issues.length > 1 ? 'en' : ''}</b>
      <ul>${issues.map(issue => `<li>${escapeHTML(issue.message)}</li>`).join('')}</ul>
    </div>` : '';
}

function renderReconciliation() {
  const snapshot = loadReconciliation();
  const report = reconcilePortfolio(state.txs, snapshot);
  const rows = report.rows.map(row => {
    const difference = row.difference === null ? '—' : fmtNum.format(row.difference);
    const differenceClass = row.difference === null ? 'muted' : row.balanced ? 'up' : 'down';
    return `<tr>
      <td><b>${escapeHTML(assetById(row.asset)?.name || row.asset)}</b> <span class="muted">${escapeHTML(row.asset)}</span></td>
      <td>${fmtNum.format(row.expected)}</td>
      <td><input class="input recon-input" type="number" min="0" step="any" data-recon-asset="${escapeHTML(row.asset)}" value="${row.actual === null ? '' : row.actual}"></td>
      <td><span class="pct ${differenceClass}">${difference}</span></td>
    </tr>`;
  });
  rows.push(`<tr>
    <td><b>Cashrekening</b> <span class="muted">EUR</span></td>
    <td>${fmtEUR2.format(report.cash.expected)}</td>
    <td><input class="input recon-input" type="number" step="any" id="recon-cash" value="${report.cash.actual === null ? '' : report.cash.actual}"></td>
    <td><span class="pct ${report.cash.difference === null ? 'muted' : report.cash.balanced ? 'up' : 'down'}">${report.cash.difference === null ? '—' : fmtEUR2.format(report.cash.difference)}</span></td>
  </tr>`);
  $('#recon-rows').innerHTML = rows.join('');

  const checked = report.checkedAt ? ` · opgeslagen ${fmtDate.format(new Date(report.checkedAt))}` : '';
  const status = !report.complete
    ? { className: 'pending', text: 'Vul voor alle berekende posities en cash de brokerstand in.' }
    : report.balanced
      ? { className: 'ok', text: '✓ Ledger en brokerstand sluiten volledig aan.' }
      : { className: 'error', text: 'Verschillen gevonden. Controleer ontbrekende transacties, fees, splits of transfers.' };
  $('#recon-status').className = `recon-status ${status.className}`;
  $('#recon-status').textContent = status.text + checked;
}

$('#recon-save').addEventListener('click', () => {
  try {
    const assets = {};
    $$('[data-recon-asset]').forEach(input => {
      if (input.value !== '') assets[input.dataset.reconAsset] = Number(input.value);
    });
    saveReconciliation({ assets, cash: $('#recon-cash').value });
    renderReconciliation();
    toast('✅ Brokerstand opgeslagen en vergeleken');
  } catch (error) {
    toast('⚠️ ' + error.message);
  }
});

function renderImportReport() {
  const holder = $('#import-report');
  if (!IMPORT_REPORT || !state.txs.length) { holder.innerHTML = ''; return; }
  const r = IMPORT_REPORT;
  const symbols = Array.isArray(r.symbols) ? r.symbols.map(normalizeAssetId).filter(Boolean).map(escapeHTML) : [];
  const histMatched = Math.max(0, Number(r.histMatched) || 0);
  const synthesized = Math.max(0, Number(r.synthesized) || 0);
  holder.innerHTML = `
    <div class="import-report-card">
      <div style="font-size:17px">📥</div>
      <div>
        <b>Import geslaagd</b> — ${Number(r.txCount) || 0} transacties over ${Number(r.assetCount) || 0} assets (${symbols.join(', ')}).
        ${histMatched ? `Voor ${histMatched} asset(s) is gedateerde bronhistorie uit het bestand gebruikt. ` : ''}
        ${synthesized ? `Voor ${synthesized} asset(s) is de historie gereconstrueerd rond transactiekoersen. Deze reeks is alleen voor visualisatie en uitgesloten van analyse.` : ''}
        ${r.migrationWarning ? `<div class="ledger-warning">⚠️ ${escapeHTML(r.migrationWarning)} Ververs of herimporteer koershistorie voordat je analyses gebruikt.</div>` : ''}
      </div>
    </div>`;
}

/* ---------- import-flow ---------- */
function handleImportFile(file) {
  if (!file) return;
  if (file.size > MAX_IMPORT_BYTES) { toast('⚠️ Bestand is groter dan de veilige limiet van 8 MB'); return; }
  const reader = new FileReader();
  reader.onload = () => {
    if (/\.csv$/i.test(file.name)) {
      // CSV = aanvullen (merge); JSON = volledige (her)import
      if (!state.txs.length) { toast('⚠️ CSV-import vult bestaande data aan — importeer eerst je portfolio-JSON'); return; }
      const result = importTransactionCSV(reader.result, state.txs);
      if (!result.ok) { toast('⚠️ ' + result.error); return; }
      const skipped = result.skippedAssets.length
        ? ` · ${result.skippedAssets.length} onbekende assets overgeslagen (${result.skippedAssets.slice(0, 5).join(', ')}${result.skippedAssets.length > 5 ? '…' : ''})`
        : '';
      const transfers = result.transfers ? ` · ${result.transfers} cash- of assettransfer verwerkt${result.estimatedTransfers ? ` (${result.estimatedTransfers} gewaardeerd op de beschikbare dagkoers)` : ''}` : '';
      toast(`📥 ${result.bron}: ${result.added} nieuwe transacties toegevoegd, ${result.dedupe} al bekend${skipped}${transfers}`);
      if (result.added) setTimeout(() => location.reload(), 1600);
      return;
    }
    const result = importPortfolioJSON(reader.result);
    if (!result.ok) { toast('⚠️ ' + result.error); return; }
    toast(`📥 ${result.report.txCount} transacties geïmporteerd — app herstart…`);
    setTimeout(() => location.reload(), 900);
  };
  reader.onerror = () => toast('⚠️ Kon het bestand niet lezen');
  reader.readAsText(file);
}

$('#btn-import').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', e => { handleImportFile(e.target.files[0]); e.target.value = ''; });
const dropCard = $('#tx-card');
['dragenter', 'dragover'].forEach(ev => dropCard.addEventListener(ev, e => {
  e.preventDefault(); dropCard.classList.add('dragover');
}));
['dragleave', 'drop'].forEach(ev => dropCard.addEventListener(ev, e => {
  e.preventDefault(); dropCard.classList.remove('dragover');
}));
dropCard.addEventListener('drop', e => {
  const file = e.dataTransfer.files?.[0];
  if (file) handleImportFile(file);
});

/* ---------- modal ---------- */
const txModal = $('#tx-modal');
const txTypeSelect = $('#tx-type-select');
const txAssetSelect = $('#tx-asset');
let modalReturnFocus = null;
const TX_FORM_FIELDS = Object.freeze({
  buy: ['asset', 'qty', 'price', 'fee', 'tax', 'fx', 'external'],
  sell: ['asset', 'qty', 'price', 'fee', 'tax', 'fx', 'external'],
  deposit: ['amount', 'fx'],
  withdrawal: ['amount', 'fx'],
  dividend: ['asset', 'amount', 'fx'],
  interest: ['asset', 'amount', 'fx'],
  fee: ['asset', 'amount', 'fx'],
  tax: ['asset', 'amount', 'fx'],
  split: ['asset', 'ratio'],
  transfer_in: ['asset', 'qty', 'price', 'costBasis', 'externalValue', 'fx'],
  transfer_out: ['asset', 'qty', 'price', 'externalValue', 'fx'],
});

function focusableIn(root) {
  return [...root.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])')]
    .filter(element => element.offsetParent !== null);
}

function closeTxModal() {
  txModal.classList.remove('open');
  txModal.setAttribute('aria-hidden', 'true');
  modalReturnFocus?.focus?.();
}

function localDateInputValue(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function resetTxForm() {
  txTypeSelect.value = 'buy';
  $('#tx-date').value = localDateInputValue();
  $('#tx-currency').value = 'EUR';
  $('#tx-fx').value = '1';
  $('#tx-qty').value = '1';
  $('#tx-amount').value = '';
  $('#tx-ratio').value = '2';
  $('#tx-fee').value = '0';
  $('#tx-tax').value = '0';
  $('#tx-cost-basis').value = '';
  $('#tx-external-value').value = '';
  $('#tx-external').checked = true;
  $('#tx-note').value = '';
  if (!txAssetSelect.value && ASSETS.length) txAssetSelect.value = ASSETS[0].id;
  $('#tx-price').value = txAssetSelect.value && MARKET.prices[txAssetSelect.value]
    ? round2(lastPrice(txAssetSelect.value)) : '';
  updateTxFormVisibility();
}

function openTxModal() {
  modalReturnFocus = document.activeElement;
  resetTxForm();
  txModal.classList.add('open');
  txModal.setAttribute('aria-hidden', 'false');
  setTimeout(() => txTypeSelect.focus(), 0);
}
$('#btn-new-tx').addEventListener('click', openTxModal);
$('#btn-new-tx2').addEventListener('click', openTxModal);
$('#tx-cancel').addEventListener('click', closeTxModal);
txModal.addEventListener('click', e => { if (e.target === txModal) closeTxModal(); });
txModal.addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.preventDefault(); closeTxModal(); return; }
  if (e.key !== 'Tab') return;
  const items = focusableIn(txModal);
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

function updateTxFormVisibility() {
  const type = txTypeSelect.value;
  const visible = new Set(TX_FORM_FIELDS[type] || []);
  $$('[data-tx-field]').forEach(row => row.classList.toggle('hidden', !visible.has(row.dataset.txField)));
  $$('.tx-money-field').forEach(row => row.classList.toggle('hidden', type === 'split'));
  if (ASSET_REQUIRED_TYPES.has(type) && !txAssetSelect.value && ASSETS.length) txAssetSelect.value = ASSETS[0].id;
  const currency = normalizeCurrency($('#tx-currency').value) || 'EUR';
  $('label[for="tx-price"]').textContent = `Koers per stuk (${currency})`;
  $('label[for="tx-amount"]').textContent = `Bedrag (${currency})`;
  updateTxTotal();
}

txTypeSelect.addEventListener('change', updateTxFormVisibility);
txAssetSelect.addEventListener('change', () => {
  if (txAssetSelect.value && MARKET.prices[txAssetSelect.value]) $('#tx-price').value = round2(lastPrice(txAssetSelect.value));
  updateTxTotal();
});
['tx-qty', 'tx-price', 'tx-amount', 'tx-ratio', 'tx-fee', 'tx-tax', 'tx-external-value', 'tx-fx']
  .forEach(id => $(`#${id}`).addEventListener('input', updateTxTotal));
$('#tx-currency').addEventListener('input', updateTxFormVisibility);

function updateTxTotal() {
  const type = txTypeSelect.value;
  const qty = parseFloat($('#tx-qty').value) || 0;
  const price = parseFloat($('#tx-price').value) || 0;
  const fx = parseFloat($('#tx-fx').value) || 0;
  const fee = parseFloat($('#tx-fee').value) || 0;
  const tax = parseFloat($('#tx-tax').value) || 0;
  const amount = parseFloat($('#tx-amount').value) || 0;
  const externalValue = parseFloat($('#tx-external-value').value);
  if (type === 'split') {
    $('#tx-total').textContent = `Nieuwe aantallen = oude aantallen × ${fmtNum.format(parseFloat($('#tx-ratio').value) || 0)}`;
    return;
  }
  let nativeTotal = amount;
  if (TRADE_TYPES.has(type)) nativeTotal = qty * price + (type === 'buy' ? fee + tax : -fee - tax);
  else if (TRANSFER_TYPES.has(type)) nativeTotal = Number.isFinite(externalValue) ? externalValue : qty * price;
  $('#tx-total').textContent = 'Waarde in EUR: ' + fmtEUR2.format(nativeTotal * fx);
}

$('#tx-save').addEventListener('click', () => {
  try {
    const type = txTypeSelect.value;
    const date = new Date(`${$('#tx-date').value}T12:00:00`);
    const currency = normalizeCurrency($('#tx-currency').value);
    const fxRate = Number($('#tx-fx').value);
    if (!Number.isFinite(date.getTime())) throw new Error('Kies een geldige boekingsdatum.');
    if (!currency) throw new Error('Gebruik een geldige drieletterige valutacode, bijvoorbeeld EUR of USD.');
    if (type !== 'split' && (!Number.isFinite(fxRate) || fxRate <= 0)) throw new Error('Vul een geldige wisselkoers naar EUR in.');

    const tx = {
      id: `tx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      date: date.toISOString(), type, currency, fxRate: type === 'split' ? 1 : fxRate,
      note: $('#tx-note').value,
    };
    const asset = txAssetSelect.value;
    if (asset) tx.asset = asset;
    if (ASSET_REQUIRED_TYPES.has(type) && !asset) throw new Error('Kies voor dit type een asset.');

    if (TRADE_TYPES.has(type)) {
      const qty = Number($('#tx-qty').value), price = Number($('#tx-price').value);
      const fee = Number($('#tx-fee').value || 0), tax = Number($('#tx-tax').value || 0);
      if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price < 0) throw new Error('Vul een geldig aantal en een niet-negatieve koers in.');
      if (!Number.isFinite(fee) || fee < 0 || !Number.isFinite(tax) || tax < 0) throw new Error('Kosten en belasting mogen niet negatief zijn.');
      Object.assign(tx, { qty, price, fee, tax, external: $('#tx-external').checked });
    } else if (CASH_EVENT_TYPES.has(type)) {
      const amount = Number($('#tx-amount').value);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('Vul een positief bedrag in.');
      tx.amount = amount;
    } else if (type === 'split') {
      const ratio = Number($('#tx-ratio').value);
      if (!Number.isFinite(ratio) || ratio <= 0) throw new Error('Vul een positieve splitfactor in, bijvoorbeeld 2 voor een 2-op-1-split.');
      tx.ratio = ratio;
    } else if (TRANSFER_TYPES.has(type)) {
      const qty = Number($('#tx-qty').value), price = Number($('#tx-price').value || 0);
      if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price < 0) throw new Error('Vul een geldig aantal en een niet-negatieve koers in.');
      Object.assign(tx, { qty, price });
      for (const [field, selector] of [['costBasis', '#tx-cost-basis'], ['externalValue', '#tx-external-value']]) {
        if ($(selector).value === '') continue;
        const value = Number($(selector).value);
        if (!Number.isFinite(value) || value < 0) throw new Error('Kostbasis en transferwaarde mogen niet negatief zijn.');
        tx[field] = value;
      }
    }

    const normalized = normalizeStoredTransaction(tx);
    if (!normalized) throw new Error('De boeking bevat een ongeldige combinatie van velden.');
    const before = buildPortfolioLedger(state.txs);
    const candidate = buildPortfolioLedger([...state.txs, normalized]);
    const directIssue = candidate.issues.find(issue => issue.txId === normalized.id);
    if (directIssue) throw new Error(directIssue.message);
    if (candidate.minCash < Math.min(-0.005, before.minCash - 0.005)) {
      throw new Error('Deze boeking maakt het cashsaldo historisch negatief. Boek eerst een storting of kies directe externe afrekening.');
    }

    state.txs.push(normalized);
    saveTransactions(state.txs);
    invalidateDerived();
    closeTxModal();
    toast(`✅ ${TX_TYPE_UI[type]?.label || 'Boeking'} opgeslagen`);
    renderDashboard(true);
    const activeView = document.querySelector('.view.active').id;
    if (activeView === 'view-transactions') renderTransactions();
    if (activeView === 'view-insights') renderInsights();
  } catch (error) {
    toast('⚠️ ' + error.message);
  }
});

/* ============================================================
   COMMAND PALETTE (⌘K)
   ============================================================ */
const palette = $('#palette');
const paletteInput = $('#palette-input');
const paletteList = $('#palette-list');
let paletteSel = 0;

function paletteCommands() {
  const cmds = [
    { icon: '▦', label: 'Ga naar Dashboard', hint: 'navigatie', run: () => gotoView('dashboard') },
    { icon: '◉', label: 'Ga naar Asset Analyse', hint: 'navigatie', run: () => gotoView('asset') },
    { icon: '⚛', label: 'Ga naar ML Lab', hint: 'navigatie', run: () => gotoView('mllab') },
    { icon: '▶', label: 'Ga naar Backtest', hint: 'navigatie', run: () => gotoView('backtest') },
    { icon: '◔', label: 'Ga naar Inzichten', hint: 'navigatie', run: () => gotoView('insights') },
    { icon: '⇄', label: 'Ga naar Transacties', hint: 'navigatie', run: () => gotoView('transactions') },
    { icon: '＋', label: 'Nieuwe transactie', hint: 'actie', run: () => openTxModal() },
    { icon: '🧠', label: 'Train neuraal netwerk', hint: 'actie', run: () => { gotoView('mllab'); setTimeout(() => $('#btn-train').click(), 150); } },
    { icon: '⚔', label: 'Vergelijk ML-modellen (arena)', hint: 'actie', run: () => { gotoView('mllab'); setTimeout(() => $('#btn-arena').click(), 150); } },
    { icon: '📥', label: 'Importeer portfolio (JSON)', hint: 'actie', run: () => { gotoView('transactions'); setTimeout(() => $('#import-file').click(), 150); } },
    { icon: '⚖', label: 'Toggle benchmark (vs. VWRL)', hint: 'actie', run: () => { gotoView('dashboard'); setTimeout(() => $('#btn-benchmark').click(), 100); } },
  ];
  for (const a of ASSETS) {
    cmds.push({ icon: '◉', label: `Analyseer ${a.name} (${a.id})`, hint: a.type, run: () => { state.selectedAsset = a.id; gotoView('asset'); } });
    cmds.push({ icon: '▶', label: `Backtest ${a.name} (${a.id})`, hint: a.type, run: () => { $('#bt-asset').value = a.id; gotoView('backtest'); } });
    if (state.watchlist.has(a.id)) {
      cmds.push({ icon: '☆', label: `Stop met volgen: ${a.name} (${a.id})`, hint: 'watchlist', run: () => { state.watchlist.delete(a.id); saveWatchlist(); gotoView('dashboard'); } });
    } else {
      cmds.push({ icon: '★', label: `Volg ${a.name} (${a.id})`, hint: 'watchlist', run: () => { state.watchlist.add(a.id); saveWatchlist(); gotoView('dashboard'); } });
    }
  }
  for (const sc of STRESS_SCENARIOS) {
    cmds.push({ icon: sc.icon, label: `Stress-test: ${sc.name}`, hint: 'scenario', run: () => {
      gotoView('insights');
      setTimeout(() => {
        const btns = [...$$('.stress-btn')];
        const idx = STRESS_SCENARIOS.indexOf(sc);
        if (btns[idx]) btns[idx].click();
        btns[idx]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }, 200);
    }});
  }
  cmds.push({ icon: '⟳', label: 'Ga naar DCA-plannen', hint: 'navigatie', run: () => gotoView('dca') });
  cmds.push({ icon: '⚙', label: 'Ga naar Instellingen', hint: 'navigatie', run: () => gotoView('settings') });
  cmds.push({ icon: '📡', label: 'Haal echte crypto-koershistorie op', hint: 'actie', run: () => { gotoView('settings'); setTimeout(() => $('#set-fetch-hist').click(), 200); } });
  cmds.push({ icon: '⬇', label: 'Exporteer backup', hint: 'actie', run: () => exportBackup(state.txs) });
  return cmds;
}

function fuzzyScore(query, label) {
  const q = query.toLowerCase(), l = label.toLowerCase();
  if (!q) return 1;
  if (l.includes(q)) return 100 - l.indexOf(q);
  let qi = 0;
  for (const ch of l) if (ch === q[qi]) qi++;
  return qi === q.length ? 10 : 0;
}

function openPalette() {
  modalReturnFocus = document.activeElement;
  palette.classList.add('open');
  palette.setAttribute('aria-hidden', 'false');
  paletteInput.value = '';
  paletteSel = 0;
  renderPaletteList('');
  setTimeout(() => paletteInput.focus(), 30);
}
function closePalette() {
  palette.classList.remove('open');
  palette.setAttribute('aria-hidden', 'true');
  modalReturnFocus?.focus?.();
}

function renderPaletteList(query) {
  const matches = paletteCommands()
    .map(c => ({ ...c, score: fuzzyScore(query, c.label) }))
    .filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);
  paletteSel = Math.min(paletteSel, Math.max(0, matches.length - 1));
  paletteList.innerHTML = matches.length
    ? matches.map((c, i) => `
      <div class="palette-item ${i === paletteSel ? 'sel' : ''}" data-i="${i}">
        <span class="p-icon">${escapeHTML(c.icon)}</span>${escapeHTML(c.label)}<span class="p-hint">${escapeHTML(c.hint)}</span>
      </div>`).join('')
    : '<div class="palette-empty">Geen resultaten</div>';
  paletteList._matches = matches;
  paletteList.querySelectorAll('.palette-item').forEach(el => {
    el.addEventListener('click', () => { closePalette(); matches[+el.dataset.i].run(); });
    el.addEventListener('mousemove', () => {
      paletteSel = +el.dataset.i;
      paletteList.querySelectorAll('.palette-item').forEach(x => x.classList.toggle('sel', x === el));
    });
  });
}

paletteInput.addEventListener('input', () => { paletteSel = 0; renderPaletteList(paletteInput.value); });
paletteInput.addEventListener('keydown', e => {
  const matches = paletteList._matches || [];
  if (e.key === 'ArrowDown') { e.preventDefault(); paletteSel = Math.min(paletteSel + 1, matches.length - 1); renderPaletteList(paletteInput.value); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); paletteSel = Math.max(paletteSel - 1, 0); renderPaletteList(paletteInput.value); }
  else if (e.key === 'Enter' && matches[paletteSel]) { closePalette(); matches[paletteSel].run(); }
  else if (e.key === 'Escape') closePalette();
});
palette.addEventListener('click', e => { if (e.target === palette) closePalette(); });
palette.addEventListener('keydown', e => {
  if (e.key !== 'Tab') return;
  const items = focusableIn(palette);
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});
$('#palette-open').addEventListener('click', openPalette);
window.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    palette.classList.contains('open') ? closePalette() : openPalette();
  }
});

/* ============================================================
   LIVE KOERSEN + PWA + INIT
   ============================================================ */
const AUTO_REFRESH_POLL_MS = 60 * 1000;
const refreshDateTime = new Intl.DateTimeFormat('nl-NL', {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
});
let autoRefreshTimer = null;
let priceRefreshBusy = false;

function formatRefreshMoment(value) {
  const timestamp = validRefreshTimestamp(value);
  if (!timestamp) return 'nog niet';
  const age = Math.max(0, Date.now() - timestamp);
  if (age < 60 * 1000) return 'zojuist';
  if (age < 60 * 60 * 1000) return `${Math.floor(age / 60000)} min geleden`;
  if (age < 24 * 60 * 60 * 1000) return `${Math.floor(age / 3600000)} uur geleden`;
  return refreshDateTime.format(new Date(timestamp));
}

function latestStoredPriceAt() {
  return Math.max(0, ...Object.values(loadLiveHistory()).map(entry => validRefreshTimestamp(entry?.at)));
}

function renderPriceRefreshStatus() {
  const consent = networkConsentEnabled();
  const automatic = autoRefreshEnabled();
  const meta = loadPriceRefreshMeta();
  const lastSuccess = Math.max(meta.cryptoSuccessAt, meta.stockSuccessAt, latestStoredPriceAt());
  const status = $('#set-refresh-status');
  if (status) {
    let text;
    if (!consent) text = 'Uit: externe koersdata is niet toegestaan.';
    else if (priceRefreshBusy) text = 'Bezig met gecontroleerd verversen…';
    else if (!automatic) text = `Handmatig/start-up · laatste opslag ${formatRefreshMoment(lastSuccess)}.`;
    else text = `Actief · crypto maximaal elk uur, aandelen/ETF’s maximaal dagelijks · laatste succes ${formatRefreshMoment(lastSuccess)}.`;
    if (meta.lastError && consent) text += ` Laatste melding: ${meta.lastError}`;
    status.textContent = text;
    status.classList.toggle('is-live', consent && automatic && !meta.lastError);
    status.classList.toggle('has-warning', Boolean(meta.lastError));
  }
  const badge = $('#live-badge');
  if (lastSuccess) {
    badge.style.display = '';
    badge.textContent = '● koersdata';
    badge.title = `Laatste opgeslagen koersupdate: ${refreshDateTime.format(new Date(lastSuccess))}`;
  } else if (!priceRefreshBusy) {
    badge.style.display = 'none';
  }
}

function renderAfterPriceRefresh(updated) {
  if (!updated.length) return;
  invalidateDerived();
  state.twr = null;
  delete state.models;
  state.models = {};
  const active = document.querySelector('.view.active')?.id;
  if (active === 'view-dashboard') renderDashboard(false);
  else if (active === 'view-asset') renderAssetView();
  else if (active === 'view-settings') renderSettings();
  runAlertCheck(true);
}

async function runAutomaticPriceRefresh({ reason = 'timer', startup = false } = {}) {
  if (priceRefreshBusy || !networkConsentEnabled()) {
    renderPriceRefreshStatus();
    return { ok: false, updated: [], skipped: priceRefreshBusy ? 'busy' : 'disabled' };
  }
  const automatic = autoRefreshEnabled();
  const now = Date.now();
  const meta = loadPriceRefreshMeta();
  const cryptoTargets = cryptoPriceTargets();
  const cryptoDue = cryptoTargets.length > 0
    && ((startup && !automatic) || (automatic && isPriceRefreshDue(meta.cryptoAttemptAt, CRYPTO_AUTO_REFRESH_MS, now)));
  const hasStockTargets = ASSETS.some(asset => asset.type !== 'Crypto' && MARKET.prices[asset.id]);
  const stockWindowDue = automatic && hasStockTargets && isPriceRefreshDue(meta.stockAttemptAt, STOCK_AUTO_REFRESH_MS, now);
  const stockIds = stockWindowDue ? autoStockRefreshIds(now) : [];

  if (!cryptoDue && !stockIds.length) {
    if (stockWindowDue) savePriceRefreshMeta({ stockAttemptAt: now, completedAt: now });
    renderPriceRefreshStatus();
    return { ok: true, updated: [], skipped: 'fresh' };
  }

  priceRefreshBusy = true;
  savePriceRefreshMeta({
    ...(cryptoDue ? { cryptoAttemptAt: now } : {}),
    ...(stockIds.length ? { stockAttemptAt: now } : {}),
    lastError: '',
  });
  renderPriceRefreshStatus();

  const updated = [];
  const errors = [];
  let cryptoSuccessAt = meta.cryptoSuccessAt;
  let stockSuccessAt = meta.stockSuccessAt;
  try {
    if (cryptoDue) {
      const cryptoUpdated = await fetchLivePrices();
      if (Array.isArray(cryptoUpdated) && cryptoUpdated.length) {
        updated.push(...cryptoUpdated);
        cryptoSuccessAt = Date.now();
      } else {
        errors.push('CoinGecko-update niet beschikbaar; nieuwe poging volgt pas na het uurvenster.');
      }
    }
    if (stockIds.length) {
      const stockResult = await fetchStockHistory(null, stockIds);
      if (stockResult.updated?.length) {
        updated.push(...stockResult.updated);
        stockSuccessAt = Date.now();
      }
      if (stockResult.failed?.length) errors.push(`Dagkoers niet beschikbaar voor ${stockResult.failed.join(', ')}.`);
    }
    savePriceRefreshMeta({
      cryptoSuccessAt,
      stockSuccessAt,
      completedAt: Date.now(),
      lastError: errors.join(' '),
    });
    const uniqueUpdated = [...new Set(updated)];
    renderAfterPriceRefresh(uniqueUpdated);
    if (reason === 'startup' && uniqueUpdated.length) toast(`📡 Koersen geladen: ${uniqueUpdated.join(', ')}`);
    if (reason === 'enabled') toast(uniqueUpdated.length ? `⏱ Automatisch verversen actief · ${uniqueUpdated.length} bijgewerkt` : '⏱ Automatisch verversen actief');
    return { ok: errors.length === 0, updated: uniqueUpdated, errors };
  } catch (error) {
    const message = cleanDisplayText(error?.message || 'Onverwachte fout tijdens automatisch verversen.', 160);
    try { savePriceRefreshMeta({ completedAt: Date.now(), lastError: message }); } catch (storageError) { /* status blijft beste-effort */ }
    return { ok: false, updated: [], errors: [message] };
  } finally {
    priceRefreshBusy = false;
    renderPriceRefreshStatus();
  }
}

function syncAutoRefreshTimer({ runNow = false } = {}) {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  autoRefreshTimer = null;
  if (networkConsentEnabled() && autoRefreshEnabled()) {
    autoRefreshTimer = setInterval(() => { runAutomaticPriceRefresh({ reason: 'timer' }); }, AUTO_REFRESH_POLL_MS);
    if (runNow) setTimeout(() => { runAutomaticPriceRefresh({ reason: 'enabled' }); }, 0);
  }
  renderPriceRefreshStatus();
}

async function initLivePrices() {
  return runAutomaticPriceRefresh({ reason: 'startup', startup: true });
}

let marketDayTimer = null;
function refreshMarketDayBoundary() {
  if (!ensureCurrentMarketGrid()) return false;
  applyLiveHistory();
  invalidateDerived();
  state.twr = null;
  state.models = {};
  const active = document.querySelector('.view.active')?.id;
  if (active === 'view-dashboard') renderDashboard(false);
  else if (active === 'view-asset') renderAssetView();
  else if (active === 'view-insights') renderInsights();
  else if (active === 'view-transactions') renderTransactions();
  else if (active === 'view-dca') renderDca();
  else if (active === 'view-settings') renderSettings();
  runAlertCheck(false);
  return true;
}

function scheduleMarketDayRollover() {
  if (marketDayTimer) clearTimeout(marketDayTimer);
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 2, 0);
  marketDayTimer = setTimeout(() => {
    refreshMarketDayBoundary();
    scheduleMarketDayRollover();
  }, Math.max(1000, next.getTime() - now.getTime()));
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    refreshMarketDayBoundary();
    if (autoRefreshEnabled()) runAutomaticPriceRefresh({ reason: 'focus' });
  }
});
window.addEventListener('online', () => {
  if (autoRefreshEnabled()) runAutomaticPriceRefresh({ reason: 'online' });
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
scheduleMarketDayRollover();

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const active = document.querySelector('.view.active').id;
    if (active === 'view-dashboard') renderDashboard(false);
    if (active === 'view-asset') renderAssetView();
    if (active === 'view-insights') renderInsights();
    if (active === 'view-mllab') runMonteCarlo();
    if (active === 'view-backtest') runBacktest(false);
  }, 180);
});

/* init staat onderaan het bestand, ná alle event-listeners */

/* ============================================================
   INSTELLINGEN + ALERTS + LEGE STAAT (v3)
   ============================================================ */
function updateEmptyOverlay() {
  const activeView = document.querySelector('.view.active').id;
  const allowed = activeView === 'view-settings' || activeView === 'view-transactions';
  $('#empty-overlay').style.display = (!state.txs.length && !allowed) ? '' : 'none';
}

$('#empty-import').addEventListener('click', () => $('#import-file').click());
{
  const card = document.querySelector('.empty-card');
  ['dragenter', 'dragover'].forEach(ev => card.addEventListener(ev, e => { e.preventDefault(); card.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach(ev => card.addEventListener(ev, e => { e.preventDefault(); card.classList.remove('dragover'); }));
  card.addEventListener('drop', e => { const f = e.dataTransfer.files?.[0]; if (f) handleImportFile(f); });
}

/* ---------- instellingen ---------- */
function renderSettings() {
  const consent = networkConsentEnabled();
  $('#set-network-consent').checked = consent;
  const autoInput = $('#set-auto-refresh');
  autoInput.checked = autoRefreshEnabled();
  autoInput.disabled = !consent;
  const alphaInput = $('#set-alpha-key');
  const alphaKeySet = Boolean(alphaVantageApiKey());
  if (document.activeElement !== alphaInput) alphaInput.value = alphaKeySet ? alphaVantageApiKey() : '';
  $('#set-alpha-status').innerHTML = alphaKeySet
    ? consent
      ? '✅ API-sleutel opgeslagen · externe koersdata staat aan.'
      : '⚠️ API-sleutel opgeslagen, maar <b>Externe koersdata toestaan</b> staat nog uit.'
    : 'Geen Alpha Vantage-sleutel opgeslagen.';
  $('#set-fetch-hist').disabled = !consent;
  $('#mode-note').textContent = `Portfoliodata lokaal · netwerk ${consent ? 'aan' : 'uit'}`;
  renderPriceRefreshStatus();
  // databeheer-info
  const importedAt = IMPORT_REPORT?.date && Number.isFinite(new Date(IMPORT_REPORT.date).getTime())
    ? ` · geïmporteerd op ${fmtDate.format(new Date(IMPORT_REPORT.date))}` : '';
  $('#set-data-info').innerHTML = state.txs.length
    ? `<p class="explain">Huidige data: <b>${state.txs.length} transacties</b> over <b>${ASSETS.length} assets</b>${importedAt}.</p>`
    : '<p class="explain">Nog geen data geïmporteerd.</p>';

  // koershistorie-status
  const tbody = $('#hist-table tbody');
  tbody.innerHTML = '';
  const liveHistory = loadLiveHistory();
  for (const a of ASSETS) {
    const st = historyStatus(a);
    const entry = liveHistory[a.id];
    const quoteAt = validRefreshTimestamp(entry?.quoteAt);
    const quoteTitle = quoteAt ? `Bronkoers: ${refreshDateTime.format(new Date(quoteAt))}` : 'Bronmoment onbekend';
    const tr = document.createElement('tr');
    tr.style.cursor = 'default';
    tr.innerHTML = `
      <td><div class="asset-cell"><div class="asset-dot" style="background:${a.color};width:26px;height:26px;border-radius:8px;font-size:9px">${escapeHTML(a.id.slice(0, 3))}</div>${escapeHTML(a.name)}</div></td>
      <td>${escapeHTML(a.type)}</td>
      <td>${fmtEUR2.format(lastPrice(a.id))}</td>
      <td><span class="pct ${st.cls === 'up' ? 'up' : ''}" style="${st.cls !== 'up' ? 'color:var(--text-3)' : ''}">${st.label}</span></td>
      <td class="muted" title="${quoteTitle}">${formatRefreshMoment(entry?.at)}</td>`;
    tbody.appendChild(tr);
  }

  // alert-asset select
  const sel = $('#al-asset');
  sel.innerHTML = '';
  for (const a of ASSETS) {
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = `${a.name} (${a.id})`;
    sel.appendChild(opt);
  }
  renderAlertList();
}

$('#set-network-consent').addEventListener('change', e => {
  setNetworkConsent(e.target.checked);
  renderSettings();
  if (e.target.checked) {
    syncAutoRefreshTimer({ runNow: autoRefreshEnabled() });
    toast(autoRefreshEnabled()
      ? '🔐 Externe koersdata toegestaan; automatische verversing wordt hervat'
      : '🔐 Externe koersdata toegestaan; ophalen volgt na een expliciete actie of nieuwe start');
  } else {
    syncAutoRefreshTimer();
    $('#live-badge').style.display = 'none';
    toast('🔒 Externe koersdata uitgezet');
  }
});

$('#set-auto-refresh').addEventListener('change', e => {
  if (!networkConsentEnabled()) {
    e.target.checked = false;
    setAutoRefreshEnabled(false);
    toast('⚠️ Sta eerst externe koersdata toe');
    return;
  }
  setAutoRefreshEnabled(e.target.checked);
  syncAutoRefreshTimer({ runNow: e.target.checked });
  renderSettings();
  if (!e.target.checked) toast('⏸ Automatisch verversen uitgezet');
});

$('#set-alpha-save').addEventListener('click', () => {
  const value = $('#set-alpha-key').value.trim();
  if (!setAlphaVantageApiKey(value)) {
    toast('⚠️ Ongeldige Alpha Vantage API-sleutel');
    return;
  }
  renderSettings();
  if (value && !networkConsentEnabled()) {
    toast('🔑 Sleutel opgeslagen; zet hierboven ook Externe koersdata toestaan aan');
  } else {
    toast(value ? '🔑 Alpha Vantage-koersroute opgeslagen' : '🔑 Alpha Vantage-sleutel verwijderd');
  }
});

$('#set-import').addEventListener('click', () => $('#import-file').click());
$('#set-export').addEventListener('click', () => {
  if (!state.txs.length) { toast('⚠️ Nog geen data om te exporteren'); return; }
  exportBackup(state.txs);
  toast('⬇ Backup gedownload');
});
$('#set-clear').addEventListener('click', () => {
  if (confirm('Alle lokale data wissen (transacties, historie, watchlist, alerts)? Dit kan niet ongedaan worden gemaakt — maak eventueel eerst een backup.')) {
    clearAllData();
  }
});

$('#set-fetch-hist').addEventListener('click', async () => {
  if (!networkConsentEnabled()) { toast('⚠️ Sta eerst externe koersdata toe'); return; }
  if (priceRefreshBusy) { toast('⏳ Er loopt al een koersverversing'); return; }
  const btn = $('#set-fetch-hist');
  btn.disabled = true;
  const prog = $('#hist-progress');
  priceRefreshBusy = true;
  const startedAt = Date.now();
  try {
    savePriceRefreshMeta({
      ...(cryptoPriceTargets().length ? { cryptoAttemptAt: startedAt } : {}),
      ...(ASSETS.some(asset => asset.type !== 'Crypto') ? { stockAttemptAt: startedAt } : {}),
      lastError: '',
    });
    renderPriceRefreshStatus();
    const cryptoRes = await fetchLiveHistory((done, total, id) => {
      if (id) prog.innerHTML = `<p class="explain">📡 Crypto ${done + 1}/${total}: <b>${escapeHTML(id)}</b>… (CoinGecko)</p>`;
    });
    const stockRes = await fetchStockHistory((done, total, id) => {
      if (id) prog.innerHTML = `<p class="explain">📡 Aandelen/ETF ${done + 1}/${total}: <b>${escapeHTML(id)}</b>… (Alpha Vantage / Yahoo)</p>`;
    });
    const updated = [...new Set([...(cryptoRes.updated || []), ...(stockRes.updated || [])])];
    const failed = stockRes.failed || [];
    const finishedAt = Date.now();
    savePriceRefreshMeta({
      ...(cryptoRes.updated?.length ? { cryptoSuccessAt: finishedAt } : {}),
      ...(stockRes.updated?.length ? { stockSuccessAt: finishedAt } : {}),
      completedAt: finishedAt,
      lastError: failed.length ? `Dagkoers niet beschikbaar voor ${failed.join(', ')}.` : '',
    });
    if (updated.length) {
      renderAfterPriceRefresh(updated);
      toast(`📈 Echte historie geladen: ${updated.length} assets`);
      prog.innerHTML = failed.length
        ? `<p class="explain">✅ ${updated.map(escapeHTML).join(', ')} bijgewerkt. ⚠️ Niet beschikbaar via de ingestelde koersbronnen: ${failed.map(escapeHTML).join(', ')}; die blijven gereconstrueerd en zijn uitgesloten van analyse.</p>`
        : '<p class="explain">✅ Alle assets bijgewerkt.</p>';
    } else {
      const error = cryptoRes.error || stockRes.error || 'Geen geldige koersreeksen ontvangen.';
      savePriceRefreshMeta({ completedAt: finishedAt, lastError: error });
      toast('⚠️ Ophalen mislukt; controleer toestemming, API-sleutel of providerlimieten');
      prog.innerHTML = `<p class="explain">⚠️ ${escapeHTML(error)}</p>`;
    }
  } catch (error) {
    const message = cleanDisplayText(error?.message || 'Onverwachte fout tijdens koersverversing.', 160);
    try { savePriceRefreshMeta({ completedAt: Date.now(), lastError: message }); } catch (storageError) { /* status blijft beste-effort */ }
    toast('⚠️ Koersverversing afgebroken');
    prog.innerHTML = `<p class="explain">⚠️ ${escapeHTML(message)}</p>`;
  } finally {
    priceRefreshBusy = false;
    btn.disabled = !networkConsentEnabled();
    renderPriceRefreshStatus();
  }
});

/* ---------- alerts ---------- */
function runAlertCheck(notify) {
  if (!state.txs.length) return;
  const { alerts, newlyTriggered } = checkAlerts(state.txs);
  const fired = alerts.filter(a => a.triggered);
  $('#alert-dot').style.display = fired.length ? '' : 'none';
  const chip = $('#alert-chip');
  chip.style.display = fired.length ? '' : 'none';
  chip.textContent = `🔔 ${fired.length} alert${fired.length === 1 ? '' : 's'}`;
  if (notify) {
    for (const rule of newlyTriggered) {
      toast(`🔔 Alert: ${describeAlert(rule)} — nu ${ALERT_METRICS[rule.metric].fmt(rule.value)}`);
    }
  }
  if ($('#view-settings').classList.contains('active')) renderAlertList();
}

$('#alert-chip').addEventListener('click', () => gotoView('settings'));

function renderAlertList() {
  const alerts = loadAlerts();
  const holder = $('#alert-list');
  if (!alerts.length) {
    holder.innerHTML = '<div class="palette-empty">Nog geen alerts — stel er hierboven één in, bv. "BTC · RSI zakt onder 30".</div>';
    return;
  }
  holder.innerHTML = '';
  for (const rule of alerts) {
    const row = document.createElement('div');
    row.className = 'ai-insight alert-row';
    const valueTxt = rule.value !== null && rule.value !== undefined ? ALERT_METRICS[rule.metric].fmt(rule.value) : '—';
    row.innerHTML = `
      <div class="ai-icon">${rule.triggered ? '🔔' : '⏳'}</div>
      <div class="alert-desc"><b>${describeAlert(rule)}</b><br><span style="font-size:12px;color:var(--text-3)">huidige waarde: ${valueTxt}</span></div>
      <span class="alert-status ${rule.triggered ? 'fired' : 'armed'}">${rule.triggered ? 'AFGEGAAN' : 'actief'}</span>
      <button class="tx-del" title="Verwijderen">✕</button>`;
    row.querySelector('.tx-del').addEventListener('click', () => {
      saveAlerts(loadAlerts().filter(a => a.id !== rule.id));
      renderAlertList();
      runAlertCheck(false);
      toast('Alert verwijderd');
    });
    holder.appendChild(row);
  }
}

$('#al-add').addEventListener('click', () => {
  const asset = $('#al-asset').value;
  const threshold = parseFloat($('#al-value').value);
  if (!asset || !isFinite(threshold)) { toast('⚠️ Vul een waarde in'); return; }
  const alerts = loadAlerts();
  alerts.push({
    id: 'al-' + Date.now(),
    asset,
    metric: $('#al-metric').value,
    op: $('#al-op').value,
    threshold,
    triggered: false,
  });
  saveAlerts(alerts);
  $('#al-value').value = '';
  runAlertCheck(true);
  renderAlertList();
  toast('🔔 Alert ingesteld');
});


/* ============================================================
   INIT — bewust als allerlaatste, zodat een fout tijdens het
   renderen nooit de event-listeners hierboven kan blokkeren.
   ============================================================ */
try {
  loadWatchAssets();      // watch-only assets (catalogus) registreren
  state.watchlist = loadWatchlist();
  applyLiveHistory();     // eerder opgehaalde gedateerde bronhistorie toepassen
  const dcaBooked = executeDuePlans(state.txs);
  if (dcaBooked.length) setTimeout(() => toast(`⟳ ${dcaBooked.length} DCA-termijn${dcaBooked.length > 1 ? 'en' : ''} geboekt`), 1200);
  rebuildAssetSelects();
  const positions = computePositions(state.txs);
  if (positions.length) state.selectedAsset = positions[0].asset.id;
  else if (ASSETS.length) state.selectedAsset = ASSETS[0].id;
  renderDashboard(true);
  updateEmptyOverlay();
  $('#mode-note').textContent = `Portfoliodata lokaal · netwerk ${networkConsentEnabled() ? 'aan' : 'uit'}`;
  initLivePrices()
    .catch(error => savePriceRefreshMeta({ completedAt: Date.now(), lastError: cleanDisplayText(error?.message || 'Startverversing mislukt.', 160) }))
    .finally(() => syncAutoRefreshTimer());
  runAlertCheck(false);
  // warm alvast een model op voor de grootste positie (achtergrond)
  setTimeout(() => {
    const pos2 = computePositions(state.txs);
    if (pos2.length && analysisAvailable(pos2[0].asset.id, 500)) trainAssetModel(pos2[0].asset);
  }, 800);
} catch (e) {
  console.error('Init-fout:', e);
  toast('⚠️ Er ging iets mis bij het laden — de app blijft bruikbaar. (' + e.message + ')');
  updateEmptyOverlay();
}


/* ---------- auto-tune (walk-forward) ---------- */
$('#bt-tune').addEventListener('click', () => {
  if (!ASSETS.length) return;
  const assetId = $('#bt-asset').value || state.selectedAsset;
  if (!analysisAvailable(assetId, 730)) { $('#bt-tune-result').innerHTML = unavailableHTML(730); return; }
  const a = assetById(assetId);
  const tune = autoTuneBacktest(assetId);
  const best = [...tune.results].sort((x, y) => y.oosRet - x.oosRet)[0];

  const fmtCell = v => `<span class="pct ${v >= 0 ? 'up' : 'down'}">${fmtPct(v, 1)}</span>`;
  $('#bt-tune-result').innerHTML = `
    <div class="card">
      <div class="card-head"><h2>🎯 Auto-tune — walk-forward validatie <span class="tag tag-ai">${a.name}</span></h2></div>
      <div class="table-wrap"><table class="holdings-table">
        <thead><tr><th>Strategie</th><th>Beste drempel</th><th>In-sample (${tune.isDays}d, geoptimaliseerd)</th><th>Out-of-sample (${tune.oosDays}d, eerlijk)</th><th>B&H out-of-sample</th></tr></thead>
        <tbody>${tune.results.map(r => `
          <tr style="cursor:default">
            <td><b>${r.name}</b></td>
            <td class="mono">${r.thr.toFixed(3).replace('.', ',')}</td>
            <td>${fmtCell(r.isRet)}</td>
            <td>${fmtCell(r.oosRet)}</td>
            <td>${fmtCell(tune.bhOOS)}</td>
          </tr>`).join('')}
        </tbody>
      </table></div>
      <p class="explain">De drempel is gekozen op de <b>eerste 70%</b> van de data en daarna getest op de <b>laatste 30%</b> die het algoritme nooit zag. Het verschil tussen die twee kolommen is de overfitting-belasting: in-sample cijfers zijn altijd te mooi. ${best.oosRet > tune.bhOOS ? `<b>${best.name}</b> hield ook out-of-sample stand tegen kopen-en-vasthouden — bescheiden bewijs dat het signaal iets vangt.` : `Out-of-sample won kopen-en-vasthouden alsnog — de getunede drempel generaliseerde niet. Dit is precies waarom je nooit op in-sample resultaten mag vertrouwen.`} De schuif hieronder is op de beste drempel (${best.thr.toFixed(3).replace('.', ',')}) gezet.</p>
    </div>`;

  $('#bt-threshold').value = best.thr;
  runBacktest(false);
  toast(`🎯 Auto-tune klaar — drempel ${best.thr.toFixed(3).replace('.', ',')} (${best.name})`);
});


/* ---------- sorteerbare posities ---------- */
$('#holdings-head').addEventListener('click', e => {
  const th = e.target.closest('th.sortable');
  if (!th) return;
  const key = th.dataset.sort;
  if (state.holdingsSort.key === key) state.holdingsSort.dir *= -1;
  else state.holdingsSort = { key, dir: key === 'name' ? 1 : -1 };
  renderHoldings(computePositions(state.txs));
});

/* ============================================================
   DCA-PLANNEN
   ============================================================ */
const DCA_MODE_TEXT = {
  fixed: 'Vast bedrag: elke maand exact hetzelfde bedrag — klassieke DCA.',
  ai: 'AI-gestuurd: het maandbedrag schaalt mee met het ensemble-signaal (0,5×–1,75×). Extra inleg bij oversold (RSI < 30) of een koopsignaal, minder bij euforie. Contrair — je koopt meer als het goedkoop voelt en minder als iedereen juicht.',
};
let dcaMode = 'fixed';

$('#dca-mode').addEventListener('click', e => {
  const btn = e.target.closest('button');
  if (!btn) return;
  $$('#dca-mode button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  dcaMode = btn.dataset.mode;
  $('#dca-mode-explain').textContent = DCA_MODE_TEXT[dcaMode];
  renderDcaPreview();
});

function renderDca() {
  if (!ASSETS.length) return;
  renderDcaPreview();
  renderDcaPlans();
}

function dcaFormValues() {
  return {
    name: $('#dca-name').value.trim(),
    asset: $('#dca-asset').value,
    amount: parseFloat($('#dca-amount').value) || 0,
    day: Math.min(28, Math.max(1, parseInt($('#dca-day').value, 10) || 1)),
  };
}

function renderDcaPreview() {
  const { asset, amount, day } = dcaFormValues();
  const holder = $('#dca-preview');
  if (!asset || amount <= 0) { holder.innerHTML = ''; return; }
  const sim = simulateDca(asset, amount, day, 12);
  if (!sim) { holder.innerHTML = unavailableHTML(Math.min(HISTORY_DAYS, Math.ceil(12 * 31))); return; }
  const a = assetById(asset);
  const card = (title, s) => `
    <div class="dca-preview-card">
      <h4>${title}</h4>
      <div style="font-size:13px;line-height:1.8">
        Ingelegd: <b>${fmtEUR.format(s.invested)}</b> · Waarde nu: <b>${fmtEUR.format(s.value)}</b><br>
        Rendement: <b class="pct ${s.ret >= 0 ? 'up' : 'down'}">${fmtPct(s.ret, 1)}</b> · ${s.buys.length} aankopen
      </div>
    </div>`;
  holder.innerHTML = `
    <p class="explain" style="margin-bottom:0">📊 <b>Simulatie:</b> was dit plan 12 maanden geleden gestart op ${escapeHTML(a.name)}:</p>
    <div class="dca-preview-grid">
      ${card('Vast bedrag', sim.fixed)}
      ${card('AI-gestuurd', sim.ai)}
    </div>`;
}
['dca-asset', 'dca-amount', 'dca-day'].forEach(id => $(`#${id}`).addEventListener('input', renderDcaPreview));

$('#dca-create').addEventListener('click', () => {
  const { name, asset, amount, day } = dcaFormValues();
  if (!asset || amount < 10) { toast('⚠️ Vul een asset en een bedrag (≥ €10) in'); return; }
  const plans = loadDcaPlans();
  plans.push({
    id: 'plan-' + Date.now(),
    name: cleanDisplayText(name || `${fmtEUR.format(amount)}/mnd → ${asset}`, 80),
    asset, amount, day,
    mode: dcaMode,
    active: true,
    createdAt: new Date().toISOString(),
    lastRun: null,
  });
  saveDcaPlans(plans);
  $('#dca-name').value = '';
  renderDcaPlans();
  toast('⟳ DCA-plan aangemaakt — eerste inleg op de eerstvolgende plandag');
});

function renderDcaPlans() {
  const plans = loadDcaPlans();
  const holder = $('#dca-plans');
  if (!plans.length) {
    holder.innerHTML = '<div class="card"><div class="palette-empty">Nog geen plannen — maak er hierboven één aan. Termijnen worden automatisch geboekt zodra je de app opent op of na de plandag.</div></div>';
    return;
  }
  holder.innerHTML = '';
  for (const plan of plans) {
    const a = assetById(plan.asset) || { name: plan.asset, id: plan.asset, color: '#5c6580' };
    const stats = dcaPlanStats(plan, state.txs);
    const next = nextDcaDate(plan);
    const mult = plan.mode === 'ai' ? dcaAiMultiplier(plan.asset, HISTORY_DAYS - 1) : 1;
    const card = document.createElement('div');
    card.className = 'dca-plan-card';
    card.innerHTML = `
      <div class="asset-dot" style="background:${a.color}">${a.id.slice(0, 4)}</div>
      <div class="dca-plan-info">
        <div class="dca-plan-title">${escapeHTML(plan.name)}
          <span class="tag ${plan.mode === 'ai' ? 'tag-ai' : 'tag-dca'}">${plan.mode === 'ai' ? 'AI-gestuurd' : 'vast'}</span>
          ${plan.active ? '' : '<span class="tag tag-paused">gepauzeerd</span>'}
        </div>
        <div class="dca-plan-sub">${fmtEUR.format(plan.amount)}/maand → ${escapeHTML(a.name)} · dag ${plan.day}<br>
        volgende: <b>${fmtDate.format(next)}</b>${plan.mode === 'ai' ? ` · verwacht ${fmtEUR.format(plan.amount * mult)} (signaal ${mult}×)` : ''}${plan.blockedAt ? '<br><span class="pct down">wacht op een waargenomen koers voor een openstaande termijn</span>' : ''}</div>
      </div>
      <div class="dca-stat"><div class="v">${stats.runs}</div><div class="l">termijnen</div></div>
      <div class="dca-stat"><div class="v">${fmtEUR.format(stats.invested)}</div><div class="l">ingelegd</div></div>
      <div class="dca-stat"><div class="v">${fmtEUR.format(stats.value)}</div><div class="l">waarde nu</div></div>
      <div class="dca-stat"><div class="v ${stats.ret >= 0 ? 'pct up' : 'pct down'}">${fmtPct(stats.ret, 1)}</div><div class="l">rendement</div></div>
      <div class="head-controls">
        <button class="btn btn-ghost btn-xs" data-act="toggle">${plan.active ? '⏸ Pauzeer' : '▶ Hervat'}</button>
        <button class="btn btn-ghost btn-xs btn-danger" data-act="del">✕</button>
      </div>`;
    card.querySelector('[data-act="toggle"]').addEventListener('click', () => {
      plan.active = !plan.active;
      saveDcaPlans(plans);
      renderDcaPlans();
    });
    card.querySelector('[data-act="del"]').addEventListener('click', () => {
      if (!confirm(`Plan "${plan.name}" verwijderen? Al geboekte transacties blijven staan.`)) return;
      saveDcaPlans(plans.filter(p => p.id !== plan.id));
      renderDcaPlans();
      toast('Plan verwijderd');
    });
    holder.appendChild(card);
  }
}
