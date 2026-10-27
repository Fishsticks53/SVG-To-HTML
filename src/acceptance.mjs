// Stage 6b: acceptance as a quality vector. Every gate is reported; an unresolved critical gate can
// never be hidden behind a high aggregate similarity score. Thresholds are explicit and uncalibrated.

export const DEFAULT_THRESHOLDS = Object.freeze({
  calibrated: false, // [U] set to true only after a calibration/holdout run has frozen these
  maxForegroundDisagreement: 0.03,
  geometryToleranceCssPx: 1.0,
  criticalObjectMinAreaPx: 256, // 16 x 16 CSS px at 1x, per the spec's missing/extra target
  requireRobustness: true,
});

const gate = (name, status, detail, extra = {}) => ({ name, status, detail, ...extra });

/**
 * @param {object} i  { manifests:{reference,candidate}, residual, correspondence, robustness? }
 */
export function evaluateAcceptance(i, thresholds = {}) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const gates = [];

  // 1. Render correctness
  const bad = [];
  for (const [side, m] of Object.entries(i.manifests ?? {})) {
    if (!m.dimensionsVerified) bad.push(`${side}: screenshot size ${m.physical.width}x${m.physical.height} != expected ${m.expectedPhysical.width}x${m.expectedPhysical.height}`);
    if (m.pageErrors?.length) bad.push(`${side}: ${m.pageErrors.length} page error(s)`);
    if (m.blockedRequests?.length) bad.push(`${side}: blocked request(s) ${m.blockedRequests.join(', ')}`);
    if (m.failedRequests?.length) bad.push(`${side}: failed request(s)`);
    if (m.brokenImages?.length) bad.push(`${side}: broken image(s)`);
    if (m.fonts?.some((f) => f.status === 'error')) bad.push(`${side}: font failed to load`);
  }
  gates.push(i.manifests ? gate('render', bad.length ? 'fail' : 'pass', bad.length ? bad.join('; ') : 'dimensions, assets and fonts verified', { critical: true }) : gate('render', 'not_tested', 'no render manifests supplied', { critical: true }));

  // 2. Critical missing / extra objects (area from painted footprints, so shadows count)
  const c = i.correspondence;
  if (c) {
    const crit = [...c.missing.map((m) => ({ ...m, kind: 'missing' })), ...c.extra.map((m) => ({ ...m, kind: 'extra' }))].filter((m) => m.paintedAreaPx >= t.criticalObjectMinAreaPx);
    gates.push(gate('critical-objects', crit.length ? 'fail' : 'pass', crit.length ? crit.map((m) => `${m.kind} ${m.side} ${m.selector} at ${m.paintedBoxCssPx.x},${m.paintedBoxCssPx.y}`).join('; ') : 'no missing or extra salient objects', { critical: true, items: crit }));

    // 3. Component geometry
    const off = [];
    for (const m of c.matches) {
      const d = m.footprintDelta; if (!d) continue;
      const worst = Math.max(Math.abs(d.dx), Math.abs(d.dy), Math.abs(d.dw), Math.abs(d.dh));
      if (worst > t.geometryToleranceCssPx) off.push({ matchId: m.matchId, reference: m.reference.map((r) => r.selector), candidate: m.candidate.map((r) => r.selector), dx: d.dx, dy: d.dy, dw: d.dw, dh: d.dh, ambiguous: m.ambiguous });
    }
    gates.push(gate('component-geometry', off.length ? 'fail' : 'pass', off.length ? `${off.length} component(s) beyond ${t.geometryToleranceCssPx}px` : 'all matched components within tolerance', { critical: true, items: off }));

    // 6. Measurement confidence: ambiguity is a review item, never a silent pass
    const amb = c.matches.filter((m) => m.ambiguous);
    gates.push(gate('measurement-confidence', amb.length ? 'review' : 'pass', amb.length ? `${amb.length} ambiguous match(es) need human review` : 'no ambiguous matches', { critical: false }));
  } else {
    gates.push(gate('critical-objects', 'not_tested', 'no correspondence supplied', { critical: true }));
    gates.push(gate('component-geometry', 'not_tested', 'no correspondence supplied', { critical: true }));
  }

  // 4. Residual foreground error
  if (i.residual) {
    const r = i.residual.foregroundDisagreementRatio;
    gates.push(gate('residual-foreground', r <= t.maxForegroundDisagreement ? 'pass' : 'fail', `foreground disagreement ${(r * 100).toFixed(2)}% (limit ${(t.maxForegroundDisagreement * 100).toFixed(2)}%)`, { critical: true, topClusters: i.residual.clusters.slice(0, 3).map((k) => ({ id: k.id, kind: k.kind, bboxCssPx: k.bboxCssPx })) }));
  } else gates.push(gate('residual-foreground', 'not_tested', 'no residual report supplied', { critical: true }));

  // 5. Robustness
  if (i.robustness) {
    const v = i.robustness.violations;
    gates.push(gate('robustness', i.robustness.status === 'pass' ? 'pass' : 'fail', v.length ? `${v.length} invariant violation(s): ${[...new Set(v.map((x) => x.invariant))].join(', ')}` : 'declared invariants hold at all tested widths', { critical: t.requireRobustness, items: v.slice(0, 10) }));
  } else gates.push(gate('robustness', 'not_tested', 'robustness checks were not run', { critical: t.requireRobustness }));

  const failing = gates.filter((g) => g.status === 'fail' && g.critical);
  const notTested = gates.filter((g) => g.status === 'not_tested' && g.critical);
  const review = gates.filter((g) => g.status === 'review');
  return {
    schema: 'cvc-acceptance/v0.1',
    accepted: failing.length === 0 && notTested.length === 0 && review.length === 0,
    verdict: failing.length ? 'rejected' : notTested.length ? 'incomplete' : review.length ? 'needs_review' : 'accepted',
    thresholds: t,
    thresholdsCalibrated: t.calibrated,
    gates,
    unresolvedCritical: failing.map((g) => g.name),
    abstentions: notTested.map((g) => g.name),
  };
}
