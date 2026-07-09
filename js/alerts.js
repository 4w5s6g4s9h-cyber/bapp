/* ============================================================
   alerts.js — koers- en signaalalerts
   Regels staan in localStorage en worden bij het openen van de
   app (en na live koersupdates) geëvalueerd. Geen server, dus
   alleen in-app meldingen.
   ============================================================ */

const ALERT_KEY = 'vermogen_alerts_v1';

const ALERT_METRICS = {
  price:    { label: 'Koers (€)',        fmt: v => fmtEUR2.format(v) },
  change24: { label: '24u-verandering (%)', fmt: v => fmtPct(v) },
  rsi:      { label: 'RSI (14)',         fmt: v => v.toFixed(0) },
  weight:   { label: 'Weging in portefeuille (%)', fmt: v => v.toFixed(1).replace('.', ',') + '%' },
};

function loadAlerts() {
  try { return JSON.parse(localStorage.getItem(ALERT_KEY)) || []; }
  catch (e) { return []; }
}
function saveAlerts(alerts) { localStorage.setItem(ALERT_KEY, JSON.stringify(alerts)); }

/** Huidige waarde van een metric voor een asset. */
function alertMetricValue(rule, positions, total) {
  const prices = MARKET.prices[rule.asset];
  if (!prices) return null;
  const last = prices[HISTORY_DAYS - 1];
  switch (rule.metric) {
    case 'price': return last;
    case 'change24': return (last / prices[HISTORY_DAYS - 2] - 1) * 100;
    case 'rsi': {
      const r = rsi(prices, 14);
      return r[r.length - 1];
    }
    case 'weight': {
      const pos = positions.find(p => p.asset.id === rule.asset);
      return pos && total > 0 ? (pos.value / total) * 100 : 0;
    }
    default: return null;
  }
}

/**
 * Evalueert alle regels. Retourneert regels met {value, triggered}.
 * newlyTriggered = alerts die nu afgaan maar bij de vorige check niet.
 */
function checkAlerts(txs) {
  const alerts = loadAlerts();
  if (!alerts.length) return { alerts: [], newlyTriggered: [] };
  const positions = computePositions(txs);
  const total = positions.reduce((s, p) => s + p.value, 0);
  const newlyTriggered = [];

  for (const rule of alerts) {
    const value = alertMetricValue(rule, positions, total);
    rule.value = value;
    const wasTriggered = rule.triggered || false;
    rule.triggered = value !== null && (rule.op === '>' ? value > rule.threshold : value < rule.threshold);
    if (rule.triggered && !wasTriggered) newlyTriggered.push(rule);
  }
  saveAlerts(alerts);
  return { alerts, newlyTriggered };
}

function describeAlert(rule) {
  const m = ALERT_METRICS[rule.metric];
  return `${rule.asset} · ${m.label} ${rule.op} ${m.fmt(rule.threshold)}`;
}
