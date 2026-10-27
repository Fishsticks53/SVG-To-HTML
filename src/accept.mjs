#!/usr/bin/env node
// Usage: node src/accept.mjs <reference.svg> <candidate.html> [outDir] [--width=1280] [--height=832] [--widths=1120,1280,1440]
// Runs the full single-viewport analysis and prints the acceptance verdict. Exit code 1 unless accepted.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { analyze } from './pipeline.mjs';

const args = process.argv.slice(2);
const opt = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
const [refFile, candFile, outArg] = args.filter((a) => !a.startsWith('--'));
if (!refFile || !candFile) { console.error('usage: accept.mjs <reference.svg> <candidate.html> [outDir] [--width=N] [--height=N] [--widths=a,b,c]'); process.exit(2); }

const r = await analyze(refFile, candFile, { width: Number(opt.width ?? 1280), height: Number(opt.height ?? 832), widths: opt.widths ? opt.widths.split(',').map(Number) : undefined });
const out = resolve(outArg ?? 'out');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'cvc-acceptance.json'), JSON.stringify(r, null, 2));
for (const g of r.acceptance.gates) console.log(`${g.status.padEnd(10)} ${g.name.padEnd(22)} ${g.detail}`);
console.log(`verdict: ${r.acceptance.verdict}${r.acceptance.thresholdsCalibrated ? '' : ' (thresholds are uncalibrated defaults)'}  ${r.runtimeMs}ms -> ${join(out, 'cvc-acceptance.json')}`);
process.exit(r.acceptance.accepted ? 0 : 1);
