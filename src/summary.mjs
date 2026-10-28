// Agent-facing digest of an `analyze()` result: a short ranked defect list with ready-to-run follow-up
// commands. Pure function of the result; it adds no measurements of its own.

const SEVERITY = { render: 0, 'critical-objects': 1, 'component-geometry': 2, 'residual-foreground': 3, robustness: 4, 'measurement-confidence': 5 };
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const r1 = (n) => Math.round(n * 10) / 10;

export function summarize(result, { refFile = '<reference.svg>', candFile = '<candidate.html>', maxDefects = 10, width = 1280, height = 832 } = {}) {
  const { acceptance, correspondence } = result;
  const matches = new Map((correspondence?.matches ?? []).map((m) => [m.matchId, m]));
  const defects = [];

  for (const g of acceptance.gates) {
    if (g.status === 'pass') continue;
    const base = { gate: g.name, critical: !!g.critical };
    if (g.status === 'not_tested') { defects.push({ ...base, type: 'not-tested', score: 0, action: g.detail }); continue; }
    if (g.name === 'render') { defects.push({ ...base, type: 'render', score: 1e6, detail: g.detail, action: 'Fix the render problem first; no other measurement is trustworthy until it passes.' }); continue; }
    if (g.name === 'critical-objects') {
      for (const m of g.items) defects.push({ ...base, type: m.kind, score: 1e5 + (m.paintedAreaPx ?? 0), selector: m.selector, side: m.side, boxCssPx: m.paintedBoxCssPx,
        action: m.kind === 'missing' ? `Add an element that paints at ${JSON.stringify(m.paintedBoxCssPx)} (reference object ${m.selector}).` : `Remove or hide the candidate element ${m.selector}; the reference has nothing there.` });
      continue;
    }
    if (g.name === 'component-geometry') {
      for (const m of g.items) {
        const worst = Math.max(Math.abs(m.dx), Math.abs(m.dy), Math.abs(m.dw), Math.abs(m.dh));
        const sel = m.candidate[0];
        const box = matches.get(m.matchId)?.referenceBoxCssPx;
        const cmd = sel && box ? `node src/repair.mjs ${q(refFile)} ${q(candFile)} --selector=${q(sel)} --props=left,top,width,height --box=${[box.x, box.y, box.width, box.height].map(r1).join(',')} --width=${width} --height=${height}` : undefined;
        defects.push({ ...base, type: 'geometry', score: 1e4 + worst, reference: m.reference, candidate: m.candidate, ambiguous: !!m.ambiguous,
          measurement: { dx: m.dx, dy: m.dy, dw: m.dw, dh: m.dh, unit: 'css px', sign: 'candidate - reference' },
          suggestedCommand: cmd, action: 'Run suggestedCommand for a verified CSS patch; adjust the props list if the cause is not position or size.' });
      }
      continue;
    }
    if (g.name === 'residual-foreground') {
      defects.push({ ...base, type: 'residual', score: 1e3, detail: g.detail, clusters: g.topClusters, action: 'Largest unexplained pixel regions; inspect cvc-report crops from compare.mjs for these boxes.' });
      continue;
    }
    if (g.name === 'robustness') {
      for (const v of g.items) defects.push({ ...base, type: 'robustness', score: v.invariant === 'no-horizontal-overflow' ? 500 : 100, invariant: v.invariant, selector: v.selector, width: v.width, phase: v.phase, detail: v.detail,
        action: 'Layout breaks outside the 1280 design width; prefer fluid constraints (max-width, flex/grid, min-width:0) over fixed pixel widths.' });
      continue;
    }
    defects.push({ ...base, type: g.name, score: 1, detail: g.detail, action: 'Needs human review; the tool abstains rather than guess.' });
  }

  defects.sort((a, b) => b.score - a.score);
  const ranked = defects.slice(0, maxDefects).map(({ score, ...d }, i) => ({ rank: i + 1, ...d }));
  const notTested = acceptance.abstentions;
  return {
    schema: 'cvc-agent-summary/v0.1',
    verdict: acceptance.verdict,
    accepted: acceptance.accepted,
    thresholdsCalibrated: acceptance.thresholdsCalibrated,
    totalDefects: defects.length,
    truncated: defects.length > ranked.length,
    defects: ranked,
    notTested,
    nextStep: acceptance.accepted ? 'Accepted under the stated (possibly uncalibrated) thresholds. Stop.'
      : ranked.length ? 'Fix defect rank 1, regenerate, and rerun accept.mjs. Fix one class at a time and compare verdicts; do not trade a critical gate for a better aggregate.'
        : 'No defects listed; resolve not-tested gates.',
  };
}
