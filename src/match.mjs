// Stage 2b: many-to-many correspondence between reference (SVG) and candidate (HTML) components,
// using knockout footprints as the shared observable. Ambiguity is reported, never resolved by guessing.

function inter(a, b) { // both sorted ascending
  let i = 0, j = 0, n = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { n++; i++; j++; } else if (a[i] < b[j]) i++; else j++;
  }
  return n;
}

function union(list) {
  const set = new Set();
  for (const f of list) for (const p of f.indices) set.add(p);
  return Uint32Array.from([...set].sort((x, y) => x - y));
}

const iouOf = (a, b) => { const n = inter(a, b); return a.length + b.length - n ? n / (a.length + b.length - n) : 0; };

function bboxDelta(refBox, candBox, dpr) {
  const w = (b) => b.x1 - b.x0 + 1, h = (b) => b.y1 - b.y0 + 1;
  return {
    dx: (candBox.x0 - refBox.x0) / dpr, dy: (candBox.y0 - refBox.y0) / dpr,
    dw: (w(candBox) - w(refBox)) / dpr, dh: (h(candBox) - h(refBox)) / dpr,
    signConvention: 'candidate_minus_reference', kind: 'painted-footprint-bbox',
  };
}

const boxCss = (fps, dpr) => { const b = unionBox(fps); return { x: b.x0 / dpr, y: b.y0 / dpr, width: (b.x1 - b.x0 + 1) / dpr, height: (b.y1 - b.y0 + 1) / dpr }; };

const unionBox = (fps) => fps.reduce((b, f) => (!b ? { ...f.bbox } : {
  x0: Math.min(b.x0, f.bbox.x0), y0: Math.min(b.y0, f.bbox.y0), x1: Math.max(b.x1, f.bbox.x1), y1: Math.max(b.y1, f.bbox.y1),
}), null);

/**
 * @param {object} ref   knockouts() result for the reference
 * @param {object} cand  knockouts() result for the candidate
 */
export function matchComponents(ref, cand, { dpr = 1, minIoU = 0.5, groupCover = 0.6, groupInside = 0.7, ambiguityRatio = 0.9, minAreaPx = 16 } = {}) {
  const live = (list) => list.filter((c) => c.footprint.area > 0);
  const noncontributing = [...ref.components.filter((c) => c.footprint.area === 0).map((c) => ({ side: 'reference', id: c.id, selector: c.selector })),
    ...cand.components.filter((c) => c.footprint.area === 0).map((c) => ({ side: 'candidate', id: c.id, selector: c.selector }))];
  const R = live(ref.components), C = live(cand.components);

  const pairs = [];
  for (const r of R) for (const c of C) {
    const iou = iouOf(r.footprint.indices, c.footprint.indices);
    if (iou >= minIoU) pairs.push({ r, c, iou });
  }
  pairs.sort((a, b) => b.iou - a.iou);

  const usedR = new Set(), usedC = new Set(), matches = [];
  for (const p of pairs) {
    if (usedR.has(p.r.id) || usedC.has(p.c.id)) continue;
    usedR.add(p.r.id); usedC.add(p.c.id);
    // Ambiguity: another unused-or-used counterpart almost as good on either side.
    const rivals = pairs.filter((q) => q !== p && (q.r.id === p.r.id || q.c.id === p.c.id) && q.iou >= ambiguityRatio * p.iou);
    matches.push({
      refIds: [p.r.id], candIds: [p.c.id], relation: '1:1', iou: p.iou,
      ambiguous: rivals.length > 0,
      alternatives: rivals.map((q) => ({ refId: q.r.id, candId: q.c.id, iou: q.iou })),
      footprintDelta: bboxDelta(p.r.footprint.bbox, p.c.footprint.bbox, dpr),
    });
  }

  // Many-to-one: leftover pieces on one side jointly covering one component on the other.
  const grouped = (singles, others, usedSingles, usedOthers, singleSide) => {
    for (const o of others) {
      if (usedOthers.has(o.id)) continue;
      const parts = singles.filter((s) => !usedSingles.has(s.id) && inter(s.footprint.indices, o.footprint.indices) / s.footprint.area >= groupInside);
      if (parts.length < 2) continue;
      const u = union(parts.map((s) => s.footprint));
      const cover = inter(u, o.footprint.indices) / o.footprint.area;
      if (cover < groupCover) continue;
      parts.forEach((s) => usedSingles.add(s.id)); usedOthers.add(o.id);
      const refSide = singleSide === 'reference';
      matches.push({
        refIds: refSide ? parts.map((s) => s.id) : [o.id],
        candIds: refSide ? [o.id] : parts.map((s) => s.id),
        relation: refSide ? 'many:1' : '1:many', iou: iouOf(u, o.footprint.indices), coverage: cover,
        ambiguous: false, alternatives: [],
        footprintDelta: refSide
          ? bboxDelta(unionBox(parts.map((s) => s.footprint)), o.footprint.bbox, dpr)
          : bboxDelta(o.footprint.bbox, unionBox(parts.map((s) => s.footprint)), dpr),
      });
    }
  };
  grouped(R, C, usedR, usedC, 'reference');
  grouped(C, R, usedC, usedR, 'candidate');

  // Leftover pieces lying inside an already well-matched component (e.g. children of a matched
  // group, proposed only so a failing group could be subdivided) are not missing or extra.
  const sideUnion = (m, side, byId) => union((side === 'reference' ? m.refIds : m.candIds).map((id) => byId.get(id).footprint));
  const refById = new Map(ref.components.map((c) => [c.id, c])), candById = new Map(cand.components.map((c) => [c.id, c]));
  const good = matches.filter((m) => m.iou >= 0.9);
  const covered = (c, side) => good.some((m) => {
    const u = sideUnion(m, side, side === 'reference' ? refById : candById);
    return inter(c.footprint.indices, u) / c.footprint.area >= 0.9;
  });
  const subcomponents = [];
  for (const [list, used, side] of [[R, usedR, 'reference'], [C, usedC, 'candidate']]) {
    for (const c of list) if (!used.has(c.id) && covered(c, side)) { used.add(c.id); subcomponents.push({ side, id: c.id, selector: c.selector }); }
  }

  const describe = (c, side) => ({ side, id: c.id, selector: c.selector, why: c.why,
    paintedAreaPx: c.footprint.area, paintedBoxCssPx: { x: c.footprint.bbox.x0 / dpr, y: c.footprint.bbox.y0 / dpr,
      width: (c.footprint.bbox.x1 - c.footprint.bbox.x0 + 1) / dpr, height: (c.footprint.bbox.y1 - c.footprint.bbox.y0 + 1) / dpr } });
  const missing = R.filter((r) => !usedR.has(r.id) && r.footprint.area >= minAreaPx).map((r) => describe(r, 'reference'));
  const extra = C.filter((c) => !usedC.has(c.id) && c.footprint.area >= minAreaPx).map((c) => describe(c, 'candidate'));
  const unresolved = [...R.filter((r) => !usedR.has(r.id) && r.footprint.area < minAreaPx), ...C.filter((c) => !usedC.has(c.id) && c.footprint.area < minAreaPx)]
    .map((c) => ({ id: c.id, selector: c.selector, paintedAreaPx: c.footprint.area, note: 'below minAreaPx; not reported as missing/extra' }));

  const byId = (list) => new Map(list.map((c) => [c.id, c]));
  const rm = byId(ref.components), cm = byId(cand.components);
  return {
    schema: 'cvc-correspondence/v0.1',
    matches: matches.map((m, i) => ({
      matchId: `m-${String(i + 1).padStart(3, '0')}`, ...m,
      reference: m.refIds.map((id) => ({ id, selector: rm.get(id).selector })),
      candidate: m.candIds.map((id) => ({ id, selector: cm.get(id).selector })),
      referenceBoxCssPx: boxCss(m.refIds.map((id) => rm.get(id).footprint), dpr),
      candidateBoxCssPx: boxCss(m.candIds.map((id) => cm.get(id).footprint), dpr),
      compositionSensitive: [...m.refIds.map((id) => rm.get(id)), ...m.candIds.map((id) => cm.get(id))].some((c) => c.compositionSensitive),
    })),
    missing, extra, noncontributing, subcomponents, unresolved,
    warnings: [...ref.warnings, ...cand.warnings],
  };
}
