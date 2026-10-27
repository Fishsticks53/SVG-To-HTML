import test from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { compareResiduals, deltaE76, rgbToLab } from '../src/residual.mjs';

const W = 400, H = 300;
// Synthetic canvas: flat background plus filled rects. Known ground truth, no browser needed.
function canvas(rects, bg = [250, 250, 250]) {
  const img = new PNG({ width: W, height: H });
  for (let i = 0; i < W * H * 4; i += 4) { img.data[i] = bg[0]; img.data[i + 1] = bg[1]; img.data[i + 2] = bg[2]; img.data[i + 3] = 255; }
  for (const { x, y, w, h, c } of rects) for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
    const i = (yy * W + xx) * 4; img.data[i] = c[0]; img.data[i + 1] = c[1]; img.data[i + 2] = c[2];
  }
  return PNG.sync.write(img);
}
const NAVY = [25, 55, 96];
const base = [{ x: 50, y: 40, w: 120, h: 60, c: NAVY }, { x: 250, y: 150, w: 100, h: 80, c: [200, 40, 40] }];

test('identical images report zero residual', () => {
  const r = compareResiduals(canvas(base), canvas(base));
  assert.equal(r.identical, true);
  assert.equal(r.foregroundDisagreementRatio, 0);
  assert.deepEqual(r.clusters, []);
});

test('1px right shift is measured with candidate-minus-reference sign', () => {
  const shifted = [{ ...base[0], x: 51 }, base[1]];
  const r = compareResiduals(canvas(base), canvas(shifted));
  assert.equal(r.clusters.length, 1);
  const c = r.clusters[0];
  assert.ok(Math.abs(c.inkCentroidShiftCssPx.dx - 1) < 1e-9, `dx=${c.inkCentroidShiftCssPx.dx}`);
  assert.ok(Math.abs(c.inkCentroidShiftCssPx.dy) < 1e-9);
  assert.equal(c.kind, 'mismatch');
});

test('RGB (25,55,96)->(25,55,98) interior ΔE76 matches the spec value 1.3777', () => {
  const recolored = [{ ...base[0], c: [25, 55, 98] }, base[1]];
  const r = compareResiduals(canvas(base), canvas(recolored), { noiseDE: 0.5 });
  assert.ok(Math.abs(r.clusters[0].interiorColor.deltaE76 - 1.3777) < 0.01);
  assert.ok(Math.abs(deltaE76(rgbToLab(...NAVY), rgbToLab(25, 55, 98)) - 1.3777) < 0.01);
});

test('small missing object is not diluted by a flat background', () => {
  const withIcon = [...base, { x: 300, y: 20, w: 16, h: 16, c: [10, 10, 10] }];
  const r = compareResiduals(canvas(withIcon), canvas(base));
  assert.ok(r.globalMismatchRatio < 0.003, 'global ratio is tiny');
  assert.ok(r.foregroundDisagreementRatio > 0.01);
  const missing = r.clusters.find((c) => c.kind === 'missing');
  assert.ok(missing, 'cluster classified as missing');
  assert.deepEqual([missing.bboxCssPx.x, missing.bboxCssPx.y], [300, 20]);
});

test('extra object is classified and ranked by impact', () => {
  const extra = [...base, { x: 20, y: 250, w: 8, h: 8, c: [0, 120, 0] }];
  const r = compareResiduals(canvas(base), canvas(extra));
  assert.equal(r.clusters[0].kind, 'extra');
});

test('dimension mismatch is rejected, not padded', () => {
  const small = new PNG({ width: 10, height: 10 });
  assert.throws(() => compareResiduals(canvas(base), PNG.sync.write(small)), { code: 'CVC_DIMENSION_MISMATCH' });
});

test('DPR scales CSS-pixel outputs', () => {
  const shifted = [{ ...base[0], x: 52 }, base[1]]; // 2 physical px at dpr 2 = 1 css px
  const r = compareResiduals(canvas(base), canvas(shifted), { dpr: 2 });
  assert.ok(Math.abs(r.clusters[0].inkCentroidShiftCssPx.dx - 1) < 1e-9);
});

test('evidence crops are written for each cluster', async () => {
  const { mkdtempSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'cvc-ev-'));
  const r = compareResiduals(canvas(base), canvas([{ ...base[0], x: 51 }, base[1]]), { evidenceDir: dir });
  for (const k of ['reference', 'candidate', 'diff']) assert.ok(existsSync(r.clusters[0].evidence[k]));
});
