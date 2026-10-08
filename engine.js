// Apple browning engine for the PWA (no dependencies). ROI part mirrors roi_engine.py step for step (Phase 1);
// measure() adds local white-paper normalisation, CIELAB features and the ridge model (Phase 3).
// Input: raw oriented RGB (uint8) with a 8-byte header (uint32 LE width, height). Output: JSON on stdout.
// The same functions are reused by the PWA (Phase 3), where the browser decodes the JPEG.
'use strict';
const CFG = { n_pieces: 4, ds: 2, blur: 5, bg: 101, k_mad: 6.0, min_dyb: 0.04, min_area: 30, min_fill: 0.45, max_aspect: 2.2,
  nb_k: 6.0, area_ratio: 2.5, erode_piece: 1, spec_max: 0.96, paper_y: 0.85, paper_chroma: 0.06, paper_sd: 0.02,
  paper_near: 3000, dish_k: 5.5, card_lo: 0.25, card_hi: 0.62, card_chroma: 0.16, card_fill: 0.70, card_erode: 6 };

const s2l = c => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
function percentile(arr, q) { // numpy 'linear' method
  const a = Float64Array.from(arr).sort(); const pos = (a.length - 1) * q / 100; const lo = Math.floor(pos), hi = Math.ceil(pos);
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}
const median = a => percentile(a, 50);
function boxDown(src, W, H, f, ch, fn) { // average f x f blocks after applying fn per value
  const w = Math.floor(W / f), h = Math.floor(H / f), out = new Float64Array(w * h * ch);
  for (let y = 0; y < h * f; y++) for (let x = 0; x < w * f; x++) {
    const o = ((Math.floor(y / f)) * w + Math.floor(x / f)) * ch, i = (y * W + x) * ch;
    for (let c = 0; c < ch; c++) out[o + c] += fn(src[i + c]);
  }
  for (let i = 0; i < out.length; i++) out[i] /= f * f;
  return { a: out, w, h };
}
function boxBlur(x, w, h, k) { // edge-padded box mean via integral image
  const r = Math.floor(k / 2), W = w + 2 * r, Hh = h + 2 * r, I = new Float64Array((W + 1) * (Hh + 1));
  for (let y = 0; y < Hh; y++) { const sy = Math.min(Math.max(y - r, 0), h - 1); let row = 0;
    for (let xx = 0; xx < W; xx++) { const sx = Math.min(Math.max(xx - r, 0), w - 1); row += x[sy * w + sx];
      I[(y + 1) * (W + 1) + xx + 1] = I[y * (W + 1) + xx + 1] + row; } }
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) for (let xx = 0; xx < w; xx++)
    out[y * w + xx] = (I[(y + k) * (W + 1) + xx + k] - I[y * (W + 1) + xx + k] - I[(y + k) * (W + 1) + xx] + I[y * (W + 1) + xx]) / (k * k);
  return out;
}
function morph(m, w, h, r, isErode) {
  let a = m;
  for (let it = 0; it < r; it++) { const b = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x;
      const n = [a[i], y > 0 ? a[i - w] : 0, y < h - 1 ? a[i + w] : 0, x > 0 ? a[i - 1] : 0, x < w - 1 ? a[i + 1] : 0];
      b[i] = isErode ? (n.every(v => v) ? 1 : 0) : (n.some(v => v) ? 1 : 0); }
    a = b; }
  return a;
}
const erode = (m, w, h, r) => morph(m, w, h, r, true), dilate = (m, w, h, r) => morph(m, w, h, r, false);
function label(m, w, h) { // 4-connected, BFS flood fill; returns labels (0 = background) and areas
  const lab = new Int32Array(w * h), areas = [0], q = new Int32Array(w * h); let n = 0;
  for (let s = 0; s < w * h; s++) { if (!m[s] || lab[s]) continue; n++; let head = 0, tail = 0, cnt = 0; q[tail++] = s; lab[s] = n;
    while (head < tail) { const i = q[head++]; cnt++; const y = Math.floor(i / w), x = i - y * w;
      for (const j of [y > 0 ? i - w : -1, y < h - 1 ? i + w : -1, x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1])
        if (j >= 0 && m[j] && !lab[j]) { lab[j] = n; q[tail++] = j; } }
    areas.push(cnt); }
  return { lab, areas };
}
function fillHoles(m, w, h) {
  const inv = m.map(v => v ? 0 : 1), { lab } = label(inv, w, h), border = new Set();
  for (let x = 0; x < w; x++) { border.add(lab[x]); border.add(lab[(h - 1) * w + x]); }
  for (let y = 0; y < h; y++) { border.add(lab[y * w]); border.add(lab[y * w + w - 1]); }
  return m.map((v, i) => (v || (lab[i] > 0 && !border.has(lab[i]))) ? 1 : 0);
}
function bbox(idx, w) { let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, sx = 0, sy = 0;
  for (const i of idx) { const y = Math.floor(i / w), x = i - y * w; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); sx += x; sy += y; }
  return { x0, y0, x1, y1, cx: sx / idx.length, cy: sy / idx.length }; }
function meanRGB(lin, idx) { const s = [0, 0, 0]; for (const i of idx) for (let c = 0; c < 3; c++) s[c] += lin[i * 3 + c]; return s.map(v => v / idx.length); }

function analyse(rgb8, W0, H0, nPieces) {
  const c = CFG; nPieces = nPieces || c.n_pieces; const flags = [];
  const S = boxDown(rgb8, W0, H0, c.ds, 3, v => v / 255), L = boxDown(rgb8, W0, H0, c.ds, 3, v => s2l(v / 255));
  const { w, h } = S, N = w * h, srgb = S.a, lin = L.a;
  const g = [0, 1, 2].map(ch => percentile(Array.from({ length: N }, (_, i) => srgb[i * 3 + ch]), 95));
  const Y = new Float64Array(N), chroma = new Float64Array(N), yb0 = new Float64Array(N), spec = new Uint8Array(N);
  for (let i = 0; i < N; i++) { const r = srgb[i * 3] / g[0], gg = srgb[i * 3 + 1] / g[1], b = srgb[i * 3 + 2] / g[2];
    Y[i] = (r + gg + b) / 3; chroma[i] = Math.max(r, gg, b) - Math.min(r, gg, b); yb0[i] = (r + gg) / 2 - b;
    spec[i] = Math.max(srgb[i * 3], srgb[i * 3 + 1], srgb[i * 3 + 2]) > c.spec_max ? 1 : 0; }
  // pieces
  const b5 = boxBlur(yb0, w, h, c.blur), bB = boxBlur(yb0, w, h, c.bg), yb = b5.map((v, i) => v - bB[i]);
  const med = median(yb), mad = 1.4826 * median(yb.map(v => Math.abs(v - med))), T = med + Math.max(c.k_mad * mad, c.min_dyb);
  let m = dilate(erode(yb.map(v => v > T ? 1 : 0), w, h, 1), w, h, 1);
  const { lab, areas } = label(m, w, h), members = Array.from({ length: areas.length }, () => []);
  for (let i = 0; i < N; i++) if (lab[i]) members[lab[i]].push(i);
  const cand = [];
  for (let k = 1; k < areas.length; k++) { if (areas[k] < c.min_area) continue; const bb = bbox(members[k], w);
    const bw = bb.x1 - bb.x0 + 1, bh = bb.y1 - bb.y0 + 1;
    if (areas[k] / (bw * bh) < c.min_fill || Math.max(bw, bh) / Math.min(bw, bh) > c.max_aspect) continue;
    cand.push({ k, a: areas[k], x: bb.cx, y: bb.cy }); }
  let best = -1, bestSet = [];
  for (const q of cand) { const D = c.nb_k * Math.sqrt(q.a);
    const nb = cand.filter(o => (o.x - q.x) ** 2 + (o.y - q.y) ** 2 <= D * D && q.a / c.area_ratio <= o.a && o.a <= q.a * c.area_ratio);
    const tot = [...nb].sort((u, v) => v.a - u.a).slice(0, nPieces).reduce((s, o) => s + o.a, 0);
    if (tot > best) { best = tot; bestSet = nb; } }
  const order = [...bestSet].sort((u, v) => v.a - u.a).slice(0, nPieces).map(o => o.k);
  if (order.length < nPieces) flags.push(`only_${order.length}_pieces`);
  let pieces = [];
  for (const k of order) { const pm = new Uint8Array(N); for (const i of members[k]) pm[i] = 1;
    const er = erode(pm, w, h, c.erode_piece); let core = []; for (let i = 0; i < N; i++) if (er[i] && !spec[i]) core.push(i);
    if (core.length < 10) { core = members[k].filter(i => !spec[i]); flags.push('piece_core_small'); }
    const bb = bbox(members[k], w);
    pieces.push({ cx: bb.cx, cy: bb.cy, area: members[k].length, x0: bb.x0, y0: bb.y0, x1: bb.x1, y1: bb.y1, n_core: core.length,
      spec_frac: members[k].filter(i => spec[i]).length / members[k].length, lin_rgb: meanRGB(lin, core), _core: core }); }
  let ccx = w / 2, ccy = h / 2;
  if (pieces.length) { ccx = pieces.reduce((s, p) => s + p.cx, 0) / pieces.length; ccy = pieces.reduce((s, p) => s + p.cy, 0) / pieces.length;
    pieces.sort((p, q) => Math.atan2(p.cy - ccy, p.cx - ccx) - Math.atan2(q.cy - ccy, q.cx - ccx)); }
  // local white
  const Ym = boxBlur(Y, w, h, 7), Y2 = boxBlur(Y.map(v => v * v), w, h, 7);
  const pw = pieces.length ? median(pieces.map(p => Math.sqrt(p.area))) : 30, R = c.dish_k * pw + 15;
  const cands = [];
  for (let i = 0; i < N; i++) { const y = Math.floor(i / w), x = i - y * w, d2 = (x - ccx) ** 2 + (y - ccy) ** 2;
    const sd = Math.sqrt(Math.max(Y2[i] - Ym[i] * Ym[i], 0));
    if (Y[i] > c.paper_y && chroma[i] < c.paper_chroma && sd < c.paper_sd && !spec[i] && d2 > R * R) cands.push([d2, i]); }
  let paper = null;
  if (cands.length >= c.paper_near) { cands.sort((u, v) => u[0] - v[0] || u[1] - v[1]); const sel = cands.slice(0, c.paper_near).map(v => v[1]);
    paper = { n: sel.length, excl_radius: R, max_dist: Math.sqrt(cands[c.paper_near - 1][0]),
      local_lin_rgb: [0, 1, 2].map(ch => median(sel.map(i => lin[i * 3 + ch]))), local_Yb_mean: sel.reduce((s, i) => s + Y[i], 0) / sel.length };
  } else flags.push('no_white_ref');
  // grey card
  const cm = dilate(erode(Y.map((v, i) => (v > c.card_lo && v < c.card_hi && chroma[i] < c.card_chroma) ? 1 : 0), w, h, 2), w, h, 2);
  const CL = label(cm, w, h), border = new Set();
  for (let x = 0; x < w; x++) { border.add(CL.lab[x]); border.add(CL.lab[(h - 1) * w + x]); }
  for (let y = 0; y < h; y++) { border.add(CL.lab[y * w]); border.add(CL.lab[y * w + w - 1]); }
  const cmem = Array.from({ length: CL.areas.length }, () => []); for (let i = 0; i < N; i++) if (CL.lab[i]) cmem[CL.lab[i]].push(i);
  const ordC = CL.areas.map((a, k) => [a, k]).sort((u, v) => v[0] - u[0]).map(v => v[1]);
  let bestC = 0;
  for (const k of ordC) { if (k === 0 || border.has(k) || CL.areas[k] < 500) continue; const bb = bbox(cmem[k], w);
    if (CL.areas[k] / ((bb.x1 - bb.x0 + 1) * (bb.y1 - bb.y0 + 1)) < c.card_fill) continue; bestC = k; break; }
  let card = null;
  if (bestC) { let cmask = new Uint8Array(N); for (const i of cmem[bestC]) cmask[i] = 1; cmask = fillHoles(cmask, w, h);
    const er = erode(cmask, w, h, c.card_erode); let inner = []; for (let i = 0; i < N; i++) if (er[i] && !spec[i]) inner.push(i);
    const all = []; for (let i = 0; i < N; i++) if (cmask[i]) all.push(i);
    if (inner.length < 50) { inner = all; flags.push('card_inner_small'); }
    const bb = bbox(all, w); card = { area: all.length, x0: bb.x0, y0: bb.y0, x1: bb.x1, y1: bb.y1, n_inner: inner.length, lin_rgb: meanRGB(lin, inner) };
  } else flags.push('no_card');
  return { w: W0, h: H0, ds: c.ds, seg_threshold: T, seg_gain: g, cluster: [ccx, ccy], pieces, paper, card, flags, _lin: lin, _w: w, _h: h };
}

// ---------------- Phase 3: features and model ----------------
function linToLab(r, g, b) { // linear sRGB -> CIELAB (D65), constants as in roi_engine.py
  const X = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047, Yv = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b,
        Z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883, e = Math.pow(6 / 29, 3), k = 3 * Math.pow(6 / 29, 2);
  const f = t => t > e ? Math.cbrt(t) : t / k + 4 / 29, fx = f(X), fy = f(Yv), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
function predictDE(model, feats) { let s = model.b; model.features.forEach((f, i) => { s += model.w[i] * (feats[f] - model.mu[i]) / model.sd[i]; }); return Math.max(s, 0); }
const levelOf = (bands, x) => bands.filter(t => x >= t).length;
function measure(rgb8, W, H, nPieces, model) {
  const res = analyse(rgb8, W, H, nPieces), out = { res, flags: res.flags.slice(), ok: true };
  if (!res.paper) { out.ok = false; out.error = 'no_white_ref'; return out; }
  if (!res.pieces.length) { out.ok = false; out.error = 'no_pieces'; return out; }
  const gain = res.paper.local_lin_rgb.map(v => model.white_target_linear / v), lin = res._lin;
  const pm = res.pieces.map(p => { const s = [0, 0, 0];
    for (const i of p._core) { const lab = linToLab(Math.max(lin[i * 3] * gain[0], 0), Math.max(lin[i * 3 + 1] * gain[1], 0), Math.max(lin[i * 3 + 2] * gain[2], 0)); s[0] += lab[0]; s[1] += lab[1]; s[2] += lab[2]; }
    return s.map(v => v / p._core.length); });
  const dish = [0, 1, 2].map(j => pm.reduce((a, q) => a + q[j], 0) / pm.length);
  const feats = { L: dish[0], a: dish[1], b: dish[2], C: Math.hypot(dish[1], dish[2]), h: Math.atan2(dish[2], dish[1]) * 180 / Math.PI };
  out.gain = gain; out.dish_lab = dish; out.features = feats;
  out.dE_pred = predictDE(model, feats); out.level = levelOf(model.bands, out.dE_pred);
  out.pieces = res.pieces.map((p, j) => { const f = { L: pm[j][0], a: pm[j][1], b: pm[j][2] }; const d = predictDE(model, f);
    return { box: [p.x0, p.y0, p.x1, p.y1].map(v => v * res.ds), lab: pm[j], dE_pred: d, level: levelOf(model.bands, d) }; });
  if (res.pieces.length < nPieces) out.flags.push('fewer_pieces_than_selected');
  return out;
}
function compareToReference(now, ref, model) { // rule: dE*ab of dish-mean Lab vs the fresh-cut reference photo
  const d = Math.hypot(now.dish_lab[0] - ref.dish_lab[0], now.dish_lab[1] - ref.dish_lab[1], now.dish_lab[2] - ref.dish_lab[2]);
  return { dE: d, level: levelOf(model.bands, d), dL: now.dish_lab[0] - ref.dish_lab[0], db: now.dish_lab[2] - ref.dish_lab[2] };
}
function stripPrivate(o) { const r = JSON.parse(JSON.stringify(o, (k, v) => (k.startsWith('_') ? undefined : v))); return r; }
const ENGINE_API = { analyse, measure, compareToReference, linToLab, predictDE, levelOf, stripPrivate, CFG };
if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE_API;
if (typeof self !== 'undefined') self.AppleEngine = ENGINE_API;
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) { // Node CLI: raw RGB file, pieces, model.json
  const fs = require('fs'), buf = fs.readFileSync(process.argv[2]); const W = buf.readUInt32LE(0), H = buf.readUInt32LE(4);
  const model = JSON.parse(fs.readFileSync(process.argv[4] || __dirname + '/model.json'));
  process.stdout.write(JSON.stringify(stripPrivate(measure(new Uint8Array(buf.buffer, buf.byteOffset + 8, W * H * 3), W, H, +(process.argv[3] || 4), model))));
}
