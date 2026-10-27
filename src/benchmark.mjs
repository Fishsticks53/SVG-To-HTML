#!/usr/bin/env node
// Usage: node src/benchmark.mjs [casesDir=bench/cases]
// Runs every case dir (ref.svg, cand.html, expect.json {accepted}) and reports verdicts, runtime,
// false accepts (the dangerous error) and false rejects. Exit code 1 on any disagreement.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './render.mjs';
import { analyze } from './pipeline.mjs';

export async function runBenchmark(dir) {
  const browser = await launch();
  const rows = [];
  try {
    for (const name of readdirSync(dir).sort()) {
      const c = join(dir, name);
      if (!existsSync(join(c, 'expect.json'))) continue;
      const expect = JSON.parse(readFileSync(join(c, 'expect.json'), 'utf8'));
      const r = await analyze(join(c, 'ref.svg'), join(c, 'cand.html'), { browser });
      rows.push({ name, expected: expect.accepted, got: r.acceptance.accepted, verdict: r.acceptance.verdict, failing: r.acceptance.unresolvedCritical, runtimeMs: r.runtimeMs });
    }
  } finally { await browser.close(); }
  const falseAccepts = rows.filter((r) => r.got && !r.expected).length, falseRejects = rows.filter((r) => !r.got && r.expected).length;
  return { rows, falseAccepts, falseRejects, total: rows.length, meanRuntimeMs: rows.reduce((s, r) => s + r.runtimeMs, 0) / Math.max(1, rows.length) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const res = await runBenchmark(resolve(process.argv[2] ?? 'bench/cases'));
  for (const r of res.rows) console.log(`${r.expected === r.got ? 'ok  ' : 'FAIL'} ${r.name.padEnd(20)} ${r.verdict.padEnd(10)} ${String(r.runtimeMs).padStart(5)}ms  ${r.failing.join(',')}`);
  console.log(`${res.total} cases, ${res.falseAccepts} false accept(s), ${res.falseRejects} false reject(s), mean ${Math.round(res.meanRuntimeMs)}ms`);
  process.exit(res.falseAccepts || res.falseRejects ? 1 : 0);
}
