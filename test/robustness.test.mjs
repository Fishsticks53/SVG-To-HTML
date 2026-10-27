import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launch, openPage } from '../src/render.mjs';
import { checkRobustness } from '../src/robustness.mjs';
import { evaluateAcceptance } from '../src/acceptance.mjs';
import { runBenchmark } from '../src/benchmark.mjs';

const dir = mkdtempSync(join(tmpdir(), 'cvc-s6-'));
let browser, n = 0;
test.before(async () => { browser = await launch(); });
test.after(async () => { await browser.close(); });

async function check(body, opts = {}) {
  const f = join(dir, `${n++}.html`);
  writeFileSync(f, `<!doctype html><html lang="en"><head><title>t</title></head><body style="margin:0;font:16px sans-serif">${body}</body></html>`);
  const op = await openPage(browser, f, { width: 1280, height: 832, dpr: 1 });
  const r = await checkRobustness(op, { perturbFactor: 0, ...opts });
  await op.context.close();
  return r;
}
const names = (r) => [...new Set(r.violations.map((v) => v.invariant))];

test('a flexible layout passes; absolute positioning alone is not a violation', async () => {
  const r = await check('<main><h1>Dashboard</h1><div style="position:absolute;left:20px;top:80px">Badge</div><p style="margin-top:100px">Body text</p></main>');
  assert.equal(r.status, 'pass', JSON.stringify(r.violations));
  assert.ok(r.semanticInfo.absolutelyPositioned >= 1);
});

test('fixed-width content overflows at the narrower widths only', async () => {
  const r = await check('<div style="width:1280px;height:50px;background:#ccc"></div>');
  assert.deepEqual(names(r), ['no-horizontal-overflow']);
  assert.deepEqual(r.violations.map((v) => v.width).sort(), [1120]);
});

test('overlapping text blocks and clipped text are flagged', async () => {
  const r = await check('<div style="position:relative;height:100px"><span style="position:absolute;left:10px;top:10px">Overlapping heading text</span><span style="position:absolute;left:30px;top:12px">Another label here</span></div><div style="width:60px;height:20px;overflow:hidden;white-space:nowrap">This text is much too long for its box</div>');
  assert.ok(names(r).includes('no-overlapping-text-or-controls'));
  assert.ok(names(r).includes('no-clipped-essential-content'));
});

test('20% longer text is tested: a tight label that fits now but not after growth is caught', async () => {
  const body = '<div style="width:140px;overflow:hidden;white-space:nowrap"><b>Quarterly revenue</b></div>';
  assert.equal((await check(body)).status, 'pass');
  const r = await check(body, { perturbFactor: 1.2 });
  assert.equal(r.status, 'fail');
  assert.ok(r.perturbation.newViolations > 0);
  assert.ok(r.violations.every((v) => v.phase === 'text-perturbation'));
});

test('semantic checks: missing alt, nameless button, heading skip, whole-page SVG', async () => {
  const r = await check('<h1>A</h1><h3>B</h3><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><button></button><svg width="1200" height="800"><rect width="1200" height="800"/></svg>');
  for (const i of ['img-has-alt', 'control-has-name', 'heading-order', 'no-whole-page-svg']) assert.ok(names(r).includes(i), i);
});

test('acceptance never hides a critical failure behind passing gates, and abstains when untested', () => {
  const ok = { dimensionsVerified: true, physical: { width: 1, height: 1 }, expectedPhysical: { width: 1, height: 1 }, pageErrors: [], blockedRequests: [], failedRequests: [], brokenImages: [], fonts: [] };
  const base = { manifests: { reference: ok, candidate: ok }, residual: { foregroundDisagreementRatio: 0, clusters: [] }, correspondence: { matches: [], missing: [{ side: 'reference', selector: 'g', paintedAreaPx: 300, paintedBoxCssPx: { x: 1, y: 2 } }], extra: [] }, robustness: { status: 'pass', violations: [] } };
  const a = evaluateAcceptance(base);
  assert.equal(a.accepted, false); assert.deepEqual(a.unresolvedCritical, ['critical-objects']);
  const small = evaluateAcceptance({ ...base, correspondence: { matches: [], missing: [{ side: 'reference', selector: 'g', paintedAreaPx: 10, paintedBoxCssPx: { x: 1, y: 2 } }], extra: [] } });
  assert.equal(small.accepted, true);
  const untested = evaluateAcceptance({ ...base, correspondence: { matches: [], missing: [], extra: [] }, robustness: undefined });
  assert.equal(untested.verdict, 'incomplete'); assert.deepEqual(untested.abstentions, ['robustness']);
  assert.equal(untested.thresholdsCalibrated, false);
});

test('benchmark: no false accepts or rejects, including the identical-pixels clones that must still fail', async () => {
  const res = await runBenchmark(resolve('bench/cases'));
  assert.equal(res.total, 6);
  assert.equal(res.falseAccepts, 0, JSON.stringify(res.rows));
  assert.equal(res.falseRejects, 0, JSON.stringify(res.rows));
});
