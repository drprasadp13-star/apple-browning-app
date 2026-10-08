'use strict';
const APP_VERSION = '1.0.0';          // keep equal to VERSION in sw.js; bump both for every release
const MAX_SIDE = 1920;                       // photos are scaled to the dataset geometry (long side 1920 px) before analysis
const LEVEL_COL = ['#F1E9C8', '#DCC58E', '#B98A4E', '#7E5228'];
const NOTE = {
  no_white_ref: 'No white paper found near the dish. Place the dish on plain white paper and keep paper visible around it.',
  no_pieces: 'No apple pieces found. Shoot straight down so the pieces are clearly visible.',
  fewer_pieces_than_selected: 'Fewer pieces were found than the number selected. Check the outlines; the result uses only the pieces found.',
  piece_core_small: 'At least one piece is small or mostly glare; its value is less reliable.',
};
const $ = id => document.getElementById(id);
let MODEL = null, nPieces = 4, mode = 'single', refOut = null, jobId = 0;
const worker = new Worker('worker.js');
const pending = new Map();
worker.onmessage = e => { const p = pending.get(e.data.id); if (p) { pending.delete(e.data.id); e.data.error ? p.reject(new Error(e.data.error)) : p.resolve(e.data); } };
const run = (img, n) => new Promise((resolve, reject) => { const id = ++jobId; pending.set(id, { resolve, reject });
  worker.postMessage({ id, rgb: img.rgb, w: img.w, h: img.h, n, model: MODEL }, [img.rgb.buffer]); });

async function decode(file) {
  let src;
  try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { src = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = URL.createObjectURL(file); }); }
  const W0 = src.width, H0 = src.height, s = Math.min(1, MAX_SIDE / Math.max(W0, H0));
  const w = Math.round(W0 * s), h = Math.round(H0 * s);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(src, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data, rgb = new Uint8Array(w * h * 3);
  for (let i = 0, j = 0; i < px.length; i += 4, j += 3) { rgb[j] = px[i]; rgb[j + 1] = px[i + 1]; rgb[j + 2] = px[i + 2]; }
  return { rgb, w, h, canvas: c, original: [W0, H0] };
}

function placeMarker(dE) {
  const m = $('marker'); m.hidden = false; m.style.left = (Math.min(dE, 12) / 12 * 100) + '%';
}
function draw(img, out) {
  const v = $('view'), scale = Math.min(1, 960 / img.w); v.width = Math.round(img.w * scale); v.height = Math.round(img.h * scale);
  const ctx = v.getContext('2d'); ctx.drawImage(img.canvas, 0, 0, v.width, v.height);
  ctx.lineWidth = 3; ctx.font = '600 15px system-ui, sans-serif';
  (out.pieces || []).forEach((p, i) => {
    const [x0, y0, x1, y1] = p.box.map(t => t * scale);
    ctx.strokeStyle = '#1E2421'; ctx.strokeRect(x0 - 5, y0 - 5, x1 - x0 + 10, y1 - y0 + 10);
    ctx.strokeStyle = LEVEL_COL[p.level]; ctx.lineWidth = 2; ctx.strokeRect(x0 - 3, y0 - 3, x1 - x0 + 6, y1 - y0 + 6); ctx.lineWidth = 3;
    ctx.fillStyle = '#1E2421'; ctx.fillRect(x1 + 6, y0 - 4, 26, 20); ctx.fillStyle = '#FFFFFF'; ctx.fillText(String(i + 1), x1 + 13, y0 + 11);
  });
}
function show(img, out, ms, ref) {
  $('result').hidden = false; draw(img, out);
  const notes = $('notes'); notes.innerHTML = '';
  [...new Set(out.flags || [])].forEach(f => { if (NOTE[f]) { const li = document.createElement('li'); li.textContent = NOTE[f]; notes.appendChild(li); } });
  if (!out.ok) { $('readout').textContent = NOTE[out.error] || 'The photo could not be analysed.'; $('marker').hidden = true; $('nums').innerHTML = ''; $('pieceList').innerHTML = ''; return; }
  const main = ref ? ref.dE : out.dE_pred, lvl = ref ? ref.level : out.level;
  placeMarker(main);
  $('readout').innerHTML = `<strong>${main.toFixed(1)}</strong> ΔE*ab, level ${lvl}` + (ref ? ' (measured against your fresh-cut photo)' : ' (estimated from this photo alone)');
  const rows = [];
  if (ref) rows.push(['Change vs fresh-cut', `ΔL* ${ref.dL.toFixed(1)}, Δb* ${ref.db.toFixed(1)}`], ['Single-photo estimate', `${out.dE_pred.toFixed(1)} ΔE*ab, level ${out.level}`]);
  rows.push(['Dish colour', `L* ${out.dish_lab[0].toFixed(1)}, a* ${out.dish_lab[1].toFixed(1)}, b* ${out.dish_lab[2].toFixed(1)}`],
            ['Pieces found', `${out.pieces.length} of ${nPieces}`], ['Processed', `${Math.round(ms)} ms on this device, ${img.w} × ${img.h} px`]);
  $('nums').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  $('pieceList').innerHTML = out.pieces.map((p, i) => `<li><span class="dot" style="background:${LEVEL_COL[p.level]}"></span>Piece ${i + 1}: ${p.dE_pred.toFixed(1)} (level ${p.level})</li>`).join('');
}
async function handle(file, isRef) {
  if (!file) return;
  $('readout').textContent = 'Analysing…';
  try {
    const img = await decode(file); const keep = { canvas: img.canvas, w: img.w, h: img.h };
    const r = await run(img, nPieces);
    if (isRef) { refOut = r.out; $('refName').textContent = r.out.ok ? `Fresh-cut photo ready (${r.out.pieces.length} pieces)` : (NOTE[r.out.error] || 'Could not analyse this photo.'); $('readout').textContent = 'Now take the photo to compare.'; return; }
    const cmp = (mode === 'ref' && refOut && refOut.ok && r.out.ok) ? AppleCompare(r.out, refOut) : null;
    if (mode === 'ref' && !refOut) $('notes').innerHTML = '<li>Add the fresh-cut photo first to measure the change directly.</li>';
    show(keep, r.out, r.ms, cmp);
  } catch (err) { $('readout').textContent = 'The photo could not be opened: ' + err.message; }
}
function AppleCompare(now, ref) {
  const d = Math.hypot(now.dish_lab[0] - ref.dish_lab[0], now.dish_lab[1] - ref.dish_lab[1], now.dish_lab[2] - ref.dish_lab[2]);
  return { dE: d, level: MODEL.bands.filter(t => d >= t).length, dL: now.dish_lab[0] - ref.dish_lab[0], db: now.dish_lab[2] - ref.dish_lab[2] };
}
function setPieces(n) { nPieces = Math.max(1, Math.min(12, n)); $('pieces').textContent = nPieces; }
function setNet() { $('net').textContent = navigator.onLine ? 'Online' : 'Offline, working from the saved copy'; }
async function init() {
  MODEL = await (await fetch('model.json')).json();
  $('ver').textContent = `app ${APP_VERSION}, model ${MODEL.version}`; $('mae').textContent = MODEL.nested_lodo.MAE.toFixed(1);
  $('minus').onclick = () => setPieces(nPieces - 1); $('plus').onclick = () => setPieces(nPieces + 1);
  document.querySelectorAll('.seg button').forEach(b => b.onclick = () => {
    mode = b.dataset.mode; document.querySelectorAll('.seg button').forEach(x => x.setAttribute('aria-checked', String(x === b)));
    $('refShot').hidden = mode !== 'ref';
  });
  const pick = isRef => e => { const f = e.target.files[0]; e.target.value = ''; handle(f, isRef); };   // reset so the same photo can be chosen again
  $('fileCam').onchange = pick(false); $('fileLib').onchange = pick(false); $('fileRef').onchange = pick(true);
  addEventListener('online', setNet); addEventListener('offline', setNet); setNet();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
init();
