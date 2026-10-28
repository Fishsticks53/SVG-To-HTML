import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../src/summary.mjs';

const gate = (name, status, extra = {}) => ({ name, status, detail: `${name} ${status}`, critical: true, ...extra });
const result = (gates, matches = []) => ({
  acceptance: { verdict: 'rejected', accepted: false, thresholdsCalibrated: false, abstentions: [], gates },
  correspondence: { matches },
});

test('defects are ranked: missing object, then geometry by magnitude, then residual, then robustness', () => {
  const r = result([
    gate('render', 'pass'),
    gate('critical-objects', 'fail', { items: [{ kind: 'missing', side: 'reference', selector: 'svg > g:nth-child(3)', paintedAreaPx: 900, paintedBoxCssPx: { x: 1, y: 2, width: 30, height: 30 } }] }),
    gate('component-geometry', 'fail', { items: [
      { matchId: 'a', reference: ['r1'], candidate: ['.small'], dx: 2, dy: 0, dw: 0, dh: 0 },
      { matchId: 'b', reference: ['r2'], candidate: ['.big'], dx: -9, dy: 0, dw: 0, dh: 0 },
    ] }),
    gate('residual-foreground', 'fail', { topClusters: [] }),
    gate('robustness', 'fail', { items: [{ invariant: 'img-has-alt', selector: 'img' }, { invariant: 'no-horizontal-overflow', selector: 'html', width: 1120 }] }),
  ], [{ matchId: 'b', referenceBoxCssPx: { x: 10, y: 20, width: 100.04, height: 50 } }]);
  const s = summarize(r, { refFile: 'ref.svg', candFile: 'cand it.html' });
  assert.deepEqual(s.defects.map((d) => d.type), ['missing', 'geometry', 'geometry', 'residual', 'robustness', 'robustness']);
  assert.equal(s.defects[1].candidate[0], '.big');
  assert.equal(s.defects[4].invariant, 'no-horizontal-overflow');
  assert.equal(s.defects[1].suggestedCommand, "node src/repair.mjs 'ref.svg' 'cand it.html' --selector='.big' --props=left,top,width,height --box=10,20,100,50 --width=1280 --height=832");
  assert.equal(s.defects[0].rank, 1);
});

test('a not-tested gate is surfaced, never treated as a pass, and maxDefects truncates', () => {
  const r = result([gate('render', 'pass'), gate('robustness', 'not_tested')]);
  r.acceptance.abstentions = ['robustness'];
  r.acceptance.verdict = 'incomplete';
  const s = summarize(r);
  assert.equal(s.defects[0].type, 'not-tested');
  assert.deepEqual(s.notTested, ['robustness']);
  const many = result([gate('robustness', 'fail', { items: Array.from({ length: 5 }, () => ({ invariant: 'x', selector: 'a' })) })]);
  const t = summarize(many, { maxDefects: 2 });
  assert.equal(t.defects.length, 2);
  assert.equal(t.truncated, true);
});

test('an accepted result lists no defects and says stop', () => {
  const r = result([gate('render', 'pass')]);
  r.acceptance.accepted = true; r.acceptance.verdict = 'accepted';
  const s = summarize(r);
  assert.equal(s.defects.length, 0);
  assert.match(s.nextStep, /Stop/);
});
