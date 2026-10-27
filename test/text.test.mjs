import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { launch, openPage } from '../src/render.mjs';
import { svgGlyphCandidates, clusterGlyphRuns, inkLines, silhouetteIoU, measureHtmlLines, compareTextRegion } from '../src/text.mjs';

const dir = mkdtempSync(join(tmpdir(), 'cvc-s4-'));
const DPR = 2, W = 360, H = 160;
let browser, n = 0;
test.before(async () => { browser = await launch(); });
test.after(async () => { await browser.close(); });

async function page(name, content) {
  const file = join(dir, `${n++}-${name}`);
  writeFileSync(file, content);
  return openPage(browser, file, { width: W, height: H, dpr: DPR });
}
const FONT = 'font:600 20px sans-serif;fill:#193760;color:#193760';
const svgDoc = (body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#f4f6fa"/>${body}</svg>`;
const htmlDoc = (body) => `<!doctype html><body style="margin:0;background:#f4f6fa;width:${W}px;height:${H}px;position:relative;overflow:hidden">${body}</body>`;
const BOX = { x0: 0, y0: 0, x1: W * DPR - 1, y1: H * DPR - 1 };
const shot = async (op) => { const img = PNG.sync.read(await op.screenshot()); return img; };

test('glyph-like boxes cluster into lines and an isolated square is not treated as text', () => {
  const glyphs = [];
  let id = 0;
  for (const [y, count] of [[40, 6], [80, 5]]) for (let k = 0; k < count; k++) glyphs.push({ id: `g${id++}`, bbox: { x: 30 + k * 14, y: y + (k % 2 ? 1 : 0), width: 10, height: k === 2 ? 20 : 15 } });
  glyphs.push({ id: 'icon', bbox: { x: 300, y: 20, width: 16, height: 16 } });
  glyphs.push({ id: 'bar', bbox: { x: 20, y: 120, width: 300, height: 6 } }); // too wide to be a glyph
  const { runs, rejected } = clusterGlyphRuns(glyphs);
  const text = runs.filter((r) => r.kind === 'text-run');
  assert.equal(text.length, 2);
  assert.deepEqual(text.map((r) => r.glyphCount), [6, 5]);
  assert.ok(runs.some((r) => r.kind === 'icon-or-fragment' && r.glyphIds[0] === 'icon'));
  assert.deepEqual(rejected, ['bar']);
});

test('two SVG text lines are extracted as two ink lines with plausible baselines', async () => {
  const op = await page('a.svg', svgDoc(`<text x="20" y="50" style="${FONT}">Revenue growth</text><text x="20" y="90" style="${FONT}">overview</text>`));
  const lines = inkLines(await shot(op), BOX);
  await op.context.close();
  assert.equal(lines.length, 2);
  assert.ok(Math.abs(lines[0].baseline / DPR - 50) <= 1, `baseline ${lines[0].baseline / DPR}`);
  assert.ok(Math.abs(lines[1].baseline / DPR - 90) <= 1);
});

test('HTML line boxes expose the wrap point; range rects are unrounded', async () => {
  const op = await page('b.html', htmlDoc(`<p id="p" style="position:absolute;left:20px;top:20px;width:300px;margin:0;${FONT.replace('fill', 'x')}">Revenue growth overview dashboard</p>`));
  const res = await measureHtmlLines(op.page, '#p');
  await op.context.close();
  assert.equal(res.length, 1);
  assert.equal(res[0].lines.length, 2);
  assert.equal(res[0].lines[0].words + res[0].lines[1].words, 4);
});

test('same text as SVG vs HTML registers with high silhouette IoU and no wrap suspicion', async () => {
  const ref = await page('c.svg', svgDoc(`<text x="20" y="50" style="${FONT}">Revenue growth</text>`));
  const cand = await page('c.html', htmlDoc(`<div style="position:absolute;left:20px;top:30px;line-height:24px;white-space:nowrap;${FONT.replace('fill', 'x')}">Revenue growth</div>`));
  const f = compareTextRegion(await shot(ref), await shot(cand), BOX, { dpr: DPR });
  await ref.context.close(); await cand.context.close();
  assert.equal(f.lineCountDelta, 0);
  assert.ok(f.registeredSilhouette.iou > 0.7, `iou ${f.registeredSilhouette.iou}`);
  assert.equal(f.wrapSuspected, false);
});

test('an earlier wrap is reported as geometry only, and as a word claim only with a trusted source', async () => {
  const ref = await page('d.svg', svgDoc(`<text x="20" y="40" style="${FONT}">Revenue growth overview</text><text x="20" y="70" style="${FONT}">dashboard</text>`));
  const cand = await page('d.html', htmlDoc(`<p style="position:absolute;left:20px;top:20px;width:180px;margin:0;line-height:30px;${FONT.replace('fill', 'x')}">Revenue growth overview dashboard</p>`));
  const [ri, ci] = [await shot(ref), await shot(cand)];
  await ref.context.close(); await cand.context.close();
  const plain = compareTextRegion(ri, ci, BOX, { dpr: DPR });
  assert.equal(plain.wrapSuspected, true);
  assert.equal(plain.wordLevelClaim, null);
  assert.match(plain.note, /geometry only/);
  const trusted = compareTextRegion(ri, ci, BOX, { dpr: DPR, sourceText: 'Revenue growth overview dashboard', sourceTextConfidence: 0.95 });
  assert.ok(trusted.wordLevelClaim);
  const weak = compareTextRegion(ri, ci, BOX, { dpr: DPR, sourceText: 'Revenue growth overview dashboard', sourceTextConfidence: 0.5 });
  assert.equal(weak.wordLevelClaim, null);
});

test('svgGlyphCandidates skips defs and hidden shapes and feeds the clusterer', async () => {
  const glyphs = [0, 1, 2, 3].map((k) => `<rect x="${20 + k * 14}" y="40" width="10" height="16" fill="#193760"/>`).join('');
  const op = await page('e.svg', svgDoc(`<defs><clipPath id="c"><rect x="0" y="0" width="5" height="5"/></clipPath></defs>${glyphs}<rect x="200" y="40" width="10" height="16" style="display:none"/>`));
  const items = (await svgGlyphCandidates(op.page)).filter((i) => i.bbox.width < W / 2); // drop the page background rect
  await op.context.close();
  assert.equal(items.length, 4);
  const { runs } = clusterGlyphRuns(items);
  assert.deepEqual(runs.map((r) => [r.kind, r.glyphCount]), [['text-run', 4]]);
});
