#!/usr/bin/env node
// Usage: node src/compare.mjs <reference.svg|html> <candidate.html> [outDir] [--dpr=1] [--width=1280] [--height=832] [--correspond]
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { launch, render, openPage, assertSameDimensions } from './render.mjs';
import { proposeComponents, knockouts } from './components.mjs';
import { matchComponents } from './match.mjs';
import { compareResiduals } from './residual.mjs';

const args = process.argv.slice(2);
const opt = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
const [refFile, candFile, outArg] = args.filter((a) => !a.startsWith('--'));
if (!refFile || !candFile) { console.error('usage: compare.mjs <reference> <candidate> [outDir] [--dpr=N] [--width=N] [--height=N]'); process.exit(2); }

const dpr = Number(opt.dpr ?? 1), width = Number(opt.width ?? 1280), height = Number(opt.height ?? 832);
const out = resolve(outArg ?? 'out');
mkdirSync(out, { recursive: true });

const browser = await launch();
try {
  const ref = await render(browser, resolve(refFile), { width, height, dpr });
  const cand = await render(browser, resolve(candFile), { width, height, dpr });
  assertSameDimensions(ref, cand);
  writeFileSync(join(out, 'reference.png'), ref.png);
  writeFileSync(join(out, 'candidate.png'), cand.png);
  const residual = compareResiduals(ref.png, cand.png, { dpr, evidenceDir: join(out, 'crops') });
  const report = { manifests: { reference: ref.manifest, candidate: cand.manifest }, residual };
  if ('correspond' in opt) {
    const ko = [];
    for (const [file, kind] of [[refFile, /\.svg$/i.test(refFile) ? 'svg' : 'html'], [candFile, 'html']]) {
      const op = await openPage(browser, resolve(file), { width, height, dpr });
      ko.push(await knockouts(op, await proposeComponents(op.page, kind)));
      await op.context.close();
    }
    report.correspondence = matchComponents(ko[0], ko[1], { dpr });
  }
  if ('text' in opt) {
    // Outlined text: cluster glyph-like shapes into runs, then compare each run as visual lines at 2x.
    const hi = { width, height, dpr: 2 };
    const a = PNG.sync.read((await render(browser, resolve(refFile), hi)).png), b = PNG.sync.read((await render(browser, resolve(candFile), hi)).png);
    const op = await openPage(browser, resolve(refFile), { width, height, dpr: 1 });
    const { runs } = clusterGlyphRuns(await svgGlyphCandidates(op.page));
    await op.context.close();
    const pad = 6;
    report.text = runs.filter((r) => r.kind === 'text-run').map((run) => {
      const r = run.bboxCssPx;
      const box = { x0: Math.max(0, Math.floor((r.x - pad) * 2)), y0: Math.max(0, Math.floor((r.y - pad) * 2)), x1: Math.min(a.width - 1, Math.ceil((r.x + r.width + pad) * 2)), y1: Math.min(a.height - 1, Math.ceil((r.y + r.height + pad) * 2)) };
      return { run, comparison: compareTextRegion(a, b, box, { dpr: 2 }) };
    });
  }
  writeFileSync(join(out, 'cvc-report.json'), JSON.stringify(report, null, 2));
  console.log(`foreground disagreement ${(residual.foregroundDisagreementRatio * 100).toFixed(2)}%, ${residual.clusters.length} cluster(s) -> ${join(out, 'cvc-report.json')}`);
} finally {
  await browser.close();
}
