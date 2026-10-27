// Stage 4: outlined-text comparison. Text is compared as visual lines (geometry and ink), never as
// recovered strings. Word-level claims need a caller-supplied source string with high confidence.
import { deltaE76, rgbToLab } from './residual.mjs';

const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

/**
 * Group glyph-like drawables into probable text lines/runs.
 * items: [{id, bbox:{x,y,width,height}}] in CSS px. Pure geometry; never claims what the text says.
 */
export function clusterGlyphRuns(items, { minH = 4, maxH = 80, maxAspect = 2.5, minGlyphs = 3 } = {}) {
  const glyphLike = items.filter((i) => i.bbox.height >= minH && i.bbox.height <= maxH && i.bbox.width / i.bbox.height <= maxAspect);
  const rejected = items.filter((i) => !glyphLike.includes(i)).map((i) => i.id);
  const centerY = (i) => i.bbox.y + i.bbox.height / 2;
  const bottom = (i) => i.bbox.y + i.bbox.height;

  // Lines: sweep by vertical centre; an item joins a line when its centre lies within the line's median height band.
  const sorted = [...glyphLike].sort((a, b) => centerY(a) - centerY(b));
  const lines = [];
  for (const it of sorted) {
    const line = lines.find((l) => Math.abs(centerY(it) - l.cy) <= 0.6 * l.h);
    if (line) { line.items.push(it); line.cy = median(line.items.map(centerY)); line.h = median(line.items.map((i) => i.bbox.height)); }
    else lines.push({ items: [it], cy: centerY(it), h: it.bbox.height });
  }

  // Runs: split each line where the horizontal gap is far larger than the typical inter-glyph gap.
  const runs = [];
  for (const l of lines) {
    const xs = [...l.items].sort((a, b) => a.bbox.x - b.bbox.x);
    const gaps = xs.slice(1).map((it, k) => it.bbox.x - (xs[k].bbox.x + xs[k].bbox.width));
    const typical = Math.max(1, median(gaps.filter((g) => g >= 0)));
    const wordGap = Math.max(1.2 * l.h, 4 * typical);
    let cur = [xs[0]];
    const flush = () => { if (cur.length) runs.push(cur); cur = []; };
    xs.slice(1).forEach((it, k) => { if (gaps[k] > wordGap) flush(); cur.push(it); });
    flush();
  }

  const out = runs.map((r, idx) => {
    const x0 = Math.min(...r.map((i) => i.bbox.x)), x1 = Math.max(...r.map((i) => i.bbox.x + i.bbox.width));
    const y0 = Math.min(...r.map((i) => i.bbox.y)), y1 = Math.max(...r.map(bottom));
    const heights = r.map((i) => i.bbox.height);
    const h = median(heights);
    const consistent = heights.filter((v) => Math.abs(v - h) <= 0.5 * h).length / heights.length;
    const kind = r.length >= minGlyphs ? 'text-run' : 'icon-or-fragment';
    return {
      id: `t-${String(idx + 1).padStart(3, '0')}`, kind,
      glyphIds: r.map((i) => i.id), glyphCount: r.length,
      bboxCssPx: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
      medianGlyphHeightCssPx: h,
      // Most glyph bottoms share a baseline; descenders are the minority.
      baselineCssPx: median(r.map(bottom)),
      confidence: kind === 'text-run' ? Math.min(0.95, 0.4 + 0.1 * Math.min(r.length, 5) + 0.15 * consistent) : 0.2,
      note: 'geometry-only; icons can resemble glyphs and a glyph can be several disconnected shapes',
    };
  });
  return { runs: out, rejected };
}

// Background = median of the box border ring, as in features.mjs.
function inkMask(img, box, tol) {
  const w = box.x1 - box.x0 + 1, h = box.y1 - box.y0 + 1;
  const ring = [[], [], []];
  const add = (x, y) => { const i = ((box.y0 + y) * img.width + box.x0 + x) * 4; const c = rgbToLab(img.data[i], img.data[i + 1], img.data[i + 2]); for (let k = 0; k < 3; k++) ring[k].push(c[k]); };
  for (let x = 0; x < w; x++) { add(x, 0); add(x, h - 1); }
  for (let y = 1; y < h - 1; y++) { add(0, y); add(w - 1, y); }
  const bg = ring.map(median);
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = ((box.y0 + y) * img.width + box.x0 + x) * 4;
    mask[y * w + x] = deltaE76(rgbToLab(img.data[i], img.data[i + 1], img.data[i + 2]), bg) > tol ? 1 : 0;
  }
  return { mask, w, h };
}

/** Visual text lines inside a box: blank-row separated bands with extents, ink and baseline (physical px, box-relative). */
export function inkLines(img, box, { tol = 12, minInkPx = 4 } = {}) {
  const { mask, w, h } = inkMask(img, box, tol);
  const rows = new Float64Array(h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rows[y] += mask[y * w + x];
  const bands = [];
  let start = -1;
  for (let y = 0; y <= h; y++) {
    const on = y < h && rows[y] > 0;
    if (on && start < 0) start = y;
    if (!on && start >= 0) { bands.push([start, y - 1]); start = -1; }
  }
  // Rejoin small detached marks (i/j dots, accents) with the band they belong to.
  const merged = [];
  for (const b of bands) {
    const prev = merged[merged.length - 1];
    if (prev) {
      const gap = b[0] - prev[1] - 1, hp = prev[1] - prev[0] + 1, hb = b[1] - b[0] + 1;
      const big = Math.max(hp, hb), small = Math.min(hp, hb);
      if (small <= 0.4 * big && gap <= 0.25 * big) { prev[1] = b[1]; continue; }
    }
    merged.push([...b]);
  }
  const lines = [];
  for (const [y0, y1] of merged) {
    let ink = 0, x0 = w, x1 = -1, peak = 0;
    for (let y = y0; y <= y1; y++) peak = Math.max(peak, rows[y]);
    for (let y = y0; y <= y1; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { ink++; if (x < x0) x0 = x; if (x > x1) x1 = x; }
    if (ink < minInkPx) continue;
    let baseline = y1;
    for (let y = y1; y >= y0; y--) if (rows[y] >= 0.35 * peak) { baseline = y + 1; break; } // rows below are descenders
    lines.push({ top: y0, bottom: y1 + 1, left: x0, right: x1 + 1, baseline, inkPx: ink });
  }
  return lines;
}

/** Best integer-pixel alignment of two ink masks inside a box; returns IoU at that shift. cand displaced by (dx,dy) from ref. */
export function silhouetteIoU(refImg, candImg, box, { tol = 12, maxShift = 6 } = {}) {
  const a = inkMask(refImg, box, tol), b = inkMask(candImg, box, tol);
  const { w, h } = a;
  let best = { iou: -1, dx: 0, dy: 0 };
  const count = (m) => m.reduce((p, q) => p + q, 0);
  const ca = count(a.mask), cb = count(b.mask);
  for (let sy = -maxShift; sy <= maxShift; sy++) for (let sx = -maxShift; sx <= maxShift; sx++) {
    let inter = 0;
    for (let y = Math.max(0, -sy); y < Math.min(h, h - sy); y++) for (let x = Math.max(0, -sx); x < Math.min(w, w - sx); x++) {
      if (a.mask[y * w + x] && b.mask[(y + sy) * w + x + sx]) inter++;
    }
    const iou = ca + cb - inter ? inter / (ca + cb - inter) : 1;
    if (iou > best.iou) best = { iou, dx: sx, dy: sy };
  }
  return { ...best, refInkPx: ca, candInkPx: cb };
}

/** In-page: rendered line boxes of every text node matching `selector`, from Range.getClientRects (CSS px, unrounded). */
export async function measureHtmlLines(page, selector) {
  return page.evaluate((sel) => {
    const out = [];
    for (const root of document.querySelectorAll(sel)) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = n.textContent;
        if (!text.trim()) continue;
        const lines = [];
        const re = /\S+/g;
        for (let m = re.exec(text); m; m = re.exec(text)) {
          const r = document.createRange();
          r.setStart(n, m.index); r.setEnd(n, m.index + m[0].length);
          for (const rect of r.getClientRects()) {
            const cur = lines[lines.length - 1];
            if (cur && Math.abs(rect.top - cur.y) < rect.height * 0.5) { cur.width = rect.right - cur.x; cur.words++; }
            else lines.push({ x: rect.left, y: rect.top, width: rect.width, height: rect.height, words: 1 });
          }
        }
        out.push({ selector: sel, text, lines });
      }
    }
    return out;
  }, selector);
}

/**
 * Compare a reference text region with a candidate one, line by line, at `dpr` (use 2).
 * Everything is reported as visual geometry. A word-level wrap claim is made only when the caller
 * supplies `sourceText` with `sourceTextConfidence >= 0.9`.
 */
export function compareTextRegion(refImg, candImg, box, { dpr = 2, sourceText = null, sourceTextConfidence = 0, tol = 12 } = {}) {
  const rl = inkLines(refImg, box, { tol }), cl = inkLines(candImg, box, { tol });
  const lines = [];
  for (let i = 0; i < Math.min(rl.length, cl.length); i++) {
    const r = rl[i], c = cl[i];
    lines.push({
      index: i,
      startDxCssPx: (c.left - r.left) / dpr, endDxCssPx: (c.right - r.right) / dpr,
      widthDeltaCssPx: (c.right - c.left - (r.right - r.left)) / dpr,
      baselineDyCssPx: (c.baseline - r.baseline) / dpr,
      inkAreaRatio: r.inkPx ? c.inkPx / r.inkPx : null,
    });
  }
  const sil = silhouetteIoU(refImg, candImg, box, { tol });
  const lineCountDelta = cl.length - rl.length;
  const wrapSuspected = lineCountDelta !== 0 || lines.some((l) => Math.abs(l.endDxCssPx) > 6 && Math.abs(l.startDxCssPx) < 2);
  const finding = {
    schema: 'cvc-text-region/v0.1', signConvention: 'candidate_minus_reference', scale: dpr,
    referenceLineCount: rl.length, candidateLineCount: cl.length, lineCountDelta,
    lines, registeredSilhouette: { iou: sil.iou, candidateShiftCssPx: { dx: sil.dx / dpr, dy: sil.dy / dpr }, searchedPx: 6 },
    wrapSuspected, wordLevelClaim: null,
    method: 'ink-band line extraction + registered silhouette IoU',
  };
  if (wrapSuspected) {
    if (sourceText && sourceTextConfidence >= 0.9) finding.wordLevelClaim = { text: sourceText, confidence: sourceTextConfidence, claim: 'line break falls at a different word than the reference' };
    else finding.note = 'Visual line geometry only: the source string is not independently supported, so no word-level wrap explanation is made.';
  }
  return finding;
}

/** In-page: screen-space boxes of visible drawable shapes (not defs/clips/masks), as clustering input. */
export async function svgGlyphCandidates(page) {
  return page.evaluate(() => {
    const NON = 'defs,clipPath,mask,marker,pattern,symbol,linearGradient,radialGradient,filter';
    const out = [];
    document.querySelectorAll('path,rect,circle,ellipse,polygon,polyline').forEach((el, i) => {
      if (el.closest(NON)) return;
      for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return;
      }
      const r = el.getBoundingClientRect();
      if (r.width && r.height) out.push({ id: `svg-draw:${i}`, bbox: { x: r.x, y: r.y, width: r.width, height: r.height } });
    });
    return out;
  });
}
