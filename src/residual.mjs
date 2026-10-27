// Stage 1: localized residuals. Reference/candidate PNGs in, ranked numeric findings out.
// Sign convention everywhere: candidate - reference. Coordinates are CSS px unless named "Physical".
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { pngSize } from './render.mjs';

// sRGB -> CIELAB (D65). ΔE76 is Euclidean distance in this space.
const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
export function rgbToLab(r, g, b) {
  const R = lin(r), G = lin(g), B = lin(b);
  const x = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  const y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
  const z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}
export const deltaE76 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const labOf = (img, i) => rgbToLab(img.data[i], img.data[i + 1], img.data[i + 2]);

function dominantColor(img) {
  const counts = new Map();
  for (let i = 0; i < img.data.length; i += 4) {
    const k = (img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2];
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let best = 0, bestN = -1;
  for (const [k, n] of counts) if (n > bestN) { best = k; bestN = n; }
  return [(best >> 16) & 255, (best >> 8) & 255, best & 255];
}

// Per-pixel ΔE76 map between the two images.
function deltaEMap(a, b) {
  const out = new Float32Array(a.width * a.height);
  for (let p = 0, i = 0; p < out.length; p++, i += 4) out[p] = deltaE76(labOf(a, i), labOf(b, i));
  return out;
}

function components(mask, w, h) {
  const label = new Int32Array(w * h).fill(-1);
  const comps = [];
  const stack = [];
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || label[s] !== -1) continue;
    const id = comps.length;
    const c = { id, minX: w, minY: h, maxX: -1, maxY: -1, area: 0, pixels: [] };
    stack.push(s); label[s] = id;
    while (stack.length) {
      const p = stack.pop();
      const x = p % w, y = (p / w) | 0;
      c.area++; c.pixels.push(p);
      if (x < c.minX) c.minX = x; if (x > c.maxX) c.maxX = x;
      if (y < c.minY) c.minY = y; if (y > c.maxY) c.maxY = y;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx;
        if (mask[q] && label[q] === -1) { label[q] = id; stack.push(q); }
      }
    }
    comps.push(c);
  }
  return { comps, label };
}

// Ink = pixels differing from the image's own background. Objects are connected components of the
// union of both images' ink, so both lobes of a shifted shape belong to one object.
function inkMask(img, bg, inkDE) {
  const mask = new Uint8Array(img.width * img.height);
  for (let p = 0, i = 0; p < mask.length; p++, i += 4) mask[p] = deltaE76(labOf(img, i), bg) >= inkDE ? 1 : 0;
  return mask;
}

// Centroid (physical px) of one image's own ink inside the given union objects.
function inkStats(comps, ids, mask, w) {
  let sx = 0, sy = 0, n = 0;
  for (const id of ids) for (const p of comps[id].pixels) {
    if (!mask[p]) continue;
    sx += (p % w) + 0.5; sy += ((p / w) | 0) + 0.5; n++;
  }
  return n ? { x: sx / n, y: sy / n, n } : null;
}

// Mean Lab of the box after eroding `erode` px from each side, so antialiased edges do not bias it.
export function interiorColor(img, box, erode = 2) {
  const x0 = box.x0 + erode, y0 = box.y0 + erode, x1 = box.x1 - erode, y1 = box.y1 - erode;
  if (x1 < x0 || y1 < y0) return null;
  let L = 0, A = 0, B = 0, n = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const lab = labOf(img, (y * img.width + x) * 4);
    L += lab[0]; A += lab[1]; B += lab[2]; n++;
  }
  return { lab: [L / n, A / n, B / n], samples: n };
}

function crop(img, box) {
  const w = box.x1 - box.x0 + 1, h = box.y1 - box.y0 + 1;
  const out = new PNG({ width: w, height: h });
  PNG.bitblt(img, out, box.x0, box.y0, w, h, 0, 0);
  return PNG.sync.write(out);
}

/**
 * @param {Buffer} refPng
 * @param {Buffer} candPng
 * @param {object} o
 * @param {number} [o.dpr=1]            device pixel ratio the PNGs were captured at
 * @param {number} [o.tileCssPx=64]
 * @param {number} [o.noiseDE=1]        ΔE76 above which a pixel counts as mismatching
 * @param {number} [o.maxClusters=20]
 * @param {string} [o.evidenceDir]      when set, writes ref/cand/diff crops for the top clusters
 */
export function compareResiduals(refPng, candPng, o = {}) {
  const { dpr = 1, tileCssPx = 64, noiseDE = 1, maxClusters = 20, evidenceDir } = o;
  const rs = pngSize(refPng), cs = pngSize(candPng);
  if (rs.width !== cs.width || rs.height !== cs.height) {
    const err = new Error(`screenshot dimensions differ: ${rs.width}x${rs.height} vs ${cs.width}x${cs.height}`);
    err.code = 'CVC_DIMENSION_MISMATCH';
    throw err;
  }
  const ref = PNG.sync.read(refPng), cand = PNG.sync.read(candPng);
  const { width: w, height: h } = ref;

  const de = deltaEMap(ref, cand);
  const mask = new Uint8Array(w * h);
  for (let p = 0; p < mask.length; p++) mask[p] = de[p] > noiseDE ? 1 : 0;

  // Foreground = pixels that differ from each image's own background in at least one image.
  const bgRef = rgbToLab(...dominantColor(ref)), bgCand = rgbToLab(...dominantColor(cand));
  let foreground = 0, foregroundMismatch = 0, mismatch = 0;
  for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
    const fg = deltaE76(labOf(ref, i), bgRef) >= noiseDE || deltaE76(labOf(cand, i), bgCand) >= noiseDE;
    if (fg) { foreground++; if (mask[p]) foregroundMismatch++; }
    if (mask[p]) mismatch++;
  }

  // Tiles
  const tile = Math.max(1, Math.round(tileCssPx * dpr));
  const tx = Math.ceil(w / tile), ty = Math.ceil(h / tile);
  const tiles = [];
  for (let j = 0; j < ty; j++) for (let i = 0; i < tx; i++) {
    let n = 0, sum = 0, area = 0;
    for (let y = j * tile; y < Math.min(h, (j + 1) * tile); y++) for (let x = i * tile; x < Math.min(w, (i + 1) * tile); x++) {
      area++;
      const p = y * w + x;
      if (mask[p]) { n++; sum += de[p]; }
    }
    if (n) tiles.push({ col: i, row: j, xCssPx: (i * tile) / dpr, yCssPx: (j * tile) / dpr, mismatchRatio: n / area, meanDeltaE76: sum / n });
  }
  tiles.sort((a, b) => b.mismatchRatio - a.mismatchRatio);

  // Mismatch clusters from a 1px-dilated mask (keeps antialiasing speckle together), then merged
  // whenever they touch the same ink object in either image.
  const dil = new Uint8Array(mask);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!mask[y * w + x]) continue;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h) dil[ny * w + nx] = 1;
    }
  }
  const diffComps = components(dil, w, h).comps;
  const inkRef = inkMask(ref, bgRef, noiseDE), inkCand = inkMask(cand, bgCand, noiseDE);
  const inkUnion = new Uint8Array(w * h);
  for (let p = 0; p < inkUnion.length; p++) inkUnion[p] = inkRef[p] | inkCand[p];
  const objects = components(inkUnion, w, h);

  // Merge diff clusters that touch the same ink object.
  const parent = diffComps.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const owner = new Map();
  const touched = diffComps.map((c) => {
    const ids = new Set();
    for (const p of c.pixels) if (mask[p] && objects.label[p] !== -1) ids.add(objects.label[p]);
    return ids;
  });
  touched.forEach((ids, i) => {
    for (const id of ids) {
      if (owner.has(id)) parent[find(i)] = find(owner.get(id)); else owner.set(id, i);
    }
  });
  const groups = new Map();
  diffComps.forEach((c, i) => {
    const g = find(i);
    if (!groups.has(g)) groups.set(g, { comps: [], objs: new Set() });
    const grp = groups.get(g);
    grp.comps.push(c); touched[i].forEach((v) => grp.objs.add(v));
  });

  const merged = [...groups.values()].map((g) => {
    let minX = w, minY = h, maxX = -1, maxY = -1, n = 0, sum = 0;
    for (const c of g.comps) for (const p of c.pixels) {
      if (!mask[p]) continue;
      const x = p % w, y = (p / w) | 0;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      n++; sum += de[p];
    }
    return { ...g, minX, minY, maxX, maxY, mismatchPixels: n, meanDE: n ? sum / n : 0 };
  }).sort((a, b) => b.mismatchPixels * b.meanDE - a.mismatchPixels * a.meanDE).slice(0, maxClusters);

  const clusters = merged.map((c, idx) => {
    const sr = inkStats(objects.comps, c.objs, inkRef, w), sc = inkStats(objects.comps, c.objs, inkCand, w);
    let kind = 'mismatch';
    if (!sr && sc) kind = 'extra'; else if (sr && !sc) kind = 'missing';
    const out = {
      id: `r-${String(idx + 1).padStart(3, '0')}`,
      kind,
      bboxCssPx: { x: c.minX / dpr, y: c.minY / dpr, width: (c.maxX - c.minX + 1) / dpr, height: (c.maxY - c.minY + 1) / dpr },
      mismatchPixelsPhysical: c.mismatchPixels,
      meanDeltaE76: c.meanDE,
      inkCentroidShiftCssPx: sr && sc ? { dx: (sc.x - sr.x) / dpr, dy: (sc.y - sr.y) / dpr } : null,
      inkAreaDeltaCssPx2: sr && sc ? (sc.n - sr.n) / (dpr * dpr) : null,
      interiorColor: null,
      attribution: 'unattributed', // Stage 1 measures only; component matching arrives in Stage 2.
    };
    const box = { x0: c.minX, y0: c.minY, x1: c.maxX, y1: c.maxY };
    const ir = interiorColor(ref, box), ic = interiorColor(cand, box);
    if (ir && ic) out.interiorColor = { deltaE76: deltaE76(ir.lab, ic.lab), samples: Math.min(ir.samples, ic.samples), method: 'eroded-box mean Lab D65' };
    if (evidenceDir) {
      const pad = Math.round(8 * dpr);
      const eb = { x0: Math.max(0, c.minX - pad), y0: Math.max(0, c.minY - pad), x1: Math.min(w - 1, c.maxX + pad), y1: Math.min(h - 1, c.maxY + pad) };
      mkdirSync(evidenceDir, { recursive: true });
      const diff = new PNG({ width: w, height: h });
      pixelmatch(ref.data, cand.data, diff.data, w, h, { threshold: 0.1 });
      out.evidence = {};
      for (const [name, img] of [['reference', ref], ['candidate', cand], ['diff', diff]]) {
        const file = join(evidenceDir, `${out.id}-${name}.png`);
        writeFileSync(file, crop(img, eb));
        out.evidence[name] = file;
      }
    }
    return out;
  });

  return {
    schema: 'cvc-residual-report/v0.1',
    signConvention: 'candidate_minus_reference',
    dpr,
    noiseDeltaE76: noiseDE,
    physical: { width: w, height: h },
    identical: mismatch === 0,
    globalMismatchRatio: mismatch / (w * h),
    foregroundPixels: foreground,
    foregroundDisagreementRatio: foreground ? foregroundMismatch / foreground : 0,
    tileCssPx,
    tiles: tiles.slice(0, 50),
    clusters,
  };
}
