import { DOTS_PER_MM, HEAD_DOTS, MEDIA_TYPES } from './m110.js';
import { Printer } from './printer.js';
import { renderLabel, toRaster } from './raster.js';
import { autoValue, fillTemplate, findFields, importImage, importSvg, missingFonts } from './template.js';
import { loadSetting, saveSetting, templates as db } from './storage.js';
import { BleTransport, UsbTransport } from './transports.js';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PRESET_SIZES = [
  { id: '40x30', width: 40, height: 30 },
  { id: '50x30', width: 50, height: 30 },
  { id: '50x80', width: 50, height: 80 },
  { id: '50-round', width: 50, height: 50, round: true },
];

// This M110's print head sits ~1 mm right of the label center and starts ~1 mm
// early. Measured with the alignment test on a 50×80 roll.
const DEFAULT_SETTINGS = { density: 10, mode: 'auto', threshold: 128, media: 'gaps', offsetX: -1, offsetY: 1 };

const state = {
  templates: [],
  currentId: loadSetting('currentId', null),
  customSizes: loadSetting('customSizes', []),
  settings: { ...DEFAULT_SETTINGS, ...loadSetting('settings', {}) },
  view: 'print',
  labelCanvas: null,
  raster: null,
  printing: false,
  missingFonts: [],
  renderError: null,
};

const printer = new Printer();
const thumbs = new Map();

// ---------- helpers ----------

const allSizes = () => [...PRESET_SIZES, ...state.customSizes];
const current = () => state.templates.find((t) => t.id === state.currentId) ?? null;
const sizeDims = (s) => (s.round ? `${s.width} mm round` : `${s.width} × ${s.height} mm`);
const sizeLabel = (s) => `${s.name ? `${s.name} · ` : ''}${sizeDims(s)}`;
const sizeOf = (t) => allSizes().find((s) => s.id === t.sizeId) ?? bestFit(t.width, t.height).size;

function bestFit(width, height) {
  const aspect = Math.log(width / height);
  let best = null;
  for (const size of allSizes()) {
    for (const rotation of [0, 90]) {
      const label = rotation ? size.height / size.width : size.width / size.height;
      const score = Math.abs(aspect - Math.log(label)) + (rotation ? 0.01 : 0);
      if (!best || score < best.score) best = { size, rotation, score };
    }
  }
  return best;
}

let toastTimer;
function toast(message, kind = '') {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast'), kind === 'error' ? 5000 : 2500);
}

const saveTimers = new Map();
function saveTemplate(t, immediate = false) {
  t.updatedAt = Date.now();
  clearTimeout(saveTimers.get(t.id));
  const write = () => db.put(t).catch((e) => toast(`Could not save: ${e.message}`, 'error'));
  if (immediate) return write();
  saveTimers.set(t.id, setTimeout(write, 300));
}

function saveSettings() {
  saveSetting('settings', state.settings);
}

function thumbUrl(t) {
  const cached = thumbs.get(t.id);
  if (cached?.svg === t.svg) return cached.url;
  if (cached) URL.revokeObjectURL(cached.url);
  const url = URL.createObjectURL(new Blob([t.svg], { type: 'image/svg+xml' }));
  thumbs.set(t.id, { svg: t.svg, url });
  return url;
}

// ---------- templates ----------

function newTemplate(info, name, fileName = null) {
  const fit = bestFit(info.width, info.height);
  return {
    id: crypto.randomUUID(),
    name,
    fileName,
    svg: info.svg,
    width: info.width,
    height: info.height,
    fields: info.fields,
    fonts: info.fonts,
    sizeId: fit.size.id,
    rotation: fit.rotation,
    values: {},
    align: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function replaceSvg(t, info) {
  Object.assign(t, { svg: info.svg, width: info.width, height: info.height, fields: info.fields, fonts: info.fonts });
}

async function readFile(file) {
  if (file.type === 'image/svg+xml' || /\.svg$/i.test(file.name)) return importSvg(await file.text());
  if (/^image\/(png|jpeg)$/.test(file.type)) return importImage(file);
  throw new Error(`${file.name}: only SVG, PNG and JPEG files are supported`);
}

async function importFiles(files) {
  let last = null;
  for (const file of files) {
    try {
      const info = await readFile(file);
      const existing = state.templates.find((t) => t.fileName === file.name);
      if (existing) {
        replaceSvg(existing, info);
        await saveTemplate(existing, true);
        last = existing;
        toast(`Updated “${existing.name}” from ${file.name}`);
      } else {
        const t = newTemplate(info, file.name.replace(/\.[^.]+$/, ''), file.name);
        state.templates.push(t);
        await saveTemplate(t, true);
        last = t;
        toast(`Imported “${t.name}”`);
      }
    } catch (e) {
      toast(e.message, 'error');
    }
  }
  if (last) select(last.id);
}

async function importSvgText(text) {
  try {
    const info = importSvg(text);
    const count = state.templates.filter((t) => t.name.startsWith('Pasted label')).length;
    const t = newTemplate(info, count ? `Pasted label ${count + 1}` : 'Pasted label');
    state.templates.push(t);
    await saveTemplate(t, true);
    select(t.id);
    toast('Imported from clipboard. Give it a name above.');
    $('titleInput').focus();
    $('titleInput').select();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function deleteTemplate(t) {
  if (!confirm(`Delete “${t.name}”?`)) return;
  const index = state.templates.indexOf(t);
  state.templates.splice(index, 1);
  await db.delete(t.id);
  const next = state.templates[Math.min(index, state.templates.length - 1)];
  select(next?.id ?? null);
}

async function duplicateTemplate(t) {
  const copy = structuredClone(t);
  Object.assign(copy, { id: crypto.randomUUID(), name: `${t.name} copy`, fileName: null, createdAt: Date.now() });
  state.templates.splice(state.templates.indexOf(t) + 1, 0, copy);
  await saveTemplate(copy, true);
  select(copy.id);
}

function select(id) {
  state.currentId = id;
  saveSetting('currentId', id);
  const t = current();
  state.missingFonts = t ? missingFonts(t.fonts ?? []) : [];
  renderList();
  renderEditor();
  scheduleRender(0);
}

// ---------- template list ----------

function renderList() {
  const list = $('templateList');
  list.replaceChildren(
    ...state.templates.map((t) => {
      const li = document.createElement('li');
      li.className = `template-item${t.id === state.currentId ? ' active' : ''}`;
      li.dataset.id = t.id;
      const size = sizeOf(t);
      li.innerHTML = `
        <div class="thumb"><img alt="" /></div>
        <div style="min-width:0">
          <div class="name"></div>
          <div class="meta">${sizeDims(size)}${t.fields.length ? ` · ${t.fields.length} field${t.fields.length > 1 ? 's' : ''}` : ''}</div>
        </div>
        <div class="actions">
          <button data-action="duplicate" title="Duplicate">⧉</button>
          <button data-action="delete" title="Delete">✕</button>
        </div>`;
      li.querySelector('img').src = thumbUrl(t);
      li.querySelector('.name').textContent = t.name;
      li.addEventListener('click', (e) => {
        const action = e.target.closest('button')?.dataset.action;
        if (action === 'delete') return deleteTemplate(t);
        if (action === 'duplicate') return duplicateTemplate(t);
        if (t.id !== state.currentId) select(t.id);
      });
      return li;
    }),
  );
}

// ---------- editor panel ----------

const ALIGN_ICONS = {
  left: '<svg viewBox="0 0 16 16"><path d="M2 3h12M2 6.5h8M2 10h12M2 13.5h8" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>',
  center: '<svg viewBox="0 0 16 16"><path d="M2 3h12M4 6.5h8M2 10h12M4 13.5h8" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>',
  right: '<svg viewBox="0 0 16 16"><path d="M2 3h12M6 6.5h8M2 10h12M6 13.5h8" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>',
};

function renderEditor() {
  const t = current();
  $('emptyState').classList.toggle('hidden', !!t);
  $('labelFrame').classList.toggle('hidden', !t);
  $('stageToolbar').classList.toggle('hidden', !t);
  $('panel').classList.toggle('disabled', !t);
  if (!t) {
    $('stageInfo').textContent = '';
    $('warnings').replaceChildren();
    updatePrintButton();
    return;
  }
  $('titleInput').value = t.name;
  renderSizeSelect();
  document.querySelector(`input[name="rotation"][value="${t.rotation}"]`).checked = true;
  renderFields();
  updatePrintButton();
}

function renderSizeSelect() {
  const t = current();
  const select = $('sizeSelect');
  select.replaceChildren(
    ...allSizes().map((s) => new Option(sizeLabel(s), s.id)),
  );
  if (t) select.value = sizeOf(t).id;
}

function renderFields() {
  const t = current();
  const container = $('fields');
  if (!t.fields.length) {
    container.innerHTML = `<p class="no-fields">This template has no fields. To add one, type a placeholder like
      <code>{{name}}</code> in a Figma text layer and re-import. <code>{{date}}</code> and <code>{{time}}</code>
      fill in automatically.</p>`;
    return;
  }
  container.replaceChildren(
    ...t.fields.map((name) => {
      const wrap = document.createElement('div');
      wrap.className = 'field';
      const auto = autoValue(name);
      wrap.innerHTML = `
        <div class="field-head">
          <label class="name"></label>
          <div class="align" role="group" aria-label="Alignment">
            ${['left', 'center', 'right'].map((a) => `<button type="button" data-align="${a}" title="Grow from the ${a === 'center' ? 'center' : a}">${ALIGN_ICONS[a]}</button>`).join('')}
          </div>
        </div>
        <input type="text" />`;
      const id = `field-${name.replace(/\W+/g, '-')}`;
      wrap.querySelector('.name').textContent = name;
      wrap.querySelector('.name').htmlFor = id;
      const input = wrap.querySelector('input');
      input.id = id;
      input.value = t.values[name] ?? '';
      input.placeholder = auto ? `Automatic: ${auto}` : `Enter ${name}`;
      input.addEventListener('input', () => {
        t.values[name] = input.value;
        saveTemplate(t);
        scheduleRender();
      });
      const setAlign = (a) => {
        wrap.querySelectorAll('[data-align]').forEach((b) => b.classList.toggle('on', b.dataset.align === a));
      };
      setAlign(t.align[name] || 'left');
      wrap.querySelector('.align').addEventListener('click', (e) => {
        const a = e.target.closest('button')?.dataset.align;
        if (!a) return;
        t.align[name] = a;
        setAlign(a);
        saveTemplate(t);
        scheduleRender();
      });
      return wrap;
    }),
  );
}

// ---------- rendering ----------

let renderTimer;
let renderSeq = 0;
function scheduleRender(delay = 40) {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(renderNow, delay);
}

async function renderNow() {
  const t = current();
  if (!t) return;
  const seq = ++renderSeq;
  try {
    const filled = fillTemplate(t.svg, t.values, t.align, $('measure'));
    const canvas = await renderLabel(filled, sizeOf(t), t.rotation);
    if (seq !== renderSeq) return;
    const { mode, threshold, offsetX, offsetY } = state.settings;
    state.labelCanvas = canvas;
    state.raster = toRaster(canvas, {
      mode, threshold, offsetX: offsetX * DOTS_PER_MM, offsetY: offsetY * DOTS_PER_MM,
    });
    state.renderError = null;
  } catch (e) {
    if (seq !== renderSeq) return;
    state.raster = null;
    state.renderError = e.message;
  }
  drawPreview();
  renderInfo();
  updatePrintButton();
}

let hatch;
function hatchPattern(ctx) {
  if (!hatch) {
    const c = document.createElement('canvas');
    c.width = c.height = 8;
    const g = c.getContext('2d');
    g.fillStyle = 'rgba(196,55,43,0.10)';
    g.fillRect(0, 0, 8, 8);
    g.strokeStyle = 'rgba(196,55,43,0.45)';
    g.beginPath();
    g.moveTo(0, 8);
    g.lineTo(8, 0);
    g.stroke();
    hatch = c;
  }
  return ctx.createPattern(hatch, 'repeat');
}

/**
 * Strips of the label (in dots) that never print. Left/right: parts of the
 * label outside the 48 mm print head. Top/bottom: rows pushed off the label
 * by the vertical shift.
 */
function unprintableEdges(raster, width, height) {
  const dy = raster.offsetY ?? 0;
  return {
    left: Math.min(width, Math.max(0, -raster.headStart)),
    right: Math.min(width, Math.max(0, raster.headStart + width - HEAD_DOTS)),
    top: Math.min(height, Math.max(0, -dy)),
    bottom: Math.min(height, Math.max(0, dy)),
  };
}

/** 1-bit print image at printer resolution (1 px = 1 dot). */
function monoCanvas(raster, w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < raster.mono.length; i++) {
    const v = raster.mono[i] ? 17 : 255;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/**
 * Draw the preview at screen resolution. "print" smooths the printer dots
 * slightly, the way they blend together on paper. "dots" shows the exact
 * printer pixels.
 */
function drawPreview() {
  const canvas = $('preview');
  const stage = $('stageCanvas');
  const { labelCanvas, raster } = state;
  if (!labelCanvas || !raster) return;
  const { width: w, height: h } = labelCanvas;
  const pad = getComputedStyle(stage);
  const availW = stage.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight);
  // On phones the page scrolls and the stage grows with the preview, so cap by screen height instead.
  const availH = matchMedia('(max-width: 720px)').matches
    ? window.innerHeight * 0.55
    : stage.clientHeight - parseFloat(pad.paddingTop) - parseFloat(pad.paddingBottom);
  const scale = Math.max(0.1, Math.min(availW / w, availH / h, 3));
  const cssW = Math.round(w * scale);
  const cssH = Math.round(h * scale);
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  const k = canvas.width / w; // screen pixels per printer dot

  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (state.view === 'original') {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(labelCanvas, 0, 0, canvas.width, canvas.height);
  } else if (state.view === 'dots') {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(monoCanvas(raster, w, h), 0, 0, canvas.width, canvas.height);
  } else {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.filter = `blur(${(k * 0.25).toFixed(2)}px)`;
    ctx.drawImage(monoCanvas(raster, w, h), 0, 0, canvas.width, canvas.height);
    ctx.filter = 'none';
  }

  const cut = unprintableEdges(raster, w, h);
  ctx.save();
  ctx.scale(k, k);
  ctx.fillStyle = hatchPattern(ctx);
  if (cut.left) ctx.fillRect(0, 0, cut.left, h);
  if (cut.right) ctx.fillRect(w - cut.right, 0, cut.right, h);
  if (cut.top) ctx.fillRect(cut.left, 0, w - cut.left - cut.right, cut.top);
  if (cut.bottom) ctx.fillRect(cut.left, h - cut.bottom, w - cut.left - cut.right, cut.bottom);
  ctx.restore();
  $('labelFrame').classList.toggle('round', !!sizeOf(current()).round);
}

function renderInfo() {
  const t = current();
  if (!t) return;
  const size = sizeOf(t);
  const parts = [sizeDims(size), `${Math.round(size.width * DOTS_PER_MM)} × ${Math.round(size.height * DOTS_PER_MM)} dots`];
  if (state.raster) {
    const cut = unprintableEdges(state.raster, state.labelCanvas.width, state.labelCanvas.height);
    const mm = (n) => +(n / DOTS_PER_MM).toFixed(1);
    const sides = ['left', 'right', 'top', 'bottom'].filter((s) => cut[s]).map((s) => `${mm(cut[s])} mm ${s}`);
    if (sides.length) parts.push(`won't print: ${sides.join(', ')} (hatched)`);
    if (state.settings.mode === 'auto') parts.push(`auto: ${state.raster.mode === 'threshold' ? 'sharp' : 'dithered'}`);
  }
  $('stageInfo').textContent = parts.join(' · ');

  const warnings = [];
  if (state.renderError) warnings.push(state.renderError);
  if (state.missingFonts.length) {
    warnings.push(`Font${state.missingFonts.length > 1 ? 's' : ''} not installed on this Mac: ${state.missingFonts.join(', ')}. ` +
      'Text will use a fallback font. Install the font, or in Figma outline the text layers that don\'t change.');
  }
  const sideways = t.rotation === 90 || t.rotation === 270;
  const boxW = sideways ? size.height : size.width;
  const boxH = sideways ? size.width : size.height;
  if (Math.abs(Math.log(t.width / t.height) - Math.log(boxW / boxH)) > 0.04) {
    warnings.push(`This design (${Math.round(t.width)} × ${Math.round(t.height)}) is a different shape from the label, so it's scaled to fit with blank margins. ` +
      `For an exact fit, make the Figma frame ${boxW * DOTS_PER_MM} × ${boxH * DOTS_PER_MM}.`);
  }
  $('warnings').replaceChildren(
    ...warnings.map((w) => Object.assign(document.createElement('div'), { className: 'warning', textContent: w })),
  );
}

// ---------- connection ----------

function updateConnection() {
  const on = printer.connected;
  const s = printer.status;
  $('statusDot').classList.toggle('on', on);
  $('statusText').textContent = on
    ? `${printer.transport.name} · ${printer.transport.kind === 'usb' ? 'USB' : 'Bluetooth'}`
    : 'Not connected';
  const chips = [];
  if (on && s.battery != null) chips.push([`Battery ${s.battery}%`, s.battery <= 15]);
  if (on && s.paper) chips.push([s.paper === 'ok' ? 'Paper OK' : 'No paper', s.paper !== 'ok']);
  if (on && s.cover === 'open') chips.push(['Cover open', true]);
  $('statusChips').replaceChildren(
    ...chips.map(([text, bad]) => Object.assign(document.createElement('span'), { className: `chip${bad ? ' bad' : ''}`, textContent: text })),
  );
  $('connectUsb').classList.toggle('hidden', on);
  $('connectBle').classList.toggle('hidden', on);
  $('disconnect').classList.toggle('hidden', !on);
  updatePrintButton();
}

async function connectWith(fn, label) {
  try {
    const transport = await fn();
    await printer.attach(transport);
    toast(`Connected over ${label}`);
  } catch (e) {
    if (e.name === 'NotFoundError' || e.name === 'AbortError') return; // picker dismissed
    toast(e.message || `Could not connect over ${label}`, 'error');
  }
}

function setupConnection() {
  if (!UsbTransport.supported) {
    $('connectUsb').disabled = true;
    $('connectUsb').title = 'USB printing needs a Chromium browser (Chrome, Edge, Helium)';
  }
  if (!BleTransport.supported) {
    $('connectBle').disabled = true;
    $('connectBle').title = 'Bluetooth printing needs a Chromium browser (Chrome, Edge, Helium)';
  }
  $('connectUsb').addEventListener('click', () => connectWith(() => UsbTransport.request(), 'USB'));
  $('connectBle').addEventListener('click', (e) =>
    connectWith(() => BleTransport.request({ showAll: e.shiftKey }), 'Bluetooth'));
  $('disconnect').addEventListener('click', () => printer.detach());
  printer.addEventListener('change', updateConnection);

  if (UsbTransport.supported) {
    UsbTransport.reconnect().then((t) => t && printer.attach(t)).catch(() => {});
    navigator.usb.addEventListener('connect', async (e) => {
      if (printer.connected || e.device.vendorId !== 0x0483) return;
      await sleep(500);
      try {
        await printer.attach(await UsbTransport.open(e.device));
        toast('Printer connected');
      } catch {}
    });
    navigator.usb.addEventListener('disconnect', (e) => {
      if (printer.transport?.device === e.device) {
        printer.detach();
        toast('Printer unplugged');
      }
    });
  }
  // Keep battery and paper status fresh.
  setInterval(() => { if (printer.connected && !state.printing) printer.refreshStatus().catch(() => {}); }, 30000);
}

// ---------- printing ----------

function updatePrintButton() {
  const t = current();
  const btn = $('printBtn');
  let hint = '';
  if (!t) hint = 'Import a template to get started';
  else if (!printer.connected) hint = 'Connect the printer to print';
  else if (state.renderError) hint = 'Fix the template error first';
  else hint = 'Press ⌘P to print';
  if (state.printing) hint = $('printHint').textContent;
  btn.disabled = !t || !printer.connected || !state.raster || state.printing;
  btn.textContent = state.printing ? 'Printing…' : 'Print';
  $('printHint').textContent = hint;
}

function copies() {
  const n = Math.max(1, Math.min(99, parseInt($('copies').value, 10) || 1));
  $('copies').value = n;
  return n;
}

async function print() {
  const t = current();
  if (!t) return;
  await runPrint(copies(), async () => {
    await renderNow(); // refresh automatic values like {{time}}
    if (!state.raster) throw new Error(state.renderError || 'Nothing to print');
    return state.raster;
  });
}

/** Dashed box 3 mm inside the edges plus a center cross, for measuring the offset. */
function alignmentSvg({ width: w, height: h }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
    <rect x="3" y="3" width="${w - 6}" height="${h - 6}" fill="none" stroke="#000" stroke-width="0.3" stroke-dasharray="1.5 1"/>
    <path d="M${w / 2 - 4} ${h / 2}H${w / 2 + 4}M${w / 2} ${h / 2 - 4}V${h / 2 + 4}" stroke="#000" stroke-width="0.3"/>
    <text x="${w / 2}" y="${h / 2 + 8}" font-family="Helvetica" font-size="2.6" text-anchor="middle">3 mm from each edge</text>
  </svg>`;
}

async function printAlignmentTest() {
  const t = current();
  const size = t ? sizeOf(t) : allSizes()[0];
  await runPrint(1, async () => {
    const canvas = await renderLabel(alignmentSvg(size), size, 0);
    const { threshold, offsetX, offsetY } = state.settings;
    return toRaster(canvas, { mode: 'threshold', threshold, offsetX: offsetX * DOTS_PER_MM, offsetY: offsetY * DOTS_PER_MM });
  });
}

async function runPrint(n, getRaster) {
  if (state.printing) return;
  if (!printer.connected) return toast('Connect the printer first', 'error');
  state.printing = true;
  updatePrintButton();
  const progress = $('progress');
  progress.classList.remove('hidden');
  $('progressBar').style.width = '0';
  try {
    await printer.refreshStatus();
    await sleep(150);
    if (printer.status.paper === 'out') throw new Error('The printer is out of labels');
    if (printer.status.cover === 'open') throw new Error('The printer cover is open');
    const raster = await getRaster();
    await printer.print(raster, {
      density: state.settings.density,
      media: state.settings.media,
      copies: n,
      onProgress: (p, copy) => {
        $('progressBar').style.width = `${Math.round(p * 100)}%`;
        $('printHint').textContent = n > 1 ? `Printing ${copy} of ${n}…` : 'Printing…';
      },
    });
    toast(n > 1 ? `Printed ${n} labels` : 'Printed');
  } catch (e) {
    toast(e.message || 'Printing failed', 'error');
  } finally {
    state.printing = false;
    progress.classList.add('hidden');
    $('printHint').textContent = '';
    updatePrintButton();
  }
}

// ---------- sizes dialog ----------

function renderSizeList() {
  $('sizeList').replaceChildren(
    ...allSizes().map((s) => {
      const li = document.createElement('li');
      li.append(Object.assign(document.createElement('span'), { textContent: sizeLabel(s) }));
      if (state.customSizes.includes(s)) {
        const del = Object.assign(document.createElement('button'), { type: 'button', className: 'btn small ghost danger', textContent: 'Remove' });
        del.addEventListener('click', () => {
          state.customSizes = state.customSizes.filter((c) => c !== s);
          saveSetting('customSizes', state.customSizes);
          renderSizeList();
          afterSizesChanged();
        });
        li.append(del);
      } else {
        li.append(Object.assign(document.createElement('span'), { className: 'muted', textContent: 'Built in' }));
      }
      return li;
    }),
  );
}

function afterSizesChanged() {
  renderSizeSelect();
  renderList();
  scheduleRender(0);
}

function addSize() {
  const round = $('newSizeRound').checked;
  const width = parseFloat($('newSizeW').value);
  const height = round ? width : parseFloat($('newSizeH').value);
  if (!(width >= 10 && width <= 60) || !(height >= 5 && height <= 300)) {
    toast(round ? 'Enter a diameter of 10–60 mm' : 'Enter a width of 10–60 mm and a height of 5–300 mm', 'error');
    return;
  }
  const size = { id: `custom-${crypto.randomUUID()}`, name: $('newSizeName').value.trim(), width, height, ...(round && { round }) };
  state.customSizes.push(size);
  saveSetting('customSizes', state.customSizes);
  $('newSizeName').value = $('newSizeW').value = $('newSizeH').value = '';
  $('newSizeRound').checked = false;
  $('newSizeH').disabled = false;
  renderSizeList();
  afterSizesChanged();
  if (width > HEAD_DOTS / DOTS_PER_MM) toast(`Added. Only the middle 48 mm of a ${width} mm label can print.`);
}

// ---------- wiring ----------

function bindSettings() {
  const s = state.settings;
  const media = $('media');
  media.replaceChildren(...Object.entries(MEDIA_TYPES).map(([k, v]) => new Option(v.label, k)));

  const bind = (id, key, parse, out) => {
    const el = $(id);
    el.value = s[key];
    if (out) $(out).textContent = s[key];
    el.addEventListener('input', () => {
      const v = parse(el.value);
      if (Number.isNaN(v)) return;
      s[key] = v;
      if (out) $(out).textContent = v;
      saveSettings();
      scheduleRender();
    });
  };
  bind('density', 'density', Number, 'densityOut');
  bind('threshold', 'threshold', Number, 'thresholdOut');
  bind('mode', 'mode', String);
  bind('media', 'media', String);
  bind('offsetX', 'offsetX', parseFloat);
  bind('offsetY', 'offsetY', parseFloat);
}

function setup() {
  bindSettings();
  setupConnection();

  $('sizeSelect').addEventListener('change', (e) => {
    const t = current();
    t.sizeId = e.target.value;
    saveTemplate(t);
    renderList();
    scheduleRender(0);
  });
  $('rotation').addEventListener('change', (e) => {
    const t = current();
    t.rotation = Number(e.target.value);
    saveTemplate(t);
    scheduleRender(0);
  });
  document.querySelectorAll('input[name="view"]').forEach((r) =>
    r.addEventListener('change', () => { state.view = r.value; drawPreview(); }));

  $('titleInput').addEventListener('input', (e) => {
    const t = current();
    t.name = e.target.value || 'Untitled';
    saveTemplate(t);
    const item = document.querySelector(`.template-item[data-id="${t.id}"] .name`);
    if (item) item.textContent = t.name;
  });
  $('titleInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });

  $('importBtn').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (e) => { importFiles([...e.target.files]); e.target.value = ''; });
  $('replaceFile').addEventListener('click', () => $('replaceInput').click());
  $('replaceInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    const t = current();
    if (!file || !t) return;
    try {
      replaceSvg(t, await readFile(file));
      t.fileName = file.name;
      await saveTemplate(t, true);
      select(t.id);
      toast('Template updated');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  $('updateClipboard').addEventListener('click', async () => {
    const t = current();
    try {
      const text = await navigator.clipboard.readText();
      if (!text.includes('<svg')) throw new Error('The clipboard has no SVG. In Figma: right-click the frame → Copy/Paste as → Copy as SVG.');
      replaceSvg(t, importSvg(text));
      await saveTemplate(t, true);
      select(t.id);
      toast('Template updated from clipboard');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // Paste an SVG copied from Figma (or an image) to create a template.
  document.addEventListener('paste', (e) => {
    if (e.target.closest('input, textarea, select')) return;
    const text = e.clipboardData.getData('text/plain') || e.clipboardData.getData('image/svg+xml');
    if (text.includes('<svg')) {
      e.preventDefault();
      importSvgText(text);
      return;
    }
    const files = [...e.clipboardData.files].filter((f) => /^image\/(png|jpeg|svg\+xml)$/.test(f.type));
    if (files.length) {
      e.preventDefault();
      importFiles(files.map((f, i) => new File([f], f.name && f.name !== 'image.png' ? f.name : `Pasted image ${Date.now()}${i}.png`, { type: f.type })));
    }
  });

  // Drag and drop files anywhere.
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    dragDepth++;
    $('dropOverlay').classList.remove('hidden');
  });
  window.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) { dragDepth = 0; $('dropOverlay').classList.add('hidden'); }
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('dropOverlay').classList.add('hidden');
    if (e.dataTransfer.files.length) importFiles([...e.dataTransfer.files]);
  });

  $('manageSizes').addEventListener('click', () => { renderSizeList(); $('sizesDialog').showModal(); });
  $('addSize').addEventListener('click', addSize);
  $('newSizeRound').addEventListener('change', (e) => {
    $('newSizeH').disabled = e.target.checked;
    $('newSizeW').placeholder = e.target.checked ? 'Diameter mm' : 'Width mm';
  });
  $('sizesDialog').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.closest('.add-size')) { e.preventDefault(); addSize(); }
  });

  $('copiesDown').addEventListener('click', () => { $('copies').value = copies() - 1; copies(); });
  $('copiesUp').addEventListener('click', () => { $('copies').value = copies() + 1; copies(); });
  $('copies').addEventListener('change', copies);
  $('printBtn').addEventListener('click', print);
  $('alignmentTest').addEventListener('click', printAlignmentTest);
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      print();
    }
  });

  new ResizeObserver(() => drawPreview()).observe($('stageCanvas'));
}

async function init() {
  setup();
  state.templates = (await db.all()).sort((a, b) => a.createdAt - b.createdAt);
  for (const t of state.templates) t.fields = findFields(t.svg);
  if (!current()) state.currentId = state.templates[0]?.id ?? null;
  select(state.currentId);
  updateConnection();
}

init();
