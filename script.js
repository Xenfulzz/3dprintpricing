'use strict';
/* 3DPrintPricing — static app. Settings, filaments and queue persist in localStorage;
   the calculator itself always starts as a blank print. */

/* ===== Defaults & state ===== */
const KEYS = { settings: '3dpp_settings', filaments: '3dpp_filaments', queue: '3dpp_queue' };
const DEFAULT_SETTINGS = { fee: 0, markup: 10, minPrice: 3, elecPrice: 0.3, watts: 150, running: 0.1 };
const DEFAULT_FILAMENTS = [['PLA', 20], ['PETG', 22], ['ABS', 22], ['ASA', 24], ['TPU', 25]]
  .map(([name, price]) => ({ id: name.toLowerCase(), name, price }));
const FIELDS = [
  { k: 'fee', label: 'Service Fee', pre: '£', desc: 'Saved default added to each print. You can override it per print.' },
  { k: 'markup', label: 'Profit Markup', suf: '%', desc: 'Added on top of your total costs.' },
  { k: 'minPrice', label: 'Minimum Print Price', pre: '£', desc: 'The least you will charge for any print.' },
  { k: 'elecPrice', label: 'Electricity Price', pre: '£', suf: '/ kWh', desc: 'Your energy tariff per kilowatt-hour.' },
  { k: 'watts', label: 'Printer Power', suf: 'W', desc: 'Average power your printer draws while printing.' },
  { k: 'running', label: 'Printer Running Cost', pre: '£', suf: '/ hour', desc: 'Wear, maintenance and depreciation per print hour.' }];
const STATUSES = ['Queued', 'Printing', 'Complete'];

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(Math.round(n * 100) / 100);
const perKg = p => money(p).replace(/\.00$/, '') + '/kg';
const num = v => (String(v).trim() === '' ? NaN : Number(v));
const readNum = id => (String($(id).value).trim() === '' ? 0 : num($(id).value)); // blank counts as 0
const isNum = n => typeof n === 'number' && Number.isFinite(n);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const sum = (a, k) => a.reduce((x, y) => x + (+y[k] || 0), 0);
const fmtTime = hrs => { const m = Math.round(hrs * 60); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; };
let settings, filaments, queue, lastPrice = null, lastFocus = null;
let calc = { filId: '', feeTouched: false, result: null };

/* ===== Storage (every read is guarded; one bad item never stops the app) ===== */
function read(key, ok) { try { const v = JSON.parse(localStorage.getItem(key)); return ok(v) ? v : null; } catch { return null; } }
function persist(key, value) {
  let saved = false;
  try { localStorage.setItem(key, JSON.stringify(value)); saved = true; } catch { /* storage blocked or full */ }
  if (!saved) toast('Couldn’t save — browser storage is unavailable', 'err');
  return saved;
}
function loadSettings() {
  const raw = read(KEYS.settings, v => v && typeof v === 'object') || {};
  return Object.fromEntries(Object.entries(DEFAULT_SETTINGS).map(([k, d]) => [k, isNum(raw[k]) && raw[k] >= 0 ? raw[k] : d]));
}
function loadFilaments() {
  const raw = read(KEYS.filaments, Array.isArray);
  const clean = (raw || []).filter(f => f && typeof f.name === 'string' && f.name.trim() && f.id && isNum(f.price) && f.price > 0)
    .map(f => ({ id: String(f.id), name: f.name, price: f.price }));
  return raw && (clean.length || !raw.length) ? clean : structuredClone(DEFAULT_FILAMENTS);
}
function loadQueue() {
  return (read(KEYS.queue, Array.isArray) || []).filter(q => q && isNum(q.price)).map(q => ({
    id: String(q.id || uid()), name: String(q.name || 'Untitled print'), filament: String(q.filament || '—'),
    grams: +q.grams || 0, hrs: +q.hrs || 0, price: q.price, profit: +q.profit || 0,
    status: STATUSES.includes(q.status) ? q.status : 'Queued', created: +q.created || Date.now() }));
}
const saveFilaments = () => persist(KEYS.filaments, filaments);
const saveQueue = () => persist(KEYS.queue, queue);

/* ===== Pricing: the ONE authoritative calculation ===== */
function calculatePrice({ grams, hours, fee, pricePerKg }, s = settings) {
  const filament = grams / 1000 * pricePerKg;
  const electricity = hours * (s.watts / 1000) * s.elecPrice;
  const printer = hours * s.running;
  const base = filament + electricity + printer + fee;
  const profit = base * (s.markup / 100);
  const raw = base + profit;
  // Round UP to the next 5p (never down, never to .99), then apply the minimum price.
  const price = Math.round(Math.max(Math.ceil(raw * 20 - 1e-6) / 20, s.minPrice) * 100) / 100;
  return { filament, electricity, printer, fee, base, profit, raw, price, earn: price - base };
}

/* ===== Calculator ===== */
function validateCalculator() {
  const ids = ['grams', 'hours', 'mins', 'fee'], vals = ids.map(readNum);
  const bad = vals.map(n => !(n >= 0));
  ids.forEach((id, i) => $(id).closest('.big').classList.toggle('bad', bad[i]));
  if (bad.some(Boolean)) return { state: 'error' };
  const [grams, h, m, fee] = vals, hours = h + m / 60;
  const fil = filaments.find(f => f.id === calc.filId);
  const missing = [!fil && 'filament', !grams && 'weight', !hours && 'print time'].filter(Boolean);
  if (missing.length === 3 && !fee) return { state: 'empty' };
  if (missing.length) return { state: 'incomplete', missing };
  return { state: 'ok', grams, hours, fee, fil };
}
function updateCalculator() {
  const v = validateCalculator(), ok = v.state === 'ok', card = $('priceCard');
  const fee = readNum('fee'), custom = fee >= 0 && Math.abs(fee - settings.fee) > 1e-9;
  $('feeBadge').textContent = custom ? 'Custom fee' : 'Saved default';
  $('feeBadge').classList.toggle('custom', custom);
  $('feeReset').hidden = !custom;
  card.classList.toggle('empty', !ok);
  $('copyBtn').disabled = $('addQueue').disabled = !ok;
  calc.result = null;
  if (!ok) {
    lastPrice = null;
    $('price').textContent = '£—';
    $('profit').textContent = v.state === 'error' ? 'Check your numbers' : v.state === 'empty' ? 'Ready when you are' : 'Almost there';
    $('cost').textContent = v.state === 'error' ? 'Values must be zero or more.'
      : v.state === 'empty' ? 'Enter your filament, print time and service fee to get a fair customer price.'
      : 'Still needed: ' + v.missing.join(', ') + '.';
    setStatus('', '');
    $('breakdown').innerHTML = '<p class="d">Your cost breakdown will appear here.</p>';
    return;
  }
  const r = calculatePrice({ grams: v.grams, hours: v.hours, fee: v.fee, pricePerKg: v.fil.price });
  calc.result = { ...r, grams: v.grams, hours: v.hours, filament_name: v.fil.name };
  $('price').textContent = money(r.price);
  if (lastPrice !== null && lastPrice !== r.price) { card.classList.remove('pulse'); void card.offsetWidth; card.classList.add('pulse'); }
  lastPrice = r.price;
  $('profit').textContent = `You make ${money(r.earn)} profit`;
  $('cost').textContent = `Your costs: ${money(r.base)}`;
  const pct = r.base > 0 ? r.earn / r.base * 100 : 0;
  if (r.raw < settings.minPrice) setStatus('good', 'Minimum price applied');
  else if (pct < 0) setStatus('below', 'Below Cost');
  else if (pct <= 25) setStatus('cheap', 'Cheap & Competitive');
  else if (pct <= 50) setStatus('good', 'Good Price');
  else setStatus('high', 'Higher Price');
  const row = (a, b, c) => `<div class="br ${c || ''}"><span>${a}</span><b>${money(b)}</b></div>`;
  const adj = r.price - r.raw;
  $('breakdown').innerHTML = row('Filament', r.filament) + row('Electricity', r.electricity) + row('Printer Running Cost', r.printer) +
    row('Service Fee', r.fee) + row('Base Cost', r.base, 'sep') + row('Profit', r.profit) +
    (adj > 0.004 ? row('Rounding / minimum price', adj, 'sub') : '') + row('Recommended Price', r.price, 'sep t');
}
function setStatus(cls, text) { const e = $('status'); e.className = 'status ' + cls; e.textContent = text; }
function setFee() { const f = settings.fee; $('fee').value = f > 0 ? String(f) : ''; calc.feeTouched = false; }
function resetCalculator() { // clears the current print only; settings, filaments and queue are untouched
  ['grams', 'hours', 'mins'].forEach(id => { $(id).value = ''; });
  calc.filId = ''; $('filamentSelect').value = ''; setFee(); updateCalculator();
}
function normaliseTime() { // 75 min → 1 h 15 m; runs on change/blur, never while typing
  const h = num($('hours').value || 0), m = num($('mins').value || 0);
  if (!(h >= 0 && m >= 0) || (m < 60 && Number.isInteger(h) && Number.isInteger(m))) return;
  const t = Math.round(h * 60 + m);
  $('hours').value = Math.floor(t / 60) || ''; $('mins').value = t % 60 || '';
  updateCalculator();
}
async function copyPrice() {
  if (!calc.result) return;
  const text = money(calc.result.price);
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch {
    const a = document.createElement('textarea'); a.value = text; a.setAttribute('readonly', ''); document.body.append(a); a.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    a.remove();
  }
  toast(ok ? 'Price copied' : 'Couldn’t copy — select the price manually', ok ? '' : 'err');
}
function renderFilamentSelect() {
  if (!filaments.some(f => f.id === calc.filId)) calc.filId = ''; // deleted filament → "Select filament"
  $('filamentSelect').innerHTML = '<option value="">Select filament</option>' +
    filaments.map(f => `<option value="${esc(f.id)}">${esc(f.name)} — ${perKg(f.price)}</option>`).join('');
  $('filamentSelect').value = calc.filId;
}

/* ===== Dashboard & queue ===== */
function renderStats() {
  const today = new Date().toDateString();
  const t = queue.filter(q => new Date(q.created).toDateString() === today).length;
  $('dash').innerHTML = [["Today's Prints", t], ['Queued', queue.filter(q => q.status === 'Queued').length],
    ['Revenue', money(sum(queue, 'price'))], ['Profit', money(sum(queue, 'profit'))]]
    .map(([l, v]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join('');
}
function renderQueue() {
  const n = queue.length;
  $('qsum').innerHTML = [[`${n} Print${n === 1 ? '' : 's'}`, 'In the queue'], [`${Math.round(sum(queue, 'grams'))} g`, 'Filament'],
    [fmtTime(sum(queue, 'hrs')), 'Print Time'], [money(sum(queue, 'price')), 'Total Value'], [money(sum(queue, 'profit')), 'Expected Profit']]
    .map(([b, l]) => `<div class="stat"><b>${b}</b><span>${l}</span></div>`).join('');
  $('queueList').innerHTML = n ? queue.map(q => `<article class="card item">
    <div class="ih"><h3>${esc(q.name)}</h3><div class="v"><b>${money(q.price)}</b><span>${money(q.profit)} profit</span></div></div>
    <div class="chips"><span class="chip">${esc(q.filament)}</span><span class="chip">${+q.grams} g</span><span class="chip">${fmtTime(q.hrs)}</span>
    <span class="chip">${new Date(q.created).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span></div>
    <div class="acts"><select data-status="${esc(q.id)}" aria-label="Status for ${esc(q.name)}">${STATUSES.map(s => `<option${s === q.status ? ' selected' : ''}>${s}</option>`).join('')}</select>
    <button class="btn ghost" data-del="${esc(q.id)}" aria-label="Delete ${esc(q.name)}">Delete</button></div></article>`).join('')
    : '<div class="empty">Nothing queued yet.<br>Price a print and tap “Add to Queue”.</div>';
  renderStats();
}
function addToQueue() {
  const r = calc.result; if (!r) return;
  openModal(`<form id="mf"><h2>Name this print</h2><p>Something you’ll recognise later.</p>
    <label class="lbl" for="pn">Print name</label><input id="pn" maxlength="60" autocomplete="off" placeholder="e.g. Dragon" value="${esc(r.filament_name)} print">
    <div class="acts"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn" type="submit">Add to Queue</button></div></form>`);
  $('pn').select();
  $('mf').onsubmit = e => {
    e.preventDefault();
    const name = $('pn').value.trim(); if (!name) { $('pn').classList.add('bad'); return toast('Give the print a name', 'err'); }
    queue.unshift({ id: uid(), name, filament: r.filament_name, grams: r.grams, hrs: r.hours, price: r.price, profit: r.earn, status: 'Queued', created: Date.now() });
    saveQueue(); renderQueue(); closeModal(); toast('Print added to queue');
  };
}

/* ===== Filaments ===== */
function renderFilaments() {
  $('filList').innerHTML = filaments.length ? filaments.map(f => `<div class="card fil"><h3>${esc(f.name)}</h3>
    <div class="p">${perKg(f.price)}</div><div class="acts"><button class="btn ghost" data-edit="${esc(f.id)}" aria-label="Edit ${esc(f.name)}">Edit</button>
    <button class="btn ghost" data-del="${esc(f.id)}" aria-label="Delete ${esc(f.name)}">Delete</button></div></div>`).join('')
    : '<div class="empty">No filaments saved.<br>Add one to start pricing prints.</div>';
}
function filamentForm(id) {
  const f = filaments.find(x => x.id === id);
  openModal(`<form id="mf" novalidate><h2>${f ? 'Edit' : 'Add'} Filament</h2>
    <label class="lbl" for="fn">Name</label><input id="fn" maxlength="40" autocomplete="off" placeholder="e.g. PLA+ Silk" value="${f ? esc(f.name) : ''}">
    <label class="lbl" for="fp">Price per kg</label><div class="big sm"><span class="pre">£</span><input id="fp" type="number" inputmode="decimal" min="0" step="any" placeholder="0.00" value="${f ? f.price : ''}"><span>/ kg</span></div>
    <div class="acts"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn" type="submit">Save</button></div></form>`);
  $('mf').onsubmit = e => {
    e.preventDefault();
    const name = $('fn').value.trim(), price = num($('fp').value);
    $('fn').classList.toggle('bad', !name); $('fp').closest('.big').classList.toggle('bad', !(price > 0));
    if (!name || !(price > 0)) return toast('Enter a name and a price above £0', 'err');
    if (f) { f.name = name; f.price = price; } else filaments.push({ id: uid(), name, price });
    saveFilaments(); renderFilaments(); renderFilamentSelect(); updateCalculator(); closeModal(); toast('Filament saved');
  };
}
function deleteFilament(id) {
  const f = filaments.find(x => x.id === id); if (!f) return;
  confirmBox(`Delete ${f.name}?`, 'Prints already in your queue keep their price.', 'Delete', () => {
    filaments = filaments.filter(x => x.id !== id);
    saveFilaments(); renderFilaments(); renderFilamentSelect(); updateCalculator(); toast('Filament deleted');
  });
}

/* ===== Settings (edited as a draft; only applied when saved) ===== */
const fieldValue = (f, v) => (f.pre && Math.abs(v * 100 - Math.round(v * 100)) < 1e-9 ? v.toFixed(2) : String(v));
function renderSettings() {
  $('setCards').innerHTML = FIELDS.map(f => `<div class="card set"><label class="lbl" for="s_${f.k}">${f.label}</label>
    <div class="big sm">${f.pre ? `<span class="pre">${f.pre}</span>` : ''}<input id="s_${f.k}" type="number" inputmode="decimal" min="0" step="any" autocomplete="off" value="${fieldValue(f, settings[f.k])}">${f.suf ? `<span>${f.suf}</span>` : ''}</div>
    <div class="d">${f.desc}</div></div>`).join('');
  markSettingsDirty();
}
function markSettingsDirty() {
  const dirty = FIELDS.some(f => num($('s_' + f.k).value) !== settings[f.k]);
  $('dirty').hidden = !dirty; $('saveSet').disabled = !dirty;
}
function saveSettings() {
  const next = {}, bad = [];
  FIELDS.forEach(f => {
    const el = $('s_' + f.k), n = num(el.value);
    el.closest('.big').classList.toggle('bad', !(n >= 0));
    if (n >= 0) next[f.k] = n; else bad.push(f.label);
  });
  if (bad.length) return toast('Check: ' + bad.join(', '), 'err');
  settings = next; persist(KEYS.settings, settings);
  applySettings(); toast('Settings saved');
}
function resetSettings() {
  settings = { ...DEFAULT_SETTINGS }; persist(KEYS.settings, settings);
  renderSettings(); applySettings(); toast('Settings reset to defaults');
}
function applySettings() { // push saved settings into the calculator
  if (!calc.feeTouched) setFee();
  markSettingsDirty(); updateCalculator();
}

/* ===== Navigation, modal, toasts ===== */
function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === id));
  document.querySelectorAll('.nav button').forEach(b => {
    const on = b.dataset.view === id; b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  setMenu(false); window.scrollTo(0, 0);
}
function setMenu(open) { document.body.classList.toggle('menu-open', open); $('menuBtn').setAttribute('aria-expanded', open); }
function openModal(html) {
  lastFocus = document.activeElement; $('modalBox').innerHTML = html; $('modal').classList.add('open');
  const f = $('modalBox').querySelector('input,.btn'); if (f) f.focus();
}
function closeModal() { $('modal').classList.remove('open'); if (lastFocus && lastFocus.focus) lastFocus.focus(); }
function confirmBox(title, text, label, fn) {
  openModal(`<h2>${esc(title)}</h2><p>${esc(text)}</p><div class="acts"><button class="btn ghost" data-close>Cancel</button><button class="btn danger" id="okBtn">${label}</button></div>`);
  $('okBtn').onclick = () => { closeModal(); fn(); };
}
function toast(msg, type) {
  const t = document.createElement('div'); t.className = 'toast' + (type ? ' ' + type : ''); t.textContent = msg;
  $('toasts').append(t); setTimeout(() => t.remove(), 2600);
}

/* ===== Init ===== */
function init() {
  settings = loadSettings(); filaments = loadFilaments(); queue = loadQueue();
  renderSettings(); renderFilaments(); renderFilamentSelect(); renderQueue(); resetCalculator();

  document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
  $('menuBtn').onclick = () => setMenu(!document.body.classList.contains('menu-open'));
  $('scrim').onclick = () => setMenu(false);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeModal(); setMenu(false); } });
  document.addEventListener('wheel', () => { const a = document.activeElement; if (a && a.type === 'number') a.blur(); }, { passive: true });
  window.addEventListener('pageshow', e => { if (e.persisted) resetCalculator(); });

  ['grams', 'hours', 'mins', 'fee'].forEach(id => $(id).addEventListener('input', () => { if (id === 'fee') calc.feeTouched = true; updateCalculator(); }));
  ['hours', 'mins'].forEach(id => $(id).addEventListener('change', normaliseTime));
  $('filamentSelect').onchange = e => { calc.filId = e.target.value; updateCalculator(); };
  $('feeReset').onclick = () => { setFee(); updateCalculator(); };
  $('resetCalc').onclick = resetCalculator;
  $('copyBtn').onclick = copyPrice;
  $('addQueue').onclick = addToQueue;

  $('setForm').addEventListener('input', markSettingsDirty);
  $('setForm').onsubmit = e => { e.preventDefault(); saveSettings(); };
  $('resetBtn').onclick = () => confirmBox('Reset settings?', 'Your settings go back to their defaults. Filaments and your queue are not affected.', 'Reset', resetSettings);

  $('addFil').onclick = () => filamentForm();
  $('filList').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.edit) filamentForm(b.dataset.edit); else if (b.dataset.del) deleteFilament(b.dataset.del);
  });
  $('queueList').addEventListener('change', e => {
    const q = queue.find(x => x.id === e.target.dataset.status); if (!q) return;
    q.status = e.target.value; saveQueue(); renderQueue(); toast('Print updated');
  });
  $('queueList').addEventListener('click', e => {
    const b = e.target.closest('[data-del]'), q = b && queue.find(x => x.id === b.dataset.del); if (!q) return;
    confirmBox(`Delete “${q.name}”?`, 'This removes it from your queue.', 'Delete', () => { queue = queue.filter(x => x !== q); saveQueue(); renderQueue(); toast('Print deleted'); });
  });
  $('modal').addEventListener('click', e => { if (e.target === $('modal') || e.target.closest('[data-close]')) closeModal(); });
}
init();
