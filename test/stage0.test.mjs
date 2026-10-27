import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, render, assertSameDimensions } from '../src/render.mjs';

const dir = mkdtempSync(join(tmpdir(), 'cvc-'));
const write = (n, s) => { const p = join(dir, n); writeFileSync(p, s); return p; };
const svg = write('vb.svg', `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 100 100"><rect id="r" x="10" y="10" width="80" height="80" fill="#123"/><defs><path id="d" d="M0 0h5v5z"/></defs></svg>`);
const html = write('a.html', `<!doctype html><body style="margin:0"><div style="width:50.25px;height:20px;background:#abc;box-shadow:0 0 4px #000"></div>`);
const remote = write('remote.html', `<!doctype html><img src="https://example.com/x.png"><script>throw new Error('boom')</script>`);

test('30 repeats are byte-identical', async () => {
  const b = await launch();
  try {
    const hashes = new Set();
    for (let i = 0; i < 30; i++) hashes.add((await render(b, html, { width: 360, height: 180 })).manifest.pngSha256);
    assert.equal(hashes.size, 1);
  } finally { await b.close(); }
});

test('viewBox geometry is reported in screen space, unrounded, defs excluded', async () => {
  const b = await launch();
  try {
    const { geometry } = await render(b, svg, { width: 200, height: 100, geometry: true });
    assert.equal(geometry.length, 1);
    assert.deepEqual([geometry[0].x, geometry[0].y, geometry[0].width, geometry[0].height], [60, 10, 80, 80]);
  } finally { await b.close(); }
});

test('dimension mismatch is rejected, DPR physical size verified', async () => {
  const b = await launch();
  try {
    const a = await render(b, html, { width: 360, height: 180 });
    const c = await render(b, html, { width: 360, height: 180, dpr: 2 });
    assert.equal(c.manifest.dimensionsVerified, true);
    assert.deepEqual(c.manifest.physical, { width: 720, height: 360 });
    assert.throws(() => assertSameDimensions(a, c), { code: 'CVC_DIMENSION_MISMATCH' });
    assert.doesNotThrow(() => assertSameDimensions(a, a));
  } finally { await b.close(); }
});

test('remote requests are blocked and page errors surfaced', async () => {
  const b = await launch();
  try {
    const { manifest } = await render(b, remote, { width: 100, height: 100 });
    assert.deepEqual(manifest.blockedRequests, ['https://example.com/x.png']);
    assert.equal(manifest.pageErrors.length, 1);
    assert.equal(manifest.brokenImages.length, 1);
  } finally { await b.close(); }
});
