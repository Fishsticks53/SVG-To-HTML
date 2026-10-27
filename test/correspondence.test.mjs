import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, openPage } from '../src/render.mjs';
import { proposeComponents, knockouts } from '../src/components.mjs';
import { matchComponents } from '../src/match.mjs';

const dir = mkdtempSync(join(tmpdir(), 'cvc-s2-'));
const write = (n, s) => { const p = join(dir, n); writeFileSync(p, s); return p; };
const W = 400, H = 300;
const svg = (body) => write('r.svg', `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#f4f6fa"/>${body}</svg>`);
const html = (body) => write('c.html', `<!doctype html><body style="margin:0;background:#f4f6fa;width:${W}px;height:${H}px;position:relative;overflow:hidden">${body}</body>`);
const box = (x, y, w, h, c, extra = '') => `<div style="position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;background:${c};${extra}"></div>`;

async function analyze(refFile, candFile) {
  const b = await launch();
  try {
    const out = [];
    for (const [file, kind] of [[refFile, 'svg'], [candFile, 'html']]) {
      const op = await openPage(b, file, { width: W, height: H });
      out.push(await knockouts(op, await proposeComponents(op.page, kind)));
      await op.context.close();
    }
    return matchComponents(out[0], out[1]);
  } finally { await b.close(); }
}

test('equivalent SVG and HTML match 1:1 with signed painted-box delta', async () => {
  const r = svg(`<rect x="50" y="40" width="120" height="60" fill="#193760"/><circle cx="300" cy="200" r="30" fill="#c82828"/>`);
  const c = html(box(52, 41, 120, 60, '#193760') + box(270, 170, 60, 60, '#c82828', 'border-radius:50%'));
  const m = await analyze(r, c);
  assert.deepEqual([m.missing.length, m.extra.length], [0, 0]);
  const card = m.matches.find((x) => x.relation === '1:1' && x.footprintDelta.dx === 2);
  assert.ok(card, JSON.stringify(m.matches.map((x) => x.footprintDelta)));
  assert.equal(card.footprintDelta.dy, 1);
});

test('SVG group of three shapes maps many:1 to a single HTML element', async () => {
  const r = svg(`<g><rect x="50" y="40" width="40" height="40" fill="#193760"/><rect x="90" y="40" width="40" height="40" fill="#193760"/><rect x="130" y="40" width="40" height="40" fill="#193760"/></g>`);
  const c = html(box(50, 40, 120, 40, '#193760'));
  const m = await analyze(r, c);
  assert.deepEqual([m.missing.length, m.extra.length], [0, 0]);
  assert.ok(m.matches.some((x) => x.refIds.length >= 1 && x.candIds.length === 1 && x.iou > 0.95));
});

test('icon absent from the candidate is reported missing; extra element reported extra', async () => {
  const r = svg(`<rect x="50" y="40" width="120" height="60" fill="#193760"/><rect x="300" y="20" width="16" height="16" fill="#111"/>`);
  const c = html(box(50, 40, 120, 60, '#193760') + box(20, 250, 30, 30, '#0a0'));
  const m = await analyze(r, c);
  assert.equal(m.missing.length, 1);
  assert.deepEqual([m.missing[0].paintedBoxCssPx.x, m.missing[0].paintedBoxCssPx.y], [300, 20]);
  assert.equal(m.extra.length, 1);
});

test('fully occluded element is noncontributing, not missing', async () => {
  const r = svg(`<rect x="50" y="40" width="120" height="60" fill="#193760"/>`);
  const c = html(box(60, 50, 20, 20, '#f00') + box(50, 40, 120, 60, '#193760', 'z-index:1'));
  const m = await analyze(r, c);
  assert.equal(m.extra.length, 0);
  assert.ok(m.noncontributing.some((n) => n.side === 'candidate'));
});

test('two stacked identical HTML elements make the match ambiguous instead of guessing', async () => {
  const r = svg(`<rect x="50" y="40" width="120" height="60" fill="#193760"/>`);
  const c = html(box(50, 40, 120, 60, '#193760', 'opacity:.5') + box(50, 40, 120, 60, '#193760', 'opacity:.5'));
  const m = await analyze(r, c);
  assert.ok(m.matches.some((x) => x.ambiguous && x.alternatives.length > 0), JSON.stringify(m.matches, null, 1));
});
