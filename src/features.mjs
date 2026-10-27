// Stage 3: feature-specific numeric diagnostics on a single matched region, intended for 2x captures.
// All functions take decoded RGBA images ({width,height,data}) and a physical-pixel `box`
// {x0,y0,x1,y1} (inclusive) that contains the shape plus a margin of plain background.
// Outputs are in CSS px (physical / dpr), signed candidate - reference.
import { rgbToLab, deltaE76 } from './residual.mjs';

const labAt = (img, x, y) => { const i = (y * img.width + x) * 4; return rgbToLab(img.data[i], img.data[i + 1], img.data[i + 2]); };
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// Background = per-channel median of the box's border ring.
function backgroundLab(img, box) {
  const L = [[], [], []];
  const push = (x, y) => { const c = labAt(img, x, y); for (let k = 0; k < 3; k++) L[k].push(c[k]); };
  for (let x = box.x0; x <= box.x1; x++) { push(x, box.y0); push(x, box.y1); }
  for (let y = box.y0 + 1; y < box.y1; y++) { push(box.x0, y); push(box.x1, y); }
  return L.map((a) => a.sort((p, q) => p - q)[a.length >> 1]);
}

/**
 * Per-pixel coverage in [0,1]: how much of the shape's fill each pixel shows, found by projecting
 * (pixel - background) onto (fill - background). For a flat-filled shape this is true antialias coverage.
 */
export function coverageMap(img, box) {
  const w = box.x1 - box.x0 + 1, h = box.y1 - box.y0 + 1;
  const bg = backgroundLab(img, box);
  const labs = new Array(w * h);
  let maxD = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = labAt(img, box.x0 + x, box.y0 + y); labs[y * w + x] = c;
    maxD = Math.max(maxD, deltaE76(c, bg));
  }
  // Fill = mean of the pixels at >= 95% of the extreme distance from the background.
  let sum = [0, 0, 0], n = 0;
  for (const c of labs) if (deltaE76(c, bg) >= 0.95 * maxD) { sum = [sum[0] + c[0], sum[1] + c[1], sum[2] + c[2]]; n++; }
  const fill = n ? sum.map((v) => v / n) : bg;
  const axis = sub(fill, bg), denom = dot(axis, axis);
  const cov = new Float32Array(w * h), mag = new Float32Array(w * h);
  // `mag` (distance from background, normalised) locates edges even when the fill is a gradient.
  if (maxD > 1e-9) for (let i = 0; i < mag.length; i++) mag[i] = deltaE76(labs[i], bg) / maxD;
  if (denom > 1e-9) for (let i = 0; i < cov.length; i++) cov[i] = Math.min(1, Math.max(0, dot(sub(labs[i], bg), axis) / denom));
  return { w, h, cov, mag, bg, fill, maxDeltaE: maxD };
}

function edgesOf(cm) {
  const { w, h, mag } = cm;
  const rowSum = (y0, y1) => { const v = new Float64Array(w); for (let y = y0; y < y1; y++) for (let x = 0; x < w; x++) v[x] += mag[y * w + x] / (y1 - y0); return v; };
  const colSum = (x0, x1) => { const v = new Float64Array(h); for (let x = x0; x < x1; x++) for (let y = 0; y < h; y++) v[y] += mag[y * w + x] / (x1 - x0); return v; };
  // Rows/cols through the middle half avoid rounded corners.
  const mid = rowSum(Math.floor(h * 0.375), Math.ceil(h * 0.625)), midC = colSum(Math.floor(w * 0.375), Math.ceil(w * 0.625));
  // Edge = centre of mass of the sharpest coverage step (g_i = v[i]-v[i-1] at boundary i). For an antialiased
  // step this is exact, and a smooth shadow's gentle slope does not move it.
  const span = (v) => {
    const g = new Float64Array(v.length + 1);
    for (let i = 1; i < v.length; i++) g[i] = v[i] - v[i - 1];
    const locate = (sign) => {
      let best = -1, bv = 0.2;
      for (let i = 1; i < v.length; i++) if (sign * g[i] > bv) { bv = sign * g[i]; best = i; }
      if (best < 0) return null;
      let m = 0, mi = 0;
      for (let i = Math.max(1, best - 1); i <= Math.min(v.length - 1, best + 1); i++) { const q = Math.max(0, sign * g[i]); m += q; mi += q * i; }
      return mi / m;
    };
    const lo = locate(1), hi = locate(-1);
    return lo !== null && hi !== null && hi > lo ? { start: lo, end: hi } : null;
  };
  const sx = span(mid), sy = span(midC);
  return sx && sy ? { left: sx.start, right: sx.end, top: sy.start, bottom: sy.end } : null;
}

export function shapeGeometry(img, box, dpr = 1) {
  const cm = coverageMap(img, box);
  const e = edgesOf(cm);
  if (!e) return null;
  // Only count coverage inside the detected edges (+1px), so a soft shadow does not pull the centroid.
  let area = 0, sx = 0, sy = 0, ring = 0, ringN = 0;
  for (let y = 0; y < cm.h; y++) for (let x = 0; x < cm.w; x++) {
    const c = cm.cov[y * cm.w + x];
    const inside = x + 1 > e.left - 1 && x < e.right + 1 && y + 1 > e.top - 1 && y < e.bottom + 1;
    if (inside) { area += c; sx += c * (x + 0.5); sy += c * (y + 0.5); }
    else if (x + 1 > e.left - 4 && x < e.right + 4 && y + 1 > e.top - 4 && y < e.bottom + 4) { ring += c; ringN++; }
  }
  return {
    cm, edges: e, areaPx: area, centroid: { x: sx / area, y: sy / area }, width: e.right - e.left, height: e.bottom - e.top, dpr, box,
    // A shadow or glow near the edge biases coverage-based metrics (centroid, corner radii); flag it.
    shadowContamination: ringN ? ring / ringN > 0.05 : false,
  };
}

// Missing coverage inside a corner square, weighting border pixels by their overlap with the square.
function cornerMissing(cm, e, corner, s) {
  const { w, h, cov } = cm;
  const x0 = corner.includes('l') ? e.left : e.right - s, y0 = corner.includes('t') ? e.top : e.bottom - s;
  let miss = 0;
  for (let y = Math.floor(y0); y < Math.ceil(y0 + s); y++) for (let x = Math.floor(x0); x < Math.ceil(x0 + s); x++) {
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const wx = Math.min(x + 1, x0 + s) - Math.max(x, x0), wy = Math.min(y + 1, y0 + s) - Math.max(y, y0);
    if (wx > 0 && wy > 0) miss += wx * wy * (1 - cov[y * w + x]);
  }
  return miss;
}

/**
 * Circular-corner model: missing area in a corner = r^2 (1 - pi/4). The spec measured systematic bias
 * for naive fits, so the result carries a calibrated-uncertainty floor rather than claiming precision.
 */
export function fitCornerRadii(geo) {
  const { cm, edges: e, dpr } = geo;
  const s = Math.floor(Math.min(e.right - e.left, e.bottom - e.top) / 2);
  const k = 1 - Math.PI / 4;
  const out = {};
  for (const c of ['tl', 'tr', 'br', 'bl']) out[c] = Math.sqrt(Math.max(0, cornerMissing(cm, e, c, s)) / k) / dpr;
  return { radiiCssPx: out, meanCssPx: (out.tl + out.tr + out.br + out.bl) / 4, uncertaintyCssPx: 0.5, method: 'circular-corner missing-area fit' };
}

// Exact squared Euclidean distance transform (Felzenszwalb & Huttenlocher), distance to nearest `on` pixel.
function edt(on, w, h) {
  const INF = 1e12, f = new Float64Array(Math.max(w, h)), d = new Float64Array(Math.max(w, h)), v = new Int32Array(Math.max(w, h)), z = new Float64Array(Math.max(w, h) + 1);
  const grid = new Float64Array(w * h);
  for (let i = 0; i < grid.length; i++) grid[i] = on[i] ? 0 : INF;
  const pass = (n, get, set) => {
    for (let i = 0; i < n; i++) f[i] = get(i);
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s;
      while (true) { s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); if (s <= z[k] && k > 0) k--; else break; }
      if (s <= z[k]) { v[0] = q; z[0] = -INF; z[1] = INF; k = 0; } else { k++; v[k] = q; z[k] = s; z[k + 1] = INF; }
    }
    k = 0;
    for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) ** 2 + f[v[k]]; }
    for (let i = 0; i < n; i++) set(i, d[i]);
  };
  for (let x = 0; x < w; x++) pass(h, (y) => grid[y * w + x], (y, val) => { grid[y * w + x] = val; });
  for (let y = 0; y < h; y++) pass(w, (x) => grid[y * w + x], (x, val) => { grid[y * w + x] = val; });
  return grid.map(Math.sqrt);
}

function contour(inside, w, h) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!inside[y * w + x]) continue;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !inside[y * w + x - 1] || !inside[y * w + x + 1] || !inside[(y - 1) * w + x] || !inside[(y + 1) * w + x]) out[y * w + x] = 1;
  }
  return out;
}

const percentile = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

/** Robust symmetric edge distance (Chamfer mean and HD95) plus signed offset of candidate contour vs reference. */
export function edgeDistances(refGeo, candGeo) {
  const { w, h } = refGeo.cm;
  if (candGeo.cm.w !== w || candGeo.cm.h !== h) throw new Error('regions must have equal size');
  const inR = Uint8Array.from(refGeo.cm.cov, (c) => (c > 0.5 ? 1 : 0)), inC = Uint8Array.from(candGeo.cm.cov, (c) => (c > 0.5 ? 1 : 0));
  const cR = contour(inR, w, h), cC = contour(inC, w, h);
  const dToR = edt(cR, w, h), dToC = edt(cC, w, h);
  const dpr = refGeo.dpr;
  const a = [], b = [], signed = [];
  for (let i = 0; i < w * h; i++) {
    if (cC[i]) { a.push(dToR[i]); signed.push(inR[i] ? -dToR[i] : dToR[i]); } // + = candidate contour lies outside reference shape
    if (cR[i]) b.push(dToC[i]);
  }
  const mean = (v) => (v.length ? v.reduce((p, q) => p + q, 0) / v.length : 0);
  return {
    chamferMeanCssPx: (mean(a) + mean(b)) / 2 / dpr,
    hd95CssPx: Math.max(percentile(a, 0.95), percentile(b, 0.95)) / dpr,
    signedOffsetMeanCssPx: mean(signed) / dpr,
    signedOffsetMedianCssPx: percentile(signed, 0.5) / dpr,
    method: 'exact EDT on 0.5-coverage contours', scale: dpr,
  };
}

/** Border band thickness (CSS px) and colour per side, scanning inward from the shape edge. */
export function borderBands(img, geo, { tolDeltaE = 3 } = {}) {
  const { box, edges: e, dpr } = geo;
  const px = (x, y) => labAt(img, box.x0 + Math.floor(x), box.y0 + Math.floor(y));
  const cx = (e.left + e.right) / 2, cy = (e.top + e.bottom) / 2;
  const sides = {
    left: { start: [e.left + 0.5, cy], step: [1, 0] }, right: { start: [e.right - 0.5, cy], step: [-1, 0] },
    top: { start: [cx, e.top + 0.5], step: [0, 1] }, bottom: { start: [cx, e.bottom - 0.5], step: [0, -1] },
  };
  const maxScan = Math.floor(Math.min(e.right - e.left, e.bottom - e.top) / 2) - 1;
  const out = {};
  for (const [name, { start, step }] of Object.entries(sides)) {
    const interior = px(cx, cy), first = px(...start);
    let n = 0, sum = [0, 0, 0];
    for (let i = 0; i < maxScan; i++) {
      const c = px(start[0] + step[0] * i, start[1] + step[1] * i);
      if (deltaE76(c, interior) <= tolDeltaE) break;
      n++; sum = [sum[0] + c[0], sum[1] + c[1], sum[2] + c[2]];
    }
    out[name] = n ? { widthCssPx: n / dpr, colorLab: sum.map((v) => v / n) } : { widthCssPx: 0, colorLab: first };
  }
  return out;
}

/** Dominant gradient direction (deg, mod 180) and a 32-bin Lab profile along it, over the eroded interior. */
export function gradientProfile(img, geo, { erodePx = 4, bins = 32 } = {}) {
  const { box, edges: e } = geo;
  const x0 = Math.ceil(e.left + erodePx), x1 = Math.floor(e.right - erodePx), y0 = Math.ceil(e.top + erodePx), y1 = Math.floor(e.bottom - erodePx);
  if (x1 - x0 < 4 || y1 - y0 < 4) return null;
  let jxx = 0, jxy = 0, jyy = 0;
  for (let y = y0 + 1; y < y1; y++) for (let x = x0 + 1; x < x1; x++) {
    const gx = sub(labAt(img, box.x0 + x + 1, box.y0 + y), labAt(img, box.x0 + x - 1, box.y0 + y));
    const gy = sub(labAt(img, box.x0 + x, box.y0 + y + 1), labAt(img, box.x0 + x, box.y0 + y - 1));
    jxx += dot(gx, gx); jxy += dot(gx, gy); jyy += dot(gy, gy);
  }
  if (jxx + jyy < 1e-6) return { angleDeg: null, flat: true, profile: [labAt(img, box.x0 + x0, box.y0 + y0)] };
  const theta = 0.5 * Math.atan2(2 * jxy, jxx - jyy), dx = Math.cos(theta), dy = Math.sin(theta);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const acc = Array.from({ length: bins }, () => [0, 0, 0, 0]);
  let tmin = Infinity, tmax = -Infinity;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const t = (x - cx) * dx + (y - cy) * dy; tmin = Math.min(tmin, t); tmax = Math.max(tmax, t); }
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const t = (x - cx) * dx + (y - cy) * dy, k = Math.min(bins - 1, Math.floor(((t - tmin) / (tmax - tmin || 1)) * bins));
    const c = labAt(img, box.x0 + x, box.y0 + y); acc[k][0] += c[0]; acc[k][1] += c[1]; acc[k][2] += c[2]; acc[k][3]++;
  }
  let profile = acc.map((a) => (a[3] ? [a[0] / a[3], a[1] / a[3], a[2] / a[3]] : null)).filter(Boolean);
  let deg = (theta * 180 / Math.PI + 360) % 180;
  // Orient so lightness (then a*) increases along the profile; direction is defined modulo 180 deg.
  const first = profile[0], last = profile[profile.length - 1];
  if (last[0] < first[0] - 1e-6 || (Math.abs(last[0] - first[0]) <= 1e-6 && last[1] < first[1])) profile = profile.reverse();
  return { angleDeg: deg, flat: false, profile, startLab: profile[0], endLab: profile[profile.length - 1] };
}

export function compareGradients(a, b) {
  if (!a || !b) return null;
  const resample = (p, n) => Array.from({ length: n }, (_, i) => p[Math.min(p.length - 1, Math.round((i / (n - 1)) * (p.length - 1)))]);
  const pa = resample(a.profile, 32), pb = resample(b.profile, 32);
  const d = pa.map((c, i) => deltaE76(c, pb[i]));
  let dAngle = a.flat || b.flat ? null : ((b.angleDeg - a.angleDeg + 270) % 180) - 90;
  return {
    angleDeltaDeg: dAngle,
    startDeltaE76: deltaE76(pa[0], pb[0]), endDeltaE76: deltaE76(pa[31], pb[31]),
    meanProfileDeltaE76: d.reduce((p, q) => p + q, 0) / d.length, maxProfileDeltaE76: Math.max(...d),
    method: 'structure-tensor direction + 32-bin Lab profile',
  };
}

/**
 * Darkness (delta-E from background) versus distance outside the silhouette, plus per-side extents.
 * The shadow's visible-mass centroid is biased by the part hidden under the shape, so the offset is
 * taken from the left/right and top/bottom extent asymmetry instead.
 */
export function shadowProfile(img, geo, { maxDistPx = 40 } = {}) {
  const { cm, dpr, edges: e } = geo;
  const { w, h } = cm;
  const inside = Uint8Array.from(cm.cov, (c) => (c > 0.5 ? 1 : 0));
  const dist = edt(inside, w, h); // distance of outside pixels to the nearest inside pixel
  const sum = new Float64Array(maxDistPx + 1), cnt = new Float64Array(maxDistPx + 1);
  const darkness = (x, y) => deltaE76(labAt(img, geo.box.x0 + x, geo.box.y0 + y), cm.bg);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (inside[y * w + x]) continue;
    const d = Math.round(dist[y * w + x]);
    if (d > maxDistPx || d < 2) continue; // d<2 is the antialiased silhouette fringe
    sum[d] += darkness(x, y); cnt[d]++;
  }
  const profile = Array.from(sum, (v, d) => (cnt[d] ? v / cnt[d] : 0));
  const peak = Math.max(...profile);
  let extent = 0; profile.forEach((v, d) => { if (v >= 0.05 * peak && peak > 0.5) extent = d; });

  // Extent along each side, averaged over the middle half of that edge.
  const side = (axis, dir) => {
    const lo = axis === 'x' ? e.top : e.left, hi = axis === 'x' ? e.bottom : e.right;
    const a0 = Math.floor(lo + (hi - lo) * 0.25), a1 = Math.ceil(hi - (hi - lo) * 0.25);
    const start = Math.round(axis === 'x' ? (dir > 0 ? e.right : e.left) : (dir > 0 ? e.bottom : e.top));
    let last = 0;
    for (let k = 2; k <= maxDistPx; k++) {
      let acc = 0, c = 0;
      for (let t = a0; t < a1; t++) {
        const x = axis === 'x' ? start + dir * k - (dir < 0 ? 1 : 0) : t, y = axis === 'x' ? t : start + dir * k - (dir < 0 ? 1 : 0);
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        acc += darkness(x, y); c++;
      }
      if (c && acc / c >= 0.05 * peak && peak > 0.5) last = k;
    }
    return last / dpr;
  };
  const sides = { left: side('x', -1), right: side('x', 1), top: side('y', -1), bottom: side('y', 1) };
  return { profile, peakDeltaE76: peak, extentCssPx: extent / dpr, sidesCssPx: sides, offsetCssPx: { x: (sides.right - sides.left) / 2, y: (sides.bottom - sides.top) / 2 } };
}

export function compareShadows(a, b) {
  const n = Math.min(a.profile.length, b.profile.length);
  let se = 0; for (let i = 0; i < n; i++) se += (a.profile[i] - b.profile[i]) ** 2;
  return {
    peakDeltaE76Diff: b.peakDeltaE76 - a.peakDeltaE76,
    extentDiffCssPx: b.extentCssPx - a.extentCssPx,
    offsetDiffCssPx: { dx: b.offsetCssPx.x - a.offsetCssPx.x, dy: b.offsetCssPx.y - a.offsetCssPx.y },
    profileRmse: Math.sqrt(se / n), method: 'delta-E falloff by distance + per-side extent asymmetry',
  };
}

/** One call: every Stage 3 metric for a matched region, as signed candidate - reference observations. */
export function compareFeatures(refImg, candImg, box, { dpr = 2, checks = ['geometry', 'corners', 'edges', 'color', 'border', 'gradient', 'shadow'] } = {}) {
  const rg = shapeGeometry(refImg, box, dpr), cg = shapeGeometry(candImg, box, dpr);
  if (!rg || !cg) return { status: rg || cg ? 'missing_in_one_side' : 'no_shape', reference: !!rg, candidate: !!cg };
  const out = { status: 'ok', signConvention: 'candidate_minus_reference', scale: dpr, shadowContamination: { reference: rg.shadowContamination, candidate: cg.shadowContamination } };
  if (checks.includes('geometry')) {
    out.geometry = {
      dxCssPx: (cg.centroid.x - rg.centroid.x) / dpr, dyCssPx: (cg.centroid.y - rg.centroid.y) / dpr,
      dwCssPx: (cg.width - rg.width) / dpr, dhCssPx: (cg.height - rg.height) / dpr,
      edgesDeltaCssPx: { left: (cg.edges.left - rg.edges.left) / dpr, right: (cg.edges.right - rg.edges.right) / dpr, top: (cg.edges.top - rg.edges.top) / dpr, bottom: (cg.edges.bottom - rg.edges.bottom) / dpr },
      method: 'coverage-weighted centroid + mid-line edge positions',
    };
  }
  if (checks.includes('corners')) {
    const a = fitCornerRadii(rg), b = fitCornerRadii(cg);
    out.corners = { reference: a.radiiCssPx, candidate: b.radiiCssPx, deltaMeanCssPx: b.meanCssPx - a.meanCssPx, uncertaintyCssPx: a.uncertaintyCssPx, method: a.method };
  }
  if (checks.includes('edges')) out.edges = edgeDistances(rg, cg);
  if (checks.includes('color')) {
    out.color = { fillDeltaE76: deltaE76(rg.cm.fill, cg.cm.fill), referenceLab: rg.cm.fill, candidateLab: cg.cm.fill, method: 'projection-derived fill colour (>=95% of extreme distance), Lab D65' };
  }
  if (checks.includes('border')) {
    const a = borderBands(refImg, rg), b = borderBands(candImg, cg);
    out.border = Object.fromEntries(Object.keys(a).map((s) => [s, { widthDeltaCssPx: b[s].widthCssPx - a[s].widthCssPx, colorDeltaE76: deltaE76(a[s].colorLab, b[s].colorLab), referenceWidthCssPx: a[s].widthCssPx }]));
  }
  if (checks.includes('gradient')) out.gradient = compareGradients(gradientProfile(refImg, rg), gradientProfile(candImg, cg));
  if (checks.includes('shadow')) out.shadow = compareShadows(shadowProfile(refImg, rg), shadowProfile(candImg, cg));
  return out;
}
