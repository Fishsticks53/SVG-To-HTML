#!/usr/bin/env node
// Usage: node src/repair.mjs <reference> <candidate.html> --selector=.card --props=left,width,border-radius --box=x,y,w,h [--out=dir]
// Probes the candidate in a live page and prints a verified CSS patch. The candidate file is never modified.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { PNG } from 'pngjs';
import { launch, openPage } from './render.mjs';
import { repairTarget } from './probes.mjs';

const args = process.argv.slice(2);
const opt = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
const [refFile, candFile] = args.filter((a) => !a.startsWith('--'));
if (!refFile || !candFile || !opt.selector || !opt.props || !opt.box) {
  console.error('usage: repair.mjs <reference> <candidate.html> --selector=SEL --props=a,b --box=x,y,w,h [--width=1280] [--height=832] [--out=dir]');
  process.exit(2);
}
const width = Number(opt.width ?? 1280), height = Number(opt.height ?? 832);
const [bx, by, bw, bh] = opt.box.split(',').map(Number);
const box = { x0: Math.floor(bx), y0: Math.floor(by), x1: Math.ceil(bx + bw) - 1, y1: Math.ceil(by + bh) - 1 };

const browser = await launch();
try {
  const ref = await openPage(browser, resolve(refFile), { width, height, dpr: 1 });
  const refImg = PNG.sync.read(await ref.screenshot());
  await ref.context.close();
  const cand = await openPage(browser, resolve(candFile), { width, height, dpr: 1 });
  const result = await repairTarget(cand, { selector: opt.selector, props: opt.props.split(','), box, refImg });
  await cand.context.close();
  const out = resolve(opt.out ?? 'out');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'cvc-repair.json'), JSON.stringify(result, null, 2));
  console.log(result.patchCss ?? '/* no verified improvement */');
  console.log(`error ${result.errorBefore.toFixed(2)} -> ${result.errorAfter.toFixed(2)} (${result.stopReason})`);
} finally {
  await browser.close();
}
