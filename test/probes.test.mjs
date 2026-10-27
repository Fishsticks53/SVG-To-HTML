import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { launch, openPage } from '../src/render.mjs';
import { probeProperty, repairTarget, probeDiscrete, regionError } from '../src/probes.mjs';

const dir = mkdtempSync(join(tmpdir(), 'cvc-s5-'));
const W = 300, H = 200;
let browser, n = 0;
test.before(async () => { browser = await launch(); });
test.after(async () => { await browser.close(); });

const file = (name, s) => { const p = join(dir, `${n++}-${name}`); writeFileSync(p, s); return p; };
// Reference is an SVG (a different representation from the candidate HTML).
const refSvg = (rect, extra = '') => file('r.svg', `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#f4f6fa"/>${rect}${extra}</svg>`);
const cand = (style, extra = '') => file('c.html', `<!doctype html><body style="margin:0;background:#f4f6fa;width:${W}px;height:${H}px;position:relative;overflow:hidden"><div id="card" style="position:absolute;background:#193760;${style}"></div>${extra}</body>`);
const open = (f) => openPage(browser, f, { width: W, height: H, dpr: 1 });
const grab = async (op) => PNG.sync.read(await op.screenshot());
const REGION = { x0: 20, y0: 20, x1: 260, y1: 150 };
const SVG_CARD = '<rect x="50" y="40" width="120" height="60" rx="8" fill="#193760"/>';

test('a single mutated property is found and corrected, and the sensitivity probe sees the right direction', async () => {
  const ref = await open(refSvg(SVG_CARD)); const refImg = await grab(ref); await ref.context.close();
  const c = await open(cand('left:50px;top:40px;width:114px;height:60px;border-radius:8px'));
  // A 1px probe only "sees" ~1px of a 6px error, so the single-property probe uses a wide step.
  const p = await probeProperty(c, { selector: '#card', prop: 'width', box: REGION, refImg, h: 8 });
  assert.ok(p.responsive); assert.ok(Math.abs(p.delta - 6) < 1.0, `delta ${p.delta}`);
  const r = await repairTarget(c, { selector: '#card', props: ['width', 'height', 'left', 'top'], box: REGION, refImg });
  assert.ok(r.errorAfter < 1e-6, `after ${r.errorAfter}`);
  assert.deepEqual(r.patches.map((a) => a.property), ['width']);
  assert.ok(Math.abs(r.patches[0].to - 120) < 0.5);
  assert.match(r.patchCss, /width: 120px/);
  await c.context.close();
});

test('coupled mutations (left and width) are both recovered', async () => {
  const ref = await open(refSvg(SVG_CARD)); const refImg = await grab(ref); await ref.context.close();
  const c = await open(cand('left:56px;top:40px;width:108px;height:60px;border-radius:8px'));
  const r = await repairTarget(c, { selector: '#card', props: ['left', 'width', 'top', 'height', 'border-radius'], box: REGION, refImg });
  await c.context.close();
  assert.ok(r.errorAfter < r.errorBefore * 0.02, `before ${r.errorBefore} after ${r.errorAfter}`);
  const byProp = Object.fromEntries(r.patches.map((a) => [a.property, a.to]));
  assert.ok(Math.abs(byProp.left - 50) < 1, JSON.stringify(byProp)); assert.ok(Math.abs(byProp.width - 120) < 1, JSON.stringify(byProp));
});

test('corner radius error is attributed to border-radius, not to geometry', async () => {
  const ref = await open(refSvg(SVG_CARD)); const refImg = await grab(ref); await ref.context.close();
  const c = await open(cand('left:50px;top:40px;width:120px;height:60px;border-radius:2px'));
  const r = await repairTarget(c, { selector: '#card', props: ['width', 'left', 'border-radius'], box: REGION, refImg });
  await c.context.close();
  assert.deepEqual(r.patches.map((a) => a.property), ['border-radius']);
  assert.ok(Math.abs(r.patches[0].to - 8) < 1.0, `radius ${r.patches[0].to}`);
});

test('a fix that regresses a guard region is rejected and remembered', async () => {
  // The neighbour is a second element whose position is tied to the card's width, so widening the card
  // pushes the neighbour away from where the reference has it.
  const ref = await open(refSvg(SVG_CARD, '<rect x="180" y="40" width="40" height="60" fill="#c82828"/>')); const refImg = await grab(ref); await ref.context.close();
  const html = `<!doctype html><body style="margin:0;background:#f4f6fa;width:${W}px;height:${H}px;position:relative"><div style="position:absolute;left:50px;top:40px;display:flex"><div id="card" style="width:114px;height:60px;border-radius:8px;background:#193760"></div><div style="width:40px;height:60px;margin-left:16px;background:#c82828"></div></div></body>`;
  const c = await open(file('flow.html', html));
  const r = await repairTarget(c, { selector: '#card', props: ['width'], box: { x0: 40, y0: 30, x1: 175, y1: 110 }, guards: [{ x0: 176, y0: 30, x1: 260, y1: 110 }], refImg });
  await c.context.close();
  assert.equal(r.accepted.length, 0);
  assert.ok(r.history.some((h) => h.verdict === 'guard_regression'), JSON.stringify(r.history));
});

test('an irrelevant property is not accepted; discrete probing ranks candidates by error', async () => {
  const ref = await open(refSvg(SVG_CARD)); const refImg = await grab(ref); await ref.context.close();
  const c = await open(cand('left:50px;top:40px;width:120px;height:60px;border-radius:8px'));
  const r = await repairTarget(c, { selector: '#card', props: ['padding-left', 'margin-top'], box: REGION, refImg });
  assert.equal(r.accepted.length, 0);
  const d = await probeDiscrete(c, { selector: '#card', prop: 'display', values: ['none', 'block'], box: REGION, refImg });
  assert.equal(d.best, 'block');
  await c.context.close();
});
