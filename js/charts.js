/* ============================================================
   charts.js — eigen SVG/canvas grafiek-engine
   Geen dependencies; volledig interactief (crosshair, tooltips,
   hover-states, animaties).
   ============================================================ */

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

let gradCounter = 0;

/**
 * Interactieve lijngrafiek.
 * opts: {
 *   labels: Date[]  (x-as)
 *   series: [{ name, color, values: (number|null)[], fill?, dash?, width? }]
 *   band: { upper:[], lower:[], color, offset }  (optioneel, offset = startindex)
 *   yFmt: fn, yMin?, yMax?, markers?: [{index, color, label}]
 * }
 */
function renderLineChart(container, opts) {
  container.innerHTML = '';
  const W = container.clientWidth || 600;
  const H = container.clientHeight || 300;
  const pad = { l: 56, r: 14, t: 12, b: 26 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;

  const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}` });
  container.appendChild(svg);

  // --- schaal ---
  const allVals = [];
  for (const s of opts.series) for (const v of s.values) if (v !== null && isFinite(v)) allVals.push(v);
  if (opts.band) { allVals.push(...opts.band.upper, ...opts.band.lower); }
  if (!allVals.length) return;
  let yMin = opts.yMin ?? Math.min(...allVals);
  let yMax = opts.yMax ?? Math.max(...allVals);
  if (yMax === yMin) { yMax += 1; yMin -= 1; }
  const yPad = (yMax - yMin) * 0.08;
  if (opts.yMin === undefined) yMin -= yPad;
  if (opts.yMax === undefined) yMax += yPad;

  const n = Math.max(...opts.series.map(s => s.values.length));
  const x = i => pad.l + (n <= 1 ? 0 : (i / (n - 1)) * iw);
  const y = v => pad.t + (1 - (v - yMin) / (yMax - yMin)) * ih;

  // --- grid + y-labels ---
  const ticks = 4;
  for (let t = 0; t <= ticks; t++) {
    const val = yMin + (t / ticks) * (yMax - yMin);
    const yy = y(val);
    svg.appendChild(svgEl('line', { x1: pad.l, x2: W - pad.r, y1: yy, y2: yy, stroke: 'rgba(255,255,255,0.055)', 'stroke-width': 1 }));
    const label = svgEl('text', { x: pad.l - 9, y: yy + 4, 'text-anchor': 'end', fill: '#5c6580', 'font-size': 10.5, 'font-family': 'Inter, sans-serif' });
    label.textContent = (opts.yFmt || (v => Math.round(v)))(val);
    svg.appendChild(label);
  }

  // --- x-labels ---
  if (opts.labels && opts.labels.length) {
    const step = Math.max(1, Math.floor(n / 6));
    for (let i = 0; i < n; i += step) {
      const d = opts.labels[i];
      if (!d) continue;
      const label = svgEl('text', { x: x(i), y: H - 7, 'text-anchor': 'middle', fill: '#5c6580', 'font-size': 10.5, 'font-family': 'Inter, sans-serif' });
      label.textContent = d instanceof Date ? fmtDateShort.format(d) : d;
      svg.appendChild(label);
    }
  }

  // --- band (onzekerheidsinterval) ---
  if (opts.band) {
    const { upper, lower, color, offset = 0 } = opts.band;
    let dPath = '';
    for (let i = 0; i < upper.length; i++) dPath += `${i ? 'L' : 'M'}${x(offset + i)},${y(upper[i])}`;
    for (let i = lower.length - 1; i >= 0; i--) dPath += `L${x(offset + i)},${y(lower[i])}`;
    dPath += 'Z';
    svg.appendChild(svgEl('path', { d: dPath, fill: color || 'rgba(124,107,255,0.13)', stroke: 'none' }));
  }

  // --- series ---
  for (const s of opts.series) {
    // segmenten van niet-null waarden
    let d = '', started = false, firstIdx = null, lastIdx = null;
    for (let i = 0; i < s.values.length; i++) {
      const v = s.values[i];
      if (v === null || !isFinite(v)) { started = false; continue; }
      d += `${started ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      started = true;
      if (firstIdx === null) firstIdx = i;
      lastIdx = i;
    }
    if (!d) continue;

    if (s.fill) {
      const gid = `grad-${++gradCounter}`;
      const defs = svgEl('defs');
      const grad = svgEl('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 });
      grad.appendChild(svgEl('stop', { offset: '0%', 'stop-color': s.color, 'stop-opacity': 0.28 }));
      grad.appendChild(svgEl('stop', { offset: '100%', 'stop-color': s.color, 'stop-opacity': 0 }));
      defs.appendChild(grad);
      svg.appendChild(defs);
      const areaD = d + `L${x(lastIdx)},${y(yMin)}L${x(firstIdx)},${y(yMin)}Z`;
      svg.appendChild(svgEl('path', { d: areaD, fill: `url(#${gid})`, stroke: 'none' }));
    }

    const path = svgEl('path', {
      d, fill: 'none', stroke: s.color,
      'stroke-width': s.width || 2.2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    });
    if (s.dash) path.setAttribute('stroke-dasharray', s.dash);
    svg.appendChild(path);
  }

  // --- markers (bv. koop/verkoop) ---
  if (opts.markers) {
    for (const m of opts.markers) {
      const v = opts.series[0].values[m.index];
      if (v === null || v === undefined) continue;
      svg.appendChild(svgEl('circle', { cx: x(m.index), cy: y(v), r: 4, fill: m.color, stroke: '#0a0c14', 'stroke-width': 1.5 }));
    }
  }

  // --- interactie: crosshair + tooltip ---
  const crossLine = svgEl('line', { y1: pad.t, y2: H - pad.b, stroke: 'rgba(255,255,255,0.22)', 'stroke-width': 1, 'stroke-dasharray': '3 3', visibility: 'hidden' });
  svg.appendChild(crossLine);
  const dots = opts.series.map(s => {
    const c = svgEl('circle', { r: 4.2, fill: s.color, stroke: '#0a0c14', 'stroke-width': 2, visibility: 'hidden' });
    svg.appendChild(c);
    return c;
  });

  const tooltip = document.createElement('div');
  tooltip.className = 'chart-tooltip';
  container.appendChild(tooltip);

  svg.addEventListener('mousemove', (e) => {
    const rect = svg.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const i = Math.round(((mx - pad.l) / iw) * (n - 1));
    if (i < 0 || i >= n) return;
    const xx = x(i);
    crossLine.setAttribute('x1', xx); crossLine.setAttribute('x2', xx);
    crossLine.setAttribute('visibility', 'visible');

    let html = '';
    if (opts.labels && opts.labels[i]) {
      const d = opts.labels[i];
      html += `<div class="tt-date">${d instanceof Date ? fmtDate.format(d) : d}</div>`;
    }
    opts.series.forEach((s, si) => {
      const v = s.values[i];
      if (v === null || v === undefined || !isFinite(v)) { dots[si].setAttribute('visibility', 'hidden'); return; }
      dots[si].setAttribute('cx', xx); dots[si].setAttribute('cy', y(v));
      dots[si].setAttribute('visibility', 'visible');
      html += `<div class="tt-val" style="color:${s.color}">${s.name ? s.name + ': ' : ''}${(opts.yFmt || (x => x.toFixed(2)))(v)}</div>`;
    });
    tooltip.innerHTML = html;
    tooltip.style.opacity = 1;
    const tw = tooltip.offsetWidth;
    tooltip.style.left = Math.min(Math.max(xx - tw / 2, 4), W - tw - 4) + 'px';
    tooltip.style.top = (pad.t - 4) + 'px';
  });
  svg.addEventListener('mouseleave', () => {
    crossLine.setAttribute('visibility', 'hidden');
    dots.forEach(d => d.setAttribute('visibility', 'hidden'));
    tooltip.style.opacity = 0;
  });
}

/** Sparkline als inline SVG-string */
function sparklineSVG(values, w = 110, h = 32, color = '#7c6bff') {
  const min = Math.min(...values), max = Math.max(...values);
  const range = max - min || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - 3 - ((v - min) / range) * (h - 6)}`).join(' ');
  const up = values[values.length - 1] >= values[0];
  const c = up ? '#34d399' : '#fb7185';
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline points="${pts}" fill="none" stroke="${c}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

/** Interactieve donut met center-label */
function renderDonut(container, legendEl, segments, totalLabel) {
  container.innerHTML = '';
  if (legendEl) legendEl.innerHTML = '';
  const size = 200, cx = size / 2, cy = size / 2, r = 74, thick = 26;
  const svg = svgEl('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}` });
  container.appendChild(svg);

  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  let angle = -Math.PI / 2;

  const centerBig = svgEl('text', { x: cx, y: cy - 2, 'text-anchor': 'middle', fill: '#eef1fa', 'font-size': 19, 'font-weight': 800, 'font-family': 'Inter, sans-serif' });
  const centerSmall = svgEl('text', { x: cx, y: cy + 18, 'text-anchor': 'middle', fill: '#5c6580', 'font-size': 11, 'font-family': 'Inter, sans-serif' });
  const setCenter = (big, small) => { centerBig.textContent = big; centerSmall.textContent = small; };
  setCenter(totalLabel, 'totaal');

  const arcs = [];
  for (const seg of segments) {
    const frac = seg.value / total;
    const a0 = angle, a1 = angle + frac * Math.PI * 2 - 0.03;
    angle += frac * Math.PI * 2;
    const large = (a1 - a0) > Math.PI ? 1 : 0;
    const p0x = cx + r * Math.cos(a0), p0y = cy + r * Math.sin(a0);
    const p1x = cx + r * Math.cos(a1), p1y = cy + r * Math.sin(a1);
    const path = svgEl('path', {
      d: `M${p0x},${p0y} A${r},${r} 0 ${large} 1 ${p1x},${p1y}`,
      fill: 'none', stroke: seg.color, 'stroke-width': thick, 'stroke-linecap': 'butt',
    });
    path.style.transition = 'stroke-width 0.18s ease, opacity 0.18s ease';
    path.style.cursor = 'pointer';
    svg.appendChild(path);
    arcs.push({ path, seg, frac });
  }
  svg.appendChild(centerBig);
  svg.appendChild(centerSmall);

  function highlight(active) {
    for (const a of arcs) {
      a.path.style.opacity = (active && a !== active) ? 0.25 : 1;
      a.path.setAttribute('stroke-width', a === active ? thick + 7 : thick);
    }
    if (active) setCenter(`${(active.frac * 100).toFixed(1).replace('.', ',')}%`, active.seg.name);
    else setCenter(totalLabel, 'totaal');
  }

  for (const a of arcs) {
    a.path.addEventListener('mouseenter', () => highlight(a));
    a.path.addEventListener('mouseleave', () => highlight(null));
  }

  if (legendEl) {
    for (const a of arcs) {
      const row = document.createElement('div');
      row.className = 'legend-row';
      row.innerHTML = `<div class="legend-swatch" style="background:${a.seg.color}"></div>
        <div class="legend-name">${a.seg.name}</div>
        <div class="legend-val">${(a.frac * 100).toFixed(1).replace('.', ',')}%</div>`;
      row.addEventListener('mouseenter', () => highlight(a));
      row.addEventListener('mouseleave', () => highlight(null));
      legendEl.appendChild(row);
    }
  }
}

/** Scatter: risico (x) vs rendement (y), bolgrootte = weging */
function renderScatter(container, points, xFmt, yFmt) {
  container.innerHTML = '';
  const W = container.clientWidth || 500, H = container.clientHeight || 300;
  const pad = { l: 52, r: 20, t: 16, b: 34 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}` });
  container.appendChild(svg);

  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const xMin = Math.min(0, ...xs) , xMax = Math.max(...xs) * 1.15 + 0.01;
  let yMin = Math.min(0, ...ys), yMax = Math.max(...ys);
  const ySpan = (yMax - yMin) || 1;
  yMin -= ySpan * 0.12; yMax += ySpan * 0.15;

  const x = v => pad.l + ((v - xMin) / (xMax - xMin)) * iw;
  const y = v => pad.t + (1 - (v - yMin) / (yMax - yMin)) * ih;

  for (let t = 0; t <= 4; t++) {
    const vy = yMin + (t / 4) * (yMax - yMin);
    svg.appendChild(svgEl('line', { x1: pad.l, x2: W - pad.r, y1: y(vy), y2: y(vy), stroke: 'rgba(255,255,255,0.055)' }));
    const l = svgEl('text', { x: pad.l - 8, y: y(vy) + 4, 'text-anchor': 'end', fill: '#5c6580', 'font-size': 10.5, 'font-family': 'Inter' });
    l.textContent = yFmt(vy); svg.appendChild(l);
    const vx = xMin + (t / 4) * (xMax - xMin);
    const lx = svgEl('text', { x: x(vx), y: H - 8, 'text-anchor': 'middle', fill: '#5c6580', 'font-size': 10.5, 'font-family': 'Inter' });
    lx.textContent = xFmt(vx); svg.appendChild(lx);
  }
  // nullijn
  if (yMin < 0 && yMax > 0) svg.appendChild(svgEl('line', { x1: pad.l, x2: W - pad.r, y1: y(0), y2: y(0), stroke: 'rgba(255,255,255,0.18)', 'stroke-dasharray': '4 4' }));

  const tooltip = document.createElement('div');
  tooltip.className = 'chart-tooltip';
  container.appendChild(tooltip);

  for (const p of points) {
    const cxp = x(p.x), cyp = y(p.y);
    const c = svgEl('circle', { cx: cxp, cy: cyp, r: p.r, fill: p.color + '55', stroke: p.color, 'stroke-width': 2 });
    c.style.cursor = 'pointer';
    c.style.transition = 'r 0.15s ease';
    c.addEventListener('mouseenter', () => {
      c.setAttribute('r', p.r + 4);
      tooltip.innerHTML = `<div class="tt-val" style="color:${p.color}">${p.name}</div>
        <div class="tt-date">risico ${xFmt(p.x)} · rendement ${yFmt(p.y)}</div>`;
      tooltip.style.opacity = 1;
      tooltip.style.left = Math.min(Math.max(cxp - 60, 4), W - 140) + 'px';
      tooltip.style.top = Math.max(cyp - 55, 2) + 'px';
    });
    c.addEventListener('mouseleave', () => { c.setAttribute('r', p.r); tooltip.style.opacity = 0; });
    svg.appendChild(c);
    const lbl = svgEl('text', { x: cxp, y: cyp - p.r - 6, 'text-anchor': 'middle', fill: '#9aa3bd', 'font-size': 10.5, 'font-weight': 600, 'font-family': 'Inter' });
    lbl.textContent = p.name;
    svg.appendChild(lbl);
  }
}

/** Neuraal netwerk visualisatie (gewichten live) */
function renderNetworkViz(container, net) {
  container.innerHTML = '';
  const W = container.clientWidth || 500, H = container.clientHeight || 300;
  const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}` });
  container.appendChild(svg);

  const sizes = net.sizes;
  // input laag samenvatten tot max 10 zichtbare nodes
  const shown = sizes.map(s => Math.min(s, 10));
  const layerX = i => 40 + (i / (sizes.length - 1)) * (W - 80);
  const nodeY = (li, ni) => {
    const cnt = shown[li];
    return H / 2 + (ni - (cnt - 1) / 2) * Math.min(26, (H - 40) / cnt);
  };

  // verbindingen
  for (let l = 0; l < net.weights.length; l++) {
    const Wm = net.weights[l];
    let maxW = 1e-6;
    for (const row of Wm) for (const w of row) maxW = Math.max(maxW, Math.abs(w));
    for (let o = 0; o < Math.min(Wm.length, 10); o++) {
      for (let i = 0; i < Math.min(Wm[o].length, 10); i++) {
        const w = Wm[o][i];
        const strength = Math.abs(w) / maxW;
        if (strength < 0.12) continue;
        svg.appendChild(svgEl('line', {
          x1: layerX(l), y1: nodeY(l, i),
          x2: layerX(l + 1), y2: nodeY(l + 1, o),
          stroke: w > 0 ? 'rgba(52,211,153,0.5)' : 'rgba(251,113,133,0.5)',
          'stroke-width': (0.4 + strength * 2.4).toFixed(2),
          opacity: (0.25 + strength * 0.75).toFixed(2),
        }));
      }
    }
  }
  // nodes
  for (let l = 0; l < sizes.length; l++) {
    for (let n = 0; n < shown[l]; n++) {
      svg.appendChild(svgEl('circle', {
        cx: layerX(l), cy: nodeY(l, n), r: 7,
        fill: '#0e1120', stroke: l === 0 ? '#22d3ee' : l === sizes.length - 1 ? '#7c6bff' : '#5c6580',
        'stroke-width': 2,
      }));
    }
    if (sizes[l] > shown[l]) {
      const t = svgEl('text', { x: layerX(l), y: nodeY(l, shown[l] - 1) + 24, 'text-anchor': 'middle', fill: '#5c6580', 'font-size': 10, 'font-family': 'Inter' });
      t.textContent = `+${sizes[l] - shown[l]}`;
      svg.appendChild(t);
    }
    const cap = svgEl('text', { x: layerX(l), y: 16, 'text-anchor': 'middle', fill: '#5c6580', 'font-size': 10.5, 'font-weight': 600, 'font-family': 'Inter' });
    cap.textContent = l === 0 ? `input (${sizes[l]})` : l === sizes.length - 1 ? 'output' : `hidden (${sizes[l]})`;
    svg.appendChild(cap);
  }
}

/** Monte Carlo fan-chart op canvas (veel paden = canvas sneller) */
function renderMonteCarlo(canvas, mc, startValue) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  const pad = { l: 64, r: 16, t: 14, b: 30 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const { bands, paths, months } = mc;
  const yMax = Math.max(...bands.p95) * 1.05;
  const yMin = 0;
  const x = m => pad.l + (m / months) * iw;
  const y = v => pad.t + (1 - (v - yMin) / (yMax - yMin)) * ih;

  // grid
  ctx.font = '10.5px Inter, sans-serif';
  ctx.fillStyle = '#5c6580';
  ctx.strokeStyle = 'rgba(255,255,255,0.055)';
  for (let t = 0; t <= 4; t++) {
    const v = yMin + (t / 4) * (yMax - yMin);
    ctx.beginPath(); ctx.moveTo(pad.l, y(v)); ctx.lineTo(W - pad.r, y(v)); ctx.stroke();
    ctx.textAlign = 'right';
    ctx.fillText(compactEUR(v), pad.l - 8, y(v) + 4);
  }
  ctx.textAlign = 'center';
  const yearStep = Math.max(1, Math.round(months / 12 / 6));
  for (let yr = 0; yr * 12 <= months; yr += yearStep) {
    ctx.fillText(yr === 0 ? 'nu' : `+${yr}j`, x(yr * 12), H - 9);
  }

  // banden p5-p95 en p25-p75
  const drawBand = (lo, hi, color) => {
    ctx.beginPath();
    ctx.moveTo(x(0), y(hi[0]));
    for (let m = 1; m <= months; m++) ctx.lineTo(x(m), y(hi[m]));
    for (let m = months; m >= 0; m--) ctx.lineTo(x(m), y(lo[m]));
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  };
  drawBand(bands.p5, bands.p95, 'rgba(124,107,255,0.10)');
  drawBand(bands.p25, bands.p75, 'rgba(124,107,255,0.16)');

  // voorbeeldpaden
  ctx.lineWidth = 0.7;
  ctx.strokeStyle = 'rgba(34,211,238,0.16)';
  for (const path of paths) {
    ctx.beginPath();
    ctx.moveTo(x(0), y(path[0]));
    for (let m = 1; m < path.length; m++) ctx.lineTo(x(m), y(path[m]));
    ctx.stroke();
  }

  // mediaan
  ctx.lineWidth = 2.4;
  ctx.strokeStyle = '#7c6bff';
  ctx.beginPath();
  ctx.moveTo(x(0), y(bands.p50[0]));
  for (let m = 1; m <= months; m++) ctx.lineTo(x(m), y(bands.p50[m]));
  ctx.stroke();

  // inleg-lijn (referentie)
  ctx.lineWidth = 1.4;
  ctx.setLineDash([5, 5]);
  ctx.strokeStyle = 'rgba(251,191,36,0.6)';
  ctx.beginPath();
  const monthly = (mc.totalContrib - startValue) / months;
  for (let m = 0; m <= months; m++) {
    const v = startValue + monthly * m;
    if (m === 0) ctx.moveTo(x(m), y(v)); else ctx.lineTo(x(m), y(v));
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

function compactEUR(v) {
  if (v >= 1e6) return '€ ' + (v / 1e6).toFixed(1).replace('.', ',') + ' mln';
  if (v >= 1e3) return '€ ' + Math.round(v / 1e3) + 'k';
  return '€ ' + Math.round(v);
}

/** Horizontale rendement-bars */
function renderReturnBars(container, rows) {
  container.innerHTML = '';
  const maxAbs = Math.max(...rows.map(r => Math.abs(r.pct)), 1);
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'bar-row';
    const w = (Math.abs(r.pct) / maxAbs) * 100;
    const pos = r.pct >= 0;
    row.innerHTML = `
      <div class="bar-label">${r.name}</div>
      <div class="bar-track">
        <div class="bar-fill" style="width:0%; ${pos ? 'left:0' : 'right:0'};
          background:${pos ? 'linear-gradient(90deg, rgba(52,211,153,0.5), rgba(52,211,153,0.9))' : 'linear-gradient(90deg, rgba(251,113,133,0.9), rgba(251,113,133,0.5))'}"></div>
      </div>
      <div class="bar-val ${pos ? 'pct up' : 'pct down'}">${fmtPct(r.pct, 1)}</div>`;
    container.appendChild(row);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      row.querySelector('.bar-fill').style.width = w + '%';
    }));
  }
}

/* ============================================================
   Uitbreidingen: brush (zoom/pan), candlesticks, heatmap,
   efficient-frontier canvas, generieke metric-bars, backtest-canvas
   ============================================================ */

/**
 * Brush/minimap onder een grafiek: sleep het venster (of de randen)
 * om het bereik van de hoofdgrafiek te kiezen.
 * range = {start, end} (indices), onChange(start, end).
 */
function renderBrush(container, values, range, onChange) {
  container.innerHTML = '';
  const W = container.clientWidth || 600, H = 46;
  const pad = { l: 56, r: 14 };
  const iw = W - pad.l - pad.r;
  const n = values.length;
  const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}` });
  svg.style.cursor = 'crosshair';
  container.appendChild(svg);

  const min = Math.min(...values), max = Math.max(...values);
  const rangeV = max - min || 1;
  const x = i => pad.l + (i / (n - 1)) * iw;
  const y = v => 4 + (1 - (v - min) / rangeV) * (H - 10);

  // mini area
  let d = `M${x(0)},${y(values[0])}`;
  const step = Math.max(1, Math.floor(n / 300));
  for (let i = step; i < n; i += step) d += `L${x(i)},${y(values[i])}`;
  d += `L${x(n - 1)},${y(values[n - 1])}`;
  svg.appendChild(svgEl('path', { d: d + `L${x(n - 1)},${H - 2}L${x(0)},${H - 2}Z`, fill: 'rgba(124,107,255,0.12)' }));
  svg.appendChild(svgEl('path', { d, fill: 'none', stroke: 'rgba(124,107,255,0.55)', 'stroke-width': 1.2 }));

  // selectievenster
  const sel = svgEl('rect', { y: 1, height: H - 2, rx: 6, fill: 'rgba(34,211,238,0.10)', stroke: 'rgba(34,211,238,0.55)', 'stroke-width': 1 });
  const hL = svgEl('rect', { y: H / 2 - 9, width: 5, height: 18, rx: 2.5, fill: '#22d3ee' });
  const hR = svgEl('rect', { y: H / 2 - 9, width: 5, height: 18, rx: 2.5, fill: '#22d3ee' });
  sel.style.cursor = 'grab'; hL.style.cursor = 'ew-resize'; hR.style.cursor = 'ew-resize';
  svg.appendChild(sel); svg.appendChild(hL); svg.appendChild(hR);

  let cur = { ...range };
  function draw() {
    const x0 = x(cur.start), x1 = x(cur.end);
    sel.setAttribute('x', x0); sel.setAttribute('width', Math.max(6, x1 - x0));
    hL.setAttribute('x', x0 - 2.5); hR.setAttribute('x', x1 - 2.5);
  }
  draw();

  const idxAt = px => Math.round(Math.max(0, Math.min(1, (px - pad.l) / iw)) * (n - 1));
  let drag = null; // {mode:'move'|'l'|'r', startPx, startRange}

  function onDown(e, mode) {
    e.preventDefault();
    drag = { mode, startPx: e.clientX, startRange: { ...cur } };
  }
  sel.addEventListener('mousedown', e => onDown(e, 'move'));
  hL.addEventListener('mousedown', e => onDown(e, 'l'));
  hR.addEventListener('mousedown', e => onDown(e, 'r'));
  svg.addEventListener('mousedown', e => {
    if (e.target === sel || e.target === hL || e.target === hR) return;
    // klik buiten venster: centreer venster daar
    const width = cur.end - cur.start;
    const rect = svg.getBoundingClientRect();
    const c = idxAt(e.clientX - rect.left);
    cur.start = Math.max(0, Math.min(n - 1 - width, c - Math.floor(width / 2)));
    cur.end = cur.start + width;
    draw(); onChange(cur.start, cur.end);
  });

  function onMove(e) {
    if (!drag) return;
    const dIdx = Math.round(((e.clientX - drag.startPx) / iw) * (n - 1));
    const s = drag.startRange;
    if (drag.mode === 'move') {
      const width = s.end - s.start;
      cur.start = Math.max(0, Math.min(n - 1 - width, s.start + dIdx));
      cur.end = cur.start + width;
    } else if (drag.mode === 'l') {
      cur.start = Math.max(0, Math.min(s.end - 5, s.start + dIdx));
    } else {
      cur.end = Math.max(s.start + 5, Math.min(n - 1, s.end + dIdx));
    }
    draw();
    if (!onMove._raf) onMove._raf = requestAnimationFrame(() => { onMove._raf = null; onChange(cur.start, cur.end); });
  }
  function onUp() { drag = null; }
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  return { setRange(s, e2) { cur = { start: s, end: e2 }; draw(); } };
}

/** Synthetiseert OHLC uit closes (deterministisch). */
function synthOHLC(prices, seedBase = 7) {
  const rng = mulberry32(seedBase * 131 + 7);
  const out = [];
  for (let i = 0; i < prices.length; i++) {
    const o = i ? prices[i - 1] : prices[0] * 0.997;
    const c = prices[i];
    const dvol = Math.abs(Math.log(c / o)) + 0.004;
    const h = Math.max(o, c) * (1 + 0.45 * rng() * dvol);
    const l = Math.min(o, c) * (1 - 0.45 * rng() * dvol);
    out.push({ o, h, l, c });
  }
  return out;
}

/** Candlestick-grafiek met hover-tooltip. */
function renderCandles(container, { dates, candles, yFmt }) {
  container.innerHTML = '';
  const W = container.clientWidth || 600, H = container.clientHeight || 300;
  const pad = { l: 56, r: 14, t: 12, b: 26 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}` });
  container.appendChild(svg);

  const n = candles.length;
  let yMin = Infinity, yMax = -Infinity;
  for (const k of candles) { yMin = Math.min(yMin, k.l); yMax = Math.max(yMax, k.h); }
  const yPad = (yMax - yMin) * 0.06; yMin -= yPad; yMax += yPad;
  const x = i => pad.l + ((i + 0.5) / n) * iw;
  const y = v => pad.t + (1 - (v - yMin) / (yMax - yMin)) * ih;
  const cw = Math.max(2, Math.min(11, (iw / n) * 0.65));

  for (let t = 0; t <= 4; t++) {
    const val = yMin + (t / 4) * (yMax - yMin);
    svg.appendChild(svgEl('line', { x1: pad.l, x2: W - pad.r, y1: y(val), y2: y(val), stroke: 'rgba(255,255,255,0.055)' }));
    const lb = svgEl('text', { x: pad.l - 9, y: y(val) + 4, 'text-anchor': 'end', fill: '#5c6580', 'font-size': 10.5, 'font-family': 'Inter' });
    lb.textContent = yFmt(val); svg.appendChild(lb);
  }
  const stepLbl = Math.max(1, Math.floor(n / 6));
  for (let i = 0; i < n; i += stepLbl) {
    const lb = svgEl('text', { x: x(i), y: H - 7, 'text-anchor': 'middle', fill: '#5c6580', 'font-size': 10.5, 'font-family': 'Inter' });
    lb.textContent = fmtDateShort.format(dates[i]); svg.appendChild(lb);
  }

  const tooltip = document.createElement('div');
  tooltip.className = 'chart-tooltip';
  container.appendChild(tooltip);

  candles.forEach((k, i) => {
    const up = k.c >= k.o;
    const color = up ? '#34d399' : '#fb7185';
    const g = svgEl('g');
    g.appendChild(svgEl('line', { x1: x(i), x2: x(i), y1: y(k.h), y2: y(k.l), stroke: color, 'stroke-width': 1.2 }));
    const bodyTop = y(Math.max(k.o, k.c)), bodyH = Math.max(1.5, Math.abs(y(k.o) - y(k.c)));
    g.appendChild(svgEl('rect', { x: x(i) - cw / 2, y: bodyTop, width: cw, height: bodyH, fill: color, rx: 1 }));
    g.style.cursor = 'crosshair';
    g.addEventListener('mouseenter', () => {
      tooltip.innerHTML = `<div class="tt-date">${fmtDate.format(dates[i])}</div>
        <div class="tt-val">O ${yFmt(k.o)} · H ${yFmt(k.h)}</div>
        <div class="tt-val">L ${yFmt(k.l)} · C <span style="color:${color}">${yFmt(k.c)}</span></div>`;
      tooltip.style.opacity = 1;
      tooltip.style.left = Math.min(Math.max(x(i) - 70, 4), W - 160) + 'px';
      tooltip.style.top = '4px';
    });
    g.addEventListener('mouseleave', () => { tooltip.style.opacity = 0; });
    svg.appendChild(g);
  });
}

/** Correlatie-heatmap (DOM-grid). */
function renderHeatmap(container, labels, matrix) {
  container.innerHTML = '';
  const n = labels.length;
  const grid = document.createElement('div');
  grid.style.cssText = `display:grid;grid-template-columns:52px repeat(${n},1fr);gap:3px;`;
  const cell = (html, style = '') => {
    const d = document.createElement('div');
    d.style.cssText = 'height:34px;display:grid;place-items:center;border-radius:7px;font-size:10.5px;font-weight:600;' + style;
    d.innerHTML = html;
    return d;
  };
  grid.appendChild(cell(''));
  for (const l of labels) grid.appendChild(cell(l, 'color:#9aa3bd'));
  for (let i = 0; i < n; i++) {
    grid.appendChild(cell(labels[i], 'color:#9aa3bd'));
    for (let j = 0; j < n; j++) {
      const c = matrix[i][j];
      const col = c >= 0
        ? `rgba(124,107,255,${(0.08 + c * 0.72).toFixed(2)})`
        : `rgba(34,211,238,${(0.08 + Math.abs(c) * 0.72).toFixed(2)})`;
      const d = cell(c.toFixed(2).replace('.', ','), `background:${col};color:${Math.abs(c) > 0.55 ? '#fff' : '#c8cfe2'};cursor:default;transition:transform .12s;`);
      d.title = `${labels[i]} × ${labels[j]}: ${c.toFixed(2)}`;
      d.addEventListener('mouseenter', () => d.style.transform = 'scale(1.12)');
      d.addEventListener('mouseleave', () => d.style.transform = 'none');
      grid.appendChild(d);
    }
  }
  container.appendChild(grid);
}

/** Efficient frontier op canvas; onPick(point) bij klik. */
function renderFrontier(canvas, { points, frontier, current, maxSharpe, onPick }) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  const pad = { l: 56, r: 16, t: 14, b: 32 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const all = [...points, current, maxSharpe];
  const xMin = Math.min(...all.map(p => p.sig)) * 0.92;
  const xMax = Math.max(...all.map(p => p.sig)) * 1.05;
  const yMin = Math.min(...all.map(p => p.mu)) - 0.02;
  const yMax = Math.max(...all.map(p => p.mu)) + 0.02;
  const x = v => pad.l + ((v - xMin) / (xMax - xMin)) * iw;
  const y = v => pad.t + (1 - (v - yMin) / (yMax - yMin)) * ih;

  ctx.font = '10.5px Inter, sans-serif';
  ctx.strokeStyle = 'rgba(255,255,255,0.055)';
  ctx.fillStyle = '#5c6580';
  for (let t = 0; t <= 4; t++) {
    const vy = yMin + (t / 4) * (yMax - yMin);
    ctx.beginPath(); ctx.moveTo(pad.l, y(vy)); ctx.lineTo(W - pad.r, y(vy)); ctx.stroke();
    ctx.textAlign = 'right';
    ctx.fillText((vy * 100).toFixed(0) + '%', pad.l - 8, y(vy) + 4);
    const vx = xMin + (t / 4) * (xMax - xMin);
    ctx.textAlign = 'center';
    ctx.fillText((vx * 100).toFixed(0) + '%', x(vx), H - 9);
  }

  // puntenwolk, kleur = sharpe
  const shMin = Math.min(...points.map(p => p.sharpe)), shMax = Math.max(...points.map(p => p.sharpe));
  for (const p of points) {
    const t = (p.sharpe - shMin) / (shMax - shMin || 1);
    ctx.fillStyle = `hsla(${190 + t * 70}, 85%, ${45 + t * 20}%, 0.4)`;
    ctx.beginPath(); ctx.arc(x(p.sig), y(p.mu), 2.1, 0, Math.PI * 2); ctx.fill();
  }
  // frontierlijn
  ctx.strokeStyle = '#22d3ee'; ctx.lineWidth = 2.2;
  ctx.beginPath();
  frontier.forEach((p, i) => { if (i === 0) ctx.moveTo(x(p.sig), y(p.mu)); else ctx.lineTo(x(p.sig), y(p.mu)); });
  ctx.stroke();

  // max-Sharpe (ruit)
  ctx.fillStyle = '#34d399';
  ctx.save(); ctx.translate(x(maxSharpe.sig), y(maxSharpe.mu)); ctx.rotate(Math.PI / 4);
  ctx.fillRect(-6, -6, 12, 12); ctx.restore();
  // huidige portefeuille (ster)
  drawStar(ctx, x(current.sig), y(current.mu), 9, '#fbbf24');

  ctx.fillStyle = '#9aa3bd'; ctx.textAlign = 'left'; ctx.font = '11px Inter';
  ctx.fillText('★ = jouw portefeuille   ◆ = max-Sharpe   x-as: risico (σ) · y-as: verwacht rendement (μ)', pad.l, 12);

  canvas.style.cursor = 'crosshair';
  canvas.onclick = (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    let best = null, bd = Infinity;
    for (const p of [...points, maxSharpe]) {
      const d = (x(p.sig) - mx) ** 2 + (y(p.mu) - my) ** 2;
      if (d < bd) { bd = d; best = p; }
    }
    if (best && onPick) onPick(best);
  };
}

function drawStar(ctx, cx, cy, r, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r * 0.45;
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    const px = cx + rad * Math.cos(a), py = cy + rad * Math.sin(a);
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath(); ctx.fill();
}

/** Generieke horizontale metric-bars (bv. model-arena). */
function renderMetricBars(container, rows) {
  container.innerHTML = '';
  const maxV = Math.max(...rows.map(r => r.value), 1e-9);
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'bar-row';
    row.innerHTML = `
      <div class="bar-label">${r.name}</div>
      <div class="bar-track"><div class="bar-fill" style="width:0%;left:0;background:${r.color || 'var(--grad)'}"></div></div>
      <div class="bar-val">${r.display}</div>`;
    container.appendChild(row);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      row.querySelector('.bar-fill').style.width = (r.value / maxV * 100) + '%';
    }));
  }
}

/** Backtest-grafiek op canvas: buy&hold + meerdere strategieën. */
function drawBacktestChart(canvas, bt, upto) {
  const { dates, buyhold, strategies } = bt;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (canvas.width !== W * dpr) { canvas.width = W * dpr; canvas.height = H * dpr; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const pad = { l: 56, r: 14, t: 26, b: 26 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const n = buyhold.length;
  const end = Math.min(upto ?? n, n);
  let yMin = Infinity, yMax = -Infinity;
  for (let i = 0; i < n; i++) {
    yMin = Math.min(yMin, buyhold[i]); yMax = Math.max(yMax, buyhold[i]);
    for (const s of strategies) { yMin = Math.min(yMin, s.curve[i]); yMax = Math.max(yMax, s.curve[i]); }
  }
  const yp = (yMax - yMin) * 0.07; yMin -= yp; yMax += yp;
  const x = i => pad.l + (i / (n - 1)) * iw;
  const y = v => pad.t + (1 - (v - yMin) / (yMax - yMin)) * ih;

  ctx.font = '10.5px Inter, sans-serif';
  ctx.strokeStyle = 'rgba(255,255,255,0.055)'; ctx.fillStyle = '#5c6580';
  for (let t = 0; t <= 4; t++) {
    const vy = yMin + (t / 4) * (yMax - yMin);
    ctx.beginPath(); ctx.moveTo(pad.l, y(vy)); ctx.lineTo(W - pad.r, y(vy)); ctx.stroke();
    ctx.textAlign = 'right'; ctx.fillText(Math.round(vy), pad.l - 8, y(vy) + 4);
  }
  ctx.textAlign = 'center';
  const stepL = Math.max(1, Math.floor(n / 6));
  for (let i = 0; i < n; i += stepL) ctx.fillText(fmtDateShort.format(dates[i]), x(i), H - 7);

  const drawLine = (arr, color, width) => {
    ctx.strokeStyle = color; ctx.lineWidth = width;
    ctx.beginPath();
    for (let i = 0; i < end; i++) { if (i === 0) ctx.moveTo(x(i), y(arr[i])); else ctx.lineTo(x(i), y(arr[i])); }
    ctx.stroke();
  };
  drawLine(buyhold, 'rgba(154,163,189,0.8)', 1.6);
  for (const s of strategies) drawLine(s.curve, s.color, 2.2);

  // trade-markers alleen voor de eerste strategie (klassiek), anders wordt het druk
  const first = strategies[0];
  for (const t of first.trades) {
    if (t.idx >= end) break;
    ctx.fillStyle = t.type === 'buy' ? '#34d399' : '#fb7185';
    ctx.beginPath();
    const py = y(first.curve[t.idx]);
    if (t.type === 'buy') { ctx.moveTo(x(t.idx), py + 11); ctx.lineTo(x(t.idx) - 4.5, py + 18); ctx.lineTo(x(t.idx) + 4.5, py + 18); }
    else { ctx.moveTo(x(t.idx), py - 11); ctx.lineTo(x(t.idx) - 4.5, py - 18); ctx.lineTo(x(t.idx) + 4.5, py - 18); }
    ctx.closePath(); ctx.fill();
  }

  // legenda
  ctx.textAlign = 'left'; ctx.font = '11px Inter';
  let lx = pad.l + 4;
  ctx.fillStyle = '#9aa3bd'; ctx.fillText('— kopen & vasthouden', lx, 14); lx += ctx.measureText('— kopen & vasthouden').width + 18;
  for (const s of strategies) {
    ctx.fillStyle = s.color; ctx.fillText('— ' + s.name, lx, 14);
    lx += ctx.measureText('— ' + s.name).width + 18;
  }
}
