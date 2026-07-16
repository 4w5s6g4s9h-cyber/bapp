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
  try {
    const parsed = JSON.parse(localStorage.getItem(ALERT_KEY)) || [];
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, 250).map((rule, index) => {
      const asset = normalizeAssetId(rule?.asset);
      const threshold = Number(rule?.threshold);
      if (!asset || !Object.hasOwn(ALERT_METRICS, rule?.metric) || !['>', '<'].includes(rule?.op) || !Number.isFinite(threshold)) return null;
      return {
        id: cleanDisplayText(rule.id || `alert-${index}`, 100), asset,
        metric: rule.metric, op: rule.op, threshold,
        triggered: rule.triggered === true,
        value: Number.isFinite(Number(rule.value)) ? Number(rule.value) : null,
      };
    }).filter(Boolean);
  }
  catch (e) { return []; }
}
function saveAlerts(alerts) {
  if (!Array.isArray(alerts)) throw new Error('Alerts moeten een lijst zijn.');
  localStorage.setItem(ALERT_KEY, JSON.stringify(alerts));
}

/** Huidige waarde van een metric voor een asset. */
function alertMetricValue(rule, positions, total) {
  const prices = MARKET.prices[rule.asset];
  if (!prices) return null;
  const last = prices[HISTORY_DAYS - 1];
  switch (rule.metric) {
    case 'price': return isObservedPrice(rule.asset, HISTORY_DAYS - 1) ? last : null;
    case 'change24': return isObservedPrice(rule.asset, HISTORY_DAYS - 1) && isObservedPrice(rule.asset, HISTORY_DAYS - 2)
      ? (last / prices[HISTORY_DAYS - 2] - 1) * 100 : null;
    case 'rsi': {
      if (!hasReliableHistory(rule.asset, 365)) return null;
      const r = rsi(prices, 14);
      return r[r.length - 1];
    }
    case 'weight': {
      if (!isFreshPrice(rule.asset, HISTORY_DAYS - 1)) return null;
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
  if (!m) return 'Ongeldige alert';
  return `${rule.asset} · ${m.label} ${rule.op} ${m.fmt(rule.threshold)}`;
}
