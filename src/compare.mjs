#!/usr/bin/env node
// Usage: node src/compare.mjs <reference.svg|html> <candidate.html> [outDir] [--dpr=1] [--width=1280] [--height=832]
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { launch, render, assertSameDimensions } from './render.mjs';
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
  writeFileSync(join(out, 'cvc-report.json'), JSON.stringify(report, null, 2));
  console.log(`foreground disagreement ${(residual.foregroundDisagreementRatio * 100).toFixed(2)}%, ${residual.clusters.length} cluster(s) -> ${join(out, 'cvc-report.json')}`);
} finally {
  await browser.close();
}
