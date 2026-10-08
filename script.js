'use strict';
/* ===== Defaults & state ===== */
const DEFAULT_SETTINGS = { serviceFee: 2, profitPct: 15, minPrice: 3, electricity: 0.30, watts: 150, runCost: 0.10 };
const DEFAULT_FILAMENTS = [
  { id: 'pla', name: 'PLA', type: 'PLA', price: 20 }, { id: 'petg', name: 'PETG', type: 'PETG', price: 22 },
  { id: 'abs', name: 'ABS', type: 'ABS', price: 22 }, { id: 'asa', name: 'ASA', type: 'ASA', price: 24 },
  { id: 'tpu', name: 'TPU', type: 'TPU', price: 25 }];
const $ = id => document.getElementById(id);
const formatCurrency = n => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(Math.round(n * 100) / 100);
const money = formatCurrency;
let savedT, settings, filaments, queue, lastPrice = null, feeOverride = false;

/* ===== Storage ===== */
function load(key, fallback) { try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch { return fallback; } }
function saveSettings() { localStorage.setItem('3dpp_settings', JSON.stringify(settings)); }
function loadSettings() { return { ...DEFAULT_SETTINGS, ...load('3dpp_settings', {}) }; }
function saveFilaments() { localStorage.setItem('3dpp_filaments', JSON.stringify(filaments)); }
function loadFilaments() { const f = load('3dpp_filaments', null); return Array.isArray(f) && f.length ? f : structuredClone(DEFAULT_FILAMENTS); }
function saveQueue() { localStorage.setItem('3dpp_queue', JSON.stringify(queue)); }
function loadQueue() { const q = load('3dpp_queue', []); return Array.isArray(q) ? q : []; }

/* ===== Pricing calculations ===== */
// Filament cost = grams / 1000 × price per kg
function calculateFilamentCost(g, pricePerKg) { return g / 1000 * pricePerKg; }
// Electricity = hours × (watts / 1000) × price per kWh
function calculateElectricityCost(hrs, s = settings) { return hrs * (s.watts / 1000) * s.electricity; }
// Printer wear/running cost = hours × cost per printer hour
function calculatePrinterCost(hrs, s = settings) { return hrs * s.runCost; }
// Base cost = filament + electricity + printer running + service fee
function calculateBaseCost(parts) { return parts.filament + parts.electricity + parts.printer + parts.fee; }
// Profit = small % of base cost
function calculateProfit(base, s = settings) { return base * s.profitPct / 100; }
// Round UP to a tidy price close to the real one (favours the customer, never below the true price)
function roundPrice(p) {
  const step = p < 10 ? 0.05 : p < 50 ? 0.25 : 0.5;
  return Math.ceil(Math.round(p / step * 1e6) / 1e6) * step;
}
// Recommended = base + profit, rounded sensibly, then lifted to the minimum price if needed
function calculateRecommendedPrice(base, s = settings) {
  return Math.max(roundPrice(base + calculateProfit(base, s)), s.minPrice);
}
function readInputs() {
  const grams = parseFloat($('grams').value), h = parseFloat($('hours').value) || 0, m = parseFloat($('mins').value) || 0;
  const fee = parseFloat($('fee').value), fil = filaments.find(f => f.id === $('filamentSelect').value);
  const bad = { grams: !(grams >= 0), hours: h < 0, mins: m < 0, fee: !(fee >= 0) };
  return { grams, h, m, fee, fil, bad };
}
function compute() {
  const i = readInputs();
  if (Object.values(i.bad).some(Boolean) || !i.fil) return { i, valid: false };
  const hrs = i.h + i.m / 60;
  const parts = { filament: calculateFilamentCost(i.grams, i.fil.price), electricity: calculateElectricityCost(hrs),
    printer: calculatePrinterCost(hrs), fee: i.fee };
  const base = calculateBaseCost(parts), price = calculateRecommendedPrice(base);
  return { i, valid: true, parts, base, price, profit: price - base, hrs };
}

/* ===== Calculator UI ===== */
function updateCalculator() {
  const r = compute(), i = r.i;
  $('grams').closest('.big').classList.toggle('bad', i.bad.grams);
  $('hours').closest('.big').classList.toggle('bad', i.bad.hours);
  $('mins').closest('.big').classList.toggle('bad', i.bad.mins);
  $('fee').closest('.big').classList.toggle('bad', i.bad.fee);
  const feeVal = parseFloat($('fee').value);
  const custom = feeVal >= 0 && Math.abs(feeVal - settings.serviceFee) > 0.0001;
  $('feeBadge').hidden = $('feeReset').hidden = !custom;
  if (!r.valid) {
    $('price').textContent = '£–.––'; lastPrice = null; $('profit').textContent = 'Enter valid, non-negative values'; $('cost').textContent = '';
    setStatus('', ''); $('breakdown').innerHTML = ''; $('addQueue').disabled = $('copyBtn').disabled = true; return;
  }
  $('addQueue').disabled = $('copyBtn').disabled = false;
  animateNumber($('price'), r.price);
  $('profit').textContent = `You make ${formatCurrency(r.profit)} profit`;
  $('cost').textContent = `Your costs: ${formatCurrency(r.base)}`;
  const pct = r.base > 0 ? r.profit / r.base * 100 : 0;
  if (pct < 0) setStatus('below', 'Below Cost'); else if (pct <= 25) setStatus('cheap', 'Cheap & Competitive');
  else if (pct <= 50) setStatus('good', 'Good Price'); else setStatus('high', 'Higher Price');
  const row = (a, b, t) => `<div class="br ${t || ''}"><span>${a}</span><b>${money(b)}</b></div>`;
  const adj = r.price - r.base - calculateProfit(r.base);
  $('breakdown').innerHTML = row('Filament', r.parts.filament) + row('Electricity', r.parts.electricity) +
    row('Printer Running Cost', r.parts.printer) + row('Service Fee', r.parts.fee) +
    row('Base Cost', r.base, 'sep') + row('Profit', calculateProfit(r.base)) +
    (adj > 0.004 ? row('Rounding / minimum price', adj, 'sub') : '') + row('Recommended Price', r.price, 'sep t');
  renderFilamentSelect();
}
function setStatus(cls, text) { const e = $('status'); e.className = 'status ' + cls; e.textContent = text; }
function animateNumber(el, to) {
  const from = lastPrice ?? to; lastPrice = to;
  if (from !== to) { const c = $('priceCard'); c.classList.remove('pulse'); void c.offsetWidth; c.classList.add('pulse'); }
  const t0 = performance.now();
  (function step(t) {
    const k = Math.min((t - t0) / 350, 1);
    el.textContent = money(from + (to - from) * k);
    if (k < 1) requestAnimationFrame(step);
  })(t0);
}
function renderFilamentSelect() {
  const sel = $('filamentSelect'), cur = sel.value;
  const html = filaments.map(f => `<option value="${f.id}">${esc(f.name)} — ${money(f.price)}/kg</option>`).join('');
  if (sel.dataset.h !== html) { sel.innerHTML = html; sel.dataset.h = html; sel.value = filaments.some(f => f.id === cur) ? cur : filaments[0].id; }
}
function renderDashboard() {
  const today = new Date().toDateString();
  const t = queue.filter(q => new Date(q.created).toDateString() === today).length;
  const s = [['Today\'s Prints', t], ['Queued', queue.filter(q => q.status === 'Queued').length],
    ['Revenue', money(sum(queue, 'price'))], ['Profit', money(sum(queue, 'profit'))]];
  $('dash').innerHTML = s.map(([l, v]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join('');
}

/* ===== Queue ===== */
const sum = (a, k) => a.reduce((x, y) => x + (+y[k] || 0), 0);
const fmtTime = hrs => { const m = Math.round(hrs * 60); return `${Math.floor(m / 60)}h ${m % 60}m`; };
function renderQueue() {
  const n = queue.length;
  $('qsum').innerHTML = [[`${n} Print${n === 1 ? '' : 's'}`, 'In the queue'], [`${Math.round(sum(queue, 'grams'))} g`, 'Filament'],
    [fmtTime(sum(queue, 'hrs')), 'Print Time'], [money(sum(queue, 'price')), 'Total Value'], [money(sum(queue, 'profit')), 'Expected Profit']]
    .map(([b, l]) => `<div class="stat"><b>${b}</b><span>${l}</span></div>`).join('');
  $('queueList').innerHTML = n ? queue.map(q => `<div class="card item">
    <div><h3>${esc(q.name)}</h3><div class="meta">${esc(q.filament)} · ${q.grams} g · ${fmtTime(q.hrs)}</div></div>
    <div class="v"><b>${money(q.price)}</b><span>${money(q.profit)} profit</span></div>
    <div class="acts"><select data-status="${q.id}">${['Queued', 'Printing', 'Complete'].map(s => `<option ${s === q.status ? 'selected' : ''}>${s}</option>`).join('')}</select>
    <button class="btn ghost" data-del="${q.id}">Delete</button></div></div>`).join('')
    : '<div class="empty">Nothing queued yet.<br>Price a print and tap “Add to Queue”.</div>';
  renderDashboard();
}
function addToQueue() {
  const r = compute(); if (!r.valid) return toast('Fix the highlighted inputs first.', true);
  modal(`<h2>Name this print</h2><p>Something you'll recognise later.</p><br><input id="pn" placeholder="e.g. Dragon" maxlength="40">
    <div class="acts"><button class="btn ghost" data-close>Cancel</button><button class="btn" id="pnOk">Add to Queue</button></div>`);
  $('pn').focus();
  const go = () => {
    const name = $('pn').value.trim(); if (!name) return toast('Give the print a name.', true);
    queue.unshift({ id: uid(), name, filament: r.i.fil.name, grams: r.i.grams, hrs: r.hrs, price: r.price, profit: r.profit, status: 'Queued', created: Date.now() });
    saveQueue(); renderQueue(); closeModal(); toast('Print added to queue ✓');
    const b = $('addQueue'); b.classList.add('ok'); b.textContent = '✓ Added'; setTimeout(() => { b.classList.remove('ok'); b.textContent = '+ Add to Queue'; }, 1200);
  };
  $('pnOk').onclick = go; $('pn').onkeydown = e => e.key === 'Enter' && go();
}

/* ===== Filaments ===== */
function renderFilaments() {
  $('filList').innerHTML = filaments.length ? filaments.map(f => `<div class="card fil"><h3>${esc(f.name)}</h3>
    <div class="p">${money(f.price)}/kg</div><div class="ty">${esc(f.type)}</div>
    <div class="acts"><button class="btn ghost" data-edit="${f.id}">Edit</button><button class="btn ghost" data-delfil="${f.id}">Delete</button></div></div>`).join('')
    : '<div class="empty">No filaments saved.<br>Add one to start pricing.</div>';
  renderFilamentSelect(); updateCalculator();
}
function filamentModal(id) {
  const f = filaments.find(x => x.id === id) || { name: '', type: 'PLA', price: '' };
  const types = ['PLA', 'PETG', 'ABS', 'ASA', 'TPU', 'Other'];
  modal(`<h2>${id ? 'Edit' : 'Add'} Filament</h2><label class="lbl">Name</label><input id="fn" value="${esc(f.name)}" maxlength="30">
    <label class="lbl">Type</label><select id="ft">${types.map(t => `<option ${t === f.type ? 'selected' : ''}>${t}</option>`).join('')}</select>
    <label class="lbl">Price per kg (£)</label><input id="fp" type="number" min="0" step="0.5" value="${f.price}">
    <div class="acts"><button class="btn ghost" data-close>Cancel</button><button class="btn" id="fs">Save</button></div>`);
  $('fs').onclick = () => {
    const name = $('fn').value.trim(), price = parseFloat($('fp').value);
    if (!name) return toast('Filament needs a name.', true);
    if (!(price >= 0)) return toast('Enter a price of £0 or more.', true);
    if (id) Object.assign(f, { name, type: $('ft').value, price });
    else filaments.push({ id: uid(), name, type: $('ft').value, price });
    saveFilaments(); renderFilaments(); closeModal(); toast(id ? 'Filament updated ✓' : 'Filament added ✓');
  };
}

/* ===== Settings ===== */
const SET_DEFS = [
  ['Pricing', [['serviceFee', 'Service Fee', '£', '', 'Your standard fee for handling and preparing the print.'],
    ['profitPct', 'Profit Margin', '', '%', 'Small profit added after calculating your basic costs.'],
    ['minPrice', 'Minimum Print Price', '£', '', 'No quote will ever go below this.']]],
  ['Electricity', [['electricity', 'Electricity Price', '£', '/ kWh', 'What you pay per unit of electricity.'],
    ['watts', 'Printer Power', '', 'W', 'Average power draw while printing.']]],
  ['Printer', [['runCost', 'Printer Running Cost', '£', '/ hour', 'Helps cover maintenance, wear, depreciation and general printer costs.']]]];
function renderSettings() {
  $('setCards').innerHTML = SET_DEFS.map(([t, items]) => `<div class="card set"><h3>${t}</h3>${items.map(([k, l, pre, suf, d]) =>
    `<label class="lbl">${l}</label><div class="big sm">${pre ? `<span class="pre">${pre}</span>` : ''}<input type="number" inputmode="decimal" min="0" step="any" data-set="${k}" ${pre ? 'data-cur' : ''} value="${pre ? settings[k].toFixed(2) : settings[k]}">${suf ? `<span>${suf}</span>` : ''}</div><div class="d">${d}</div>`).join('')}</div>`).join('');
}
function resetSettings() {
  modal(`<h2>Reset to defaults?</h2><p>All pricing settings return to their original values. Filaments and queue are kept.</p>
    <div class="acts"><button class="btn ghost" data-close>Cancel</button><button class="btn danger" id="rs">Reset</button></div>`);
  $('rs').onclick = () => { settings = { ...DEFAULT_SETTINGS }; saveSettings(); renderSettings(); syncFee(true); updateCalculator(); closeModal(); toast('Settings reset ✓'); };
}
function syncFee(force) { if (force || !feeOverride) { $('fee').value = settings.serviceFee; feeOverride = false; } }

/* ===== Helpers: UI ===== */
const uid = () => Math.random().toString(36).slice(2, 10);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(msg, err) {
  const t = document.createElement('div'); t.className = 'toast' + (err ? ' err' : ''); t.textContent = msg;
  $('toasts').append(t); setTimeout(() => t.remove(), 3000);
}
function modal(html) { $('modalBox').innerHTML = html; $('modal').classList.add('open'); }
function closeModal() { $('modal').classList.remove('open'); }
function show(view) {
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === view));
  document.querySelectorAll('.nav button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  scrollTo(0, 0);
}

/* ===== Events & init ===== */
document.addEventListener('click', e => {
  const t = e.target;
  const nv = t.closest('[data-view]'); if (nv) show(nv.dataset.view);
  if (t.hasAttribute('data-close') || t.id === 'modal') closeModal();
  if (t.dataset.del) { queue = queue.filter(q => q.id !== t.dataset.del); saveQueue(); renderQueue(); toast('Print removed'); }
  if (t.dataset.edit) filamentModal(t.dataset.edit);
  if (t.dataset.delfil) {
    if (filaments.length <= 1) return toast('Keep at least one filament.', true);
    filaments = filaments.filter(f => f.id !== t.dataset.delfil); saveFilaments(); renderFilaments(); toast('Filament deleted');
  }
});
document.addEventListener('change', e => {
  if (e.target.dataset.status) { queue.find(q => q.id === e.target.dataset.status).status = e.target.value; saveQueue(); renderQueue(); }
});
document.addEventListener('input', e => {
  const k = e.target.dataset.set; if (!k) return;
  const v = parseFloat(e.target.value);
  e.target.closest('.big').classList.toggle('bad', !(v >= 0));
  if (!(v >= 0)) return toast('Settings can’t be negative.', true);
  settings[k] = v; saveSettings(); syncFee(); updateCalculator(); clearTimeout(savedT); savedT = setTimeout(() => toast('Settings saved ✓'), 800);
});
['grams', 'hours', 'mins', 'filamentSelect'].forEach(id => $(id).addEventListener('input', updateCalculator));
$('fee').addEventListener('input', () => { feeOverride = true; updateCalculator(); });
$('feeReset').onclick = () => { syncFee(true); updateCalculator(); };
$('addQueue').onclick = addToQueue;
$('copyBtn').onclick = copyPrice;
function copyPrice() {
  const r = compute(); if (!r.valid) return toast('Nothing to copy yet.', true);
  const text = formatCurrency(r.price), done = () => toast('Price copied ✓');
  const fallback = () => { const a = document.createElement('textarea'); a.value = text; document.body.append(a); a.select();
    try { document.execCommand('copy'); done(); } catch { toast('Couldn’t copy — select the price instead.', true); } a.remove(); };
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
}
// Format only AFTER the field loses focus, never while typing
document.addEventListener('focusout', e => {
  const el = e.target;
  if (el.id === 'fee' || el.hasAttribute('data-cur')) { const v = parseFloat(el.value); if (v >= 0) el.value = v.toFixed(2); }
  if (el.id === 'mins' || el.id === 'hours') normalizeTime();
});
// 75 minutes -> 1h 15m
function normalizeTime() {
  const h = parseFloat($('hours').value) || 0, m = parseFloat($('mins').value) || 0;
  if (m >= 60) { $('hours').value = h + Math.floor(m / 60); $('mins').value = Math.round(m % 60); updateCalculator(); toast(`Converted to ${$('hours').value}h ${$('mins').value}m`); }
}
$('addFil').onclick = () => filamentModal();
$('resetBtn').onclick = resetSettings;
document.addEventListener('keydown', e => e.key === 'Escape' && closeModal());

settings = loadSettings(); filaments = loadFilaments(); queue = loadQueue();
renderSettings(); syncFee(true); renderFilaments(); renderQueue();
