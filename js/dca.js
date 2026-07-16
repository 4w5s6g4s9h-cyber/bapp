/* ============================================================
   dca.js — DCA-plannen (dollar-cost averaging)
   Meerdere plannen; vast bedrag of AI-gestuurd (het maandbedrag
   schaalt mee met het ensemble-signaal: extra inleg bij oversold,
   minder bij euforie). Vervallen termijnen worden bij het openen
   van de app automatisch als transacties uitgevoerd.
   ============================================================ */

const DCA_KEY = 'vermogen_dca_v1';

function loadDcaPlans() {
  try {
    const parsed = JSON.parse(localStorage.getItem(DCA_KEY)) || [];
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, 100).map((plan, index) => {
      const asset = normalizeAssetId(plan?.asset);
      const amount = Number(plan?.amount), day = Number(plan?.day);
      const created = new Date(plan?.createdAt);
      if (!asset || !Number.isFinite(amount) || amount < 10 || amount > 1e7
          || !Number.isInteger(day) || day < 1 || day > 28 || !Number.isFinite(created.getTime())) return null;
      const lastRun = plan.lastRun && Number.isFinite(new Date(plan.lastRun).getTime()) ? new Date(plan.lastRun).toISOString() : null;
      return {
        id: cleanDisplayText(plan.id || `plan-${index}`, 100),
        name: cleanDisplayText(plan.name || `${asset} DCA`, 80),
        asset, amount, day, mode: plan.mode === 'ai' ? 'ai' : 'fixed',
        active: plan.active !== false, createdAt: created.toISOString(), lastRun,
        ...(plan.blockedAt ? { blockedAt: String(plan.blockedAt) } : {}),
      };
    }).filter(Boolean);
  }
  catch (e) { return []; }
}
function saveDcaPlans(plans) {
  if (!Array.isArray(plans)) throw new Error('DCA-plannen moeten een lijst zijn.');
  localStorage.setItem(DCA_KEY, JSON.stringify(plans));
}

/**
 * AI-multiplier voor een inlegmoment (contrair: méér inleggen als het
 * signaal/RSI op "goedkoop" staat, minder bij euforie). Bereik 0,5–1,75.
 */
function dcaAiMultiplier(assetId, idx) {
  const prices = MARKET.prices[assetId];
  if (!prices) return 1;
  // Nooit koersen ná het inlegmoment gebruiken. Bij weinig historie vallen
  // langlopende indicatoren vanzelf terug naar een neutrale score.
  const upto = prices.slice(0, Math.max(1, idx + 1));
  const sig = computeSignal(upto);
  let mult = 1;
  if (sig.label === 'Koop') mult = 1.25;
  else if (sig.label === 'Verkoop') mult = 0.75;
  if (sig.rsi < 30) mult += 0.5;        // oversold: dip bijkopen
  else if (sig.rsi > 70) mult -= 0.25;  // overbought: inleg temperen
  return Math.min(1.75, Math.max(0.5, Math.round(mult * 100) / 100));
}

/** Eerstvolgende uitvoerdatum van een plan (na `after`). */
function nextDcaDate(plan, after = new Date()) {
  const d = new Date(after.getFullYear(), after.getMonth(), plan.day, 12);
  if (d <= after) d.setMonth(d.getMonth() + 1);
  return d;
}

/**
 * Voert alle vervallen termijnen uit (sinds aanmaak/laatste run t/m nu).
 * Retourneert de aangemaakte transacties.
 */
function executeDuePlans(txs) {
  const plans = loadDcaPlans();
  const created = [];
  const now = new Date();

  for (const plan of plans) {
    if (!plan.active) continue;
    let cursor = new Date(plan.lastRun || plan.createdAt);
    let guard = 0;
    while (guard++ < 60) {
      const due = nextDcaDate(plan, cursor);
      if (due > now) break;
      const dueIdx = Math.max(0, dateToIndexUnclamped(due));
      const nowIdx = Math.min(HISTORY_DAYS - 1, dateToIndexUnclamped(now));
      let idx = -1;
      for (let candidate = dueIdx; candidate <= nowIdx; candidate++) {
        if (isObservedPrice(plan.asset, candidate)) { idx = candidate; break; }
      }
      const price = idx >= 0 && MARKET.prices[plan.asset] ? MARKET.prices[plan.asset][idx] : null;
      if (price && price > 0) {
        const mult = plan.mode === 'ai' ? dcaAiMultiplier(plan.asset, idx) : 1;
        const amount = plan.amount * mult;
        const executionDate = MARKET.dates[idx];
        created.push({
          id: `dca-${plan.id}-${due.getFullYear()}${String(due.getMonth() + 1).padStart(2, '0')}`,
          date: executionDate.toISOString(),
          type: 'buy',
          asset: plan.asset,
          qty: amount / price,
          price: +price.toPrecision(12),
          external: true,
          dca: { plan: plan.name, mult },
        });
        delete plan.blockedAt;
      } else {
        // Geen fictieve transactie boeken op carried/gereconstrueerde data.
        // Laat de termijn openstaan tot de eerste waargenomen koers op of na
        // de plandatum beschikbaar is (bij een weekend doorgaans maandag).
        plan.blockedAt = due.toISOString();
        break;
      }
      plan.lastRun = due.toISOString();
      cursor = due;
    }
  }
  if (created.length) {
    // dubbele uitvoeringen voorkomen (zelfde plan+maand)
    const existing = new Set(txs.map(t => t.id));
    const fresh = created.filter(t => !existing.has(t.id));
    txs.push(...fresh);
    saveTransactions(txs);
    saveDcaPlans(plans);
    return fresh;
  }
  saveDcaPlans(plans);
  return [];
}

/** Statistieken van een plan: wat hebben de DCA-transacties opgeleverd? */
function dcaPlanStats(plan, txs) {
  const mine = txs.filter(t => String(t.id).startsWith(`dca-${plan.id}-`));
  const invested = mine.reduce((s, t) => s + t.qty * t.price, 0);
  const qty = mine.reduce((s, t) => s + t.qty, 0);
  const price = MARKET.prices[plan.asset] ? lastPrice(plan.asset) : 0;
  const value = qty * price;
  return { runs: mine.length, invested, qty, value, ret: invested > 0 ? (value / invested - 1) * 100 : 0 };
}

/**
 * Simulatie: wat had dit plan de afgelopen `months` maanden gedaan?
 * Retourneert {fixed, ai} elk met {invested, value, ret, buys:[{idx, amount}]}.
 */
function simulateDca(assetId, amount, day, months = 12) {
  const prices = MARKET.prices[assetId];
  const days = Math.min(HISTORY_DAYS, Math.ceil(months * 31));
  if (!prices || !hasReliableHistory(assetId, days)) return null;
  const now = new Date();

  const runMode = (mode) => {
    let qty = 0, invested = 0;
    const buys = [];
    for (let m = months; m >= 1; m--) {
      const d = new Date(now.getFullYear(), now.getMonth() - m, day, 12);
      const idx = dateToIndex(d.toISOString());
      const p = prices[idx];
      if (!p || p <= 0) continue;
      const mult = mode === 'ai' ? dcaAiMultiplier(assetId, idx) : 1;
      const amt = amount * mult;
      qty += amt / p;
      invested += amt;
      buys.push({ idx, amount: amt, mult });
    }
    const value = qty * prices[HISTORY_DAYS - 1];
    return { invested, value, ret: invested > 0 ? (value / invested - 1) * 100 : 0, buys };
  };
  return { fixed: runMode('fixed'), ai: runMode('ai') };
}
