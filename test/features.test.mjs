import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { launch, openPage } from '../src/render.mjs';
import { shapeGeometry, fitCornerRadii, edgeDistances, borderBands, gradientProfile, compareGradients, shadowProfile, compareShadows, compareFeatures } from '../src/features.mjs';

const dir = mkdtempSync(join(tmpdir(), 'cvc-s3-'));
const DPR = 2, W = 240, H = 160;
let browser;
test.before(async () => { browser = await launch(); });
test.after(async () => { await browser.close(); });

// Real Chromium 2x renders: the browser's own antialiasing is part of what we are measuring.
let n = 0;
async function shot(style, extra = '') {
  const file = join(dir, `f${n++}.html`);
  writeFileSync(file, `<!doctype html><body style="margin:0;background:#f4f6fa;width:${W}px;height:${H}px;position:relative;overflow:hidden"><div style="position:absolute;${style}"></div>${extra}</body>`);
  const op = await openPage(browser, file, { width: W, height: H, dpr: DPR });
  const img = PNG.sync.read(await op.screenshot());
  await op.context.close();
  return img;
}
const BOX = { x0: 0, y0: 0, x1: W * DPR - 1, y1: H * DPR - 1 };
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} got ${a}, want ${b} ±${tol}`);
const card = (x, y, w, h, extra = '') => `left:${x}px;top:${y}px;width:${w}px;height:${h}px;background:#193760;${extra}`;

test('subpixel translation, size and edges are recovered at 2x', async () => {
  // Fractional transforms are antialiased; fractional left/top on a div is snapped to device pixels.
  const a = await shot(card(50, 40, 120, 60, 'border-radius:6px;transform:translate(.25px,.5px)'));
  const b = await shot(card(50, 41, 118, 60, 'border-radius:6px;transform:translate(.75px,.5px)'));
  const f = compareFeatures(a, b, BOX, { checks: ['geometry'] });
  near(f.geometry.dxCssPx, -0.5, 0.15, 'dx'); // centres 110.25 -> 109.75
  near(f.geometry.dwCssPx, -2, 0.3, 'dw');
  near(f.geometry.dyCssPx, 1, 0.15, 'dy');
  near(f.geometry.dhCssPx, 0, 0.15, 'dh');
});

test('corner radius 8 vs 6 is measured within the 0.5px uncertainty', async () => {
  const a = fitCornerRadii(shapeGeometry(await shot(card(50, 40, 120, 60, 'border-radius:8px')), BOX, DPR));
  const b = fitCornerRadii(shapeGeometry(await shot(card(50, 40, 120, 60, 'border-radius:6px')), BOX, DPR));
  near(a.meanCssPx, 8, a.uncertaintyCssPx, 'r8'); near(b.meanCssPx, 6, b.uncertaintyCssPx, 'r6');
  near(b.meanCssPx - a.meanCssPx, -2, 0.5, 'delta');
});

test('edge offset distinguishes translation from expansion', async () => {
  const base = await shot(card(50, 40, 120, 60));
  const shifted = await shot(card(52, 40, 120, 60));
  const grown = await shot(card(49, 39, 122, 62));
  const rg = shapeGeometry(base, BOX, DPR);
  const es = edgeDistances(rg, shapeGeometry(shifted, BOX, DPR)), eg = edgeDistances(rg, shapeGeometry(grown, BOX, DPR));
  near(es.signedOffsetMeanCssPx, 0, 0.3, 'translation has ~zero mean signed offset');
  assert.ok(es.hd95CssPx > 1.5, `hd95 ${es.hd95CssPx}`);
  near(eg.signedOffsetMeanCssPx, 1, 0.3, 'expansion is positive');
});

test('border width and colour deltas', async () => {
  const a = await shot(card(50, 40, 120, 60, 'box-sizing:border-box;border:2px solid #c82828'));
  const b = await shot(card(50, 40, 120, 60, 'box-sizing:border-box;border:3px solid #c82828'));
  const ga = shapeGeometry(a, BOX, DPR), gb = shapeGeometry(b, BOX, DPR);
  const ba = borderBands(a, ga), bb = borderBands(b, gb);
  near(ba.left.widthCssPx, 2, 0.5, 'ref'); near(bb.left.widthCssPx - ba.left.widthCssPx, 1, 0.5, 'delta');
});

test('gradient angle and profile differences', async () => {
  const g = (deg, to) => card(50, 40, 120, 60).replace('background:#193760', `background:linear-gradient(${deg}deg,#193760,${to})`);
  const ref = await shot(g(90, '#e0b040')), same = await shot(g(90, '#e0b040')), angled = await shot(g(60, '#e0b040')), recolored = await shot(g(90, '#40b0e0'));
  const gp = (img) => gradientProfile(img, shapeGeometry(img, BOX, DPR));
  const c0 = compareGradients(gp(ref), gp(same)), c1 = compareGradients(gp(ref), gp(angled)), c2 = compareGradients(gp(ref), gp(recolored));
  near(c0.meanProfileDeltaE76, 0, 0.01); near(c0.angleDeltaDeg, 0, 0.5);
  assert.ok(Math.abs(c1.angleDeltaDeg) > 10, `angle ${c1.angleDeltaDeg}`);
  assert.ok(c2.endDeltaE76 > 20, `end ${c2.endDeltaE76}`);
});

test('shadow blur, offset and peak differences', async () => {
  const sh = (s) => card(70, 50, 100, 50, `box-shadow:${s}`);
  const ref = await shot(sh('0 4px 8px rgba(0,0,0,.4)')), blur = await shot(sh('0 4px 16px rgba(0,0,0,.4)')), moved = await shot(sh('4px 8px 8px rgba(0,0,0,.4)')), same = await shot(sh('0 4px 8px rgba(0,0,0,.4)'));
  const sp = (img) => shadowProfile(img, shapeGeometry(img, BOX, DPR));
  const s0 = compareShadows(sp(ref), sp(same)), s1 = compareShadows(sp(ref), sp(blur)), s2 = compareShadows(sp(ref), sp(moved));
  near(s0.profileRmse, 0, 1e-6);
  assert.ok(s1.extentDiffCssPx > 2, `extent ${s1.extentDiffCssPx}`);
  assert.ok(s1.peakDeltaE76Diff < 0, 'wider blur lowers the peak');
  near(s2.offsetDiffCssPx.dx, 4, 1.5, 'dx'); assert.ok(s2.offsetDiffCssPx.dy > 2, `dy ${s2.offsetDiffCssPx.dy}`);
});

test('a missing shape reports missing_in_one_side instead of numbers', async () => {
  const a = await shot(card(50, 40, 120, 60));
  const b = await shot('display:none');
  assert.equal(compareFeatures(a, b, BOX).status, 'missing_in_one_side');
});
