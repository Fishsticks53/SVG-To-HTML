// Stage 5: causal CSS probes. A pixel error does not say which CSS property caused it, so each
// candidate property is perturbed in the live candidate page, the image response is measured, and a
// correction is kept only if a real re-render improves the target region without regressing guards.
import { PNG } from 'pngjs';

const NONNEGATIVE = new Set(['width', 'height', 'padding-left', 'padding-right', 'padding-top', 'padding-bottom', 'gap', 'column-gap', 'row-gap', 'border-radius', 'font-size', 'border-width', 'min-width', 'min-height']);
// Probe step per property (CSS px) for the finite difference.
const STEP = { 'font-size': 0.5, 'letter-spacing': 0.25, 'line-height': 0.5 };

const px = (s) => { const v = parseFloat(s); return Number.isFinite(v) ? v : 0; };

export function regionVector(img, box) {
  const w = box.x1 - box.x0 + 1, h = box.y1 - box.y0 + 1;
  const v = new Float64Array(w * h * 3);
  let k = 0;
  for (let y = box.y0; y <= box.y1; y++) for (let x = box.x0; x <= box.x1; x++) {
    const i = (y * img.width + x) * 4;
    v[k++] = img.data[i]; v[k++] = img.data[i + 1]; v[k++] = img.data[i + 2];
  }
  return v;
}
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const diff = (a, b) => a.map((x, i) => x - b[i]);

/** Mean squared channel error over a physical-pixel box. */
export function regionError(refImg, candImg, box) {
  const r = regionVector(refImg, box), c = regionVector(candImg, box);
  let s = 0; for (let i = 0; i < r.length; i++) s += (r[i] - c[i]) ** 2;
  return s / r.length;
}

export async function computedPx(page, selector, prop) {
  return page.evaluate(([sel, p]) => {
    const el = document.querySelector(sel);
    const cs = getComputedStyle(el);
    const v = p === 'border-radius' ? cs.borderTopLeftRadius : cs.getPropertyValue(p);
    return v === 'normal' || v === 'auto' ? 0 : parseFloat(v) || 0;
  }, [selector, prop]);
}

async function setProp(page, selector, prop, value) {
  await page.evaluate(([sel, p, v]) => document.querySelector(sel).style.setProperty(p, v, 'important'), [selector, prop, value === null ? '' : `${value}px`]);
}

async function snapshotStyle(page, selector) {
  return page.evaluate((sel) => document.querySelector(sel).getAttribute('style'), selector);
}
async function restoreStyle(page, selector, old) {
  await page.evaluate(([sel, o]) => { const el = document.querySelector(sel); if (o === null) el.removeAttribute('style'); else el.setAttribute('style', o); }, [selector, old]);
}

const clamp = (prop, v) => (NONNEGATIVE.has(prop) ? Math.max(0, v) : v);

// Coarse-to-fine probe steps (multiplied by the property's own scale). One pixel of response only
// "sees" about one pixel of error, so the first rounds probe with wide steps and later rounds refine.
const SCHEDULE = [8, 2, 1, 0.5];

/**
 * Finite-difference response of the region to one numeric property:  J = (H+ - H-) / (2h).
 */
export async function jacobianColumn(open, { selector, prop, box, h }) {
  const shot = async () => PNG.sync.read(await open.screenshot());
  const old = await snapshotStyle(open.page, selector);
  const base = await computedPx(open.page, selector, prop);
  try {
    await setProp(open.page, selector, prop, clamp(prop, base + h));
    const hp = regionVector(await shot(), box);
    await setProp(open.page, selector, prop, clamp(prop, base - h));
    const hm = regionVector(await shot(), box);
    const span = clamp(prop, base + h) - clamp(prop, base - h); // < 2h when clamped at zero
    return { prop, base, h, J: hp.map((v, i) => (v - hm[i]) / span) };
  } finally {
    await restoreStyle(open.page, selector, old);
  }
}

/** Single-property proposal: delta = <J, R - H0> / (<J,J> + lambda), bounded by maxStep. */
export async function probeProperty(open, { selector, prop, box, refImg, h = STEP[prop] ?? 1, lambda = 1e-6, maxStep = 24 }) {
  const shot = async () => PNG.sync.read(await open.screenshot());
  const col = await jacobianColumn(open, { selector, prop, box, h });
  const gain = dot(col.J, diff(regionVector(refImg, box), regionVector(await shot(), box)));
  const norm = dot(col.J, col.J);
  const delta = Math.max(-maxStep, Math.min(maxStep, gain / (norm + lambda)));
  return { prop, base: col.base, h, sensitivity: Math.sqrt(norm / col.J.length), delta, responsive: norm > 1e-9 };
}

// Solve (A + lambda I) x = b by Gaussian elimination with partial pivoting; A is small (<= ~6 properties).
function solve(A, b, lambda) {
  const n = b.length, M = A.map((row, i) => [...row.map((v, j) => v + (i === j ? lambda : 0)), b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) return null;
    for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) { let v = M[i][n]; for (let j = i + 1; j < n; j++) v -= M[i][j] * x[j]; x[i] = v / M[i][i]; }
  return x;
}

/**
 * Coupled step: least-squares over several properties at once, (J^T J + lambda I) delta = J^T (R - H0).
 * Properties whose solved |delta| is below `minDelta` are pruned and the system re-solved, so a pure radius
 * error is not blamed on width or left just because they are in the candidate set.
 */
export function coupledStep(cols, residual, { lambda = 1e-3, maxStep = 24, minDelta = 0.25 } = {}) {
  let active = cols.filter((c) => dot(c.J, c.J) > 1e-9);
  for (;;) {
    if (!active.length) return {};
    const A = active.map((a) => active.map((b) => dot(a.J, b.J)));
    const rhs = active.map((a) => dot(a.J, residual));
    const x = solve(A, rhs, lambda);
    if (!x) return {};
    const kept = active.filter((_, i) => Math.abs(x[i]) >= minDelta);
    if (kept.length === active.length) return Object.fromEntries(active.map((a, i) => [a.prop, { base: a.base, delta: Math.max(-maxStep, Math.min(maxStep, x[i])) }]));
    active = kept;
  }
}

/** Apply `deltas` together; halve the whole step up to `halvings` times until the region error falls. */
async function trialJoint(open, { selector, deltas, box, refImg, halvings = 3 }) {
  const shot = async () => PNG.sync.read(await open.screenshot());
  const before = regionError(refImg, await shot(), box);
  let f = 1;
  for (let k = 0; k <= halvings; k++) {
    const old = await snapshotStyle(open.page, selector);
    const applied = {};
    for (const [prop, { base, delta }] of Object.entries(deltas)) {
      applied[prop] = clamp(prop, base + delta * f);
      await setProp(open.page, selector, prop, applied[prop]);
    }
    const img = await shot();
    const after = regionError(refImg, img, box);
    if (after < before) return { applied: true, values: applied, before, after, halvings: k, img, old };
    await restoreStyle(open.page, selector, old);
    f /= 2;
  }
  return { applied: false, before, after: before };
}

/**
 * Repair one target: each round builds the coupled least-squares proposal (coarse-to-fine probe steps), verifies
 * it with a real re-render, and falls back to the best single property if the joint edit is rejected.
 * An edit is kept only if the target improves by `minGain` and no guard region regresses; rejected hypotheses
 * are remembered so the loop cannot oscillate. `guards` are physical-pixel boxes.
 */
export async function repairTarget(open, { selector, props, box, refImg, guards = [], maxRounds = 4, minGain = 0.02, guardTolerance = 0.05 }) {
  const shot = async () => PNG.sync.read(await open.screenshot());
  const history = [], rejected = new Set(), accepted = [];
  const guardErrors = (img) => guards.map((g) => regionError(refImg, img, g));
  let img = await shot();
  const initial = regionError(refImg, img, box);
  let current = initial, guardBase = guardErrors(img);

  const consider = async (round, label, deltas) => {
    const key = label + ':' + Object.entries(deltas).map(([p, d]) => `${p}=${Math.round(d.delta * 4) / 4}`).join(',');
    if (rejected.has(key)) return false;
    const t = await trialJoint(open, { selector, deltas, box, refImg });
    let verdict = 'no_improvement';
    if (t.applied) {
      const ge = guardErrors(t.img);
      if (ge.some((e, i) => e > guardBase[i] * (1 + guardTolerance) + 1e-9)) { await restoreStyle(open.page, selector, t.old); verdict = 'guard_regression'; }
      else if ((current - t.after) / Math.max(current, 1e-9) < minGain) { await restoreStyle(open.page, selector, t.old); verdict = 'below_min_gain'; }
      else {
        verdict = 'accepted';
        for (const [prop, to] of Object.entries(t.values)) accepted.push({ selector, property: prop, from: deltas[prop].base, to, unit: 'px', evidence: 'causally_verified', round });
        current = t.after; guardBase = ge;
      }
    }
    if (verdict !== 'accepted') rejected.add(key);
    history.push({ round, mode: label, properties: Object.keys(deltas), proposedDeltas: Object.fromEntries(Object.entries(deltas).map(([p, d]) => [p, d.delta])), errorBefore: t.before, errorAfter: t.after, verdict });
    return verdict === 'accepted';
  };

  for (let round = 1; round <= maxRounds && current > 1e-9; round++) {
    const sched = SCHEDULE[Math.min(round - 1, SCHEDULE.length - 1)];
    const cols = [];
    for (const prop of props) cols.push(await jacobianColumn(open, { selector, prop, box, h: sched * (STEP[prop] ?? 1) }));
    const residual = diff(regionVector(refImg, box), regionVector(await shot(), box));
    const joint = coupledStep(cols, residual);
    let ok = Object.keys(joint).length ? await consider(round, 'joint', joint) : false;
    if (!ok) {
      // Fallback: strongest single-property proposals, one at a time.
      const singles = cols.map((c) => { const n = dot(c.J, c.J); return n > 1e-9 ? { prop: c.prop, base: c.base, delta: Math.max(-24, Math.min(24, dot(c.J, residual) / (n + 1e-6))), n } : null; })
        .filter((x) => x && Math.abs(x.delta) >= 0.25).sort((a, b) => Math.abs(b.delta) * b.n - Math.abs(a.delta) * a.n);
      for (const sgl of singles) { if (await consider(round, 'single', { [sgl.prop]: { base: sgl.base, delta: sgl.delta } })) { ok = true; break; } }
    }
    if (!ok) break;
  }
  // One consolidated edit per property: first original value -> last accepted value.
  const patches = [...accepted.reduce((m, a) => m.set(a.property, m.has(a.property) ? { ...m.get(a.property), to: a.to } : { ...a }), new Map()).values()];
  return {
    schema: 'cvc-repair/v0.1', selector, errorBefore: initial, errorAfter: current,
    improvement: initial ? (initial - current) / initial : 0, accepted, patches, history,
    stopReason: current <= 1e-9 ? 'target_matched' : !accepted.length ? 'no_verified_improvement' : 'converged_or_budget',
    patchCss: patches.length ? `${selector} {\n${patches.map((a) => `  ${a.property}: ${Math.round(a.to * 4) / 4}px;`).join('\n')}\n}` : null,
  };
}

/** Discrete properties (font-family, display, white-space, ...): render each candidate value and rank by region error. */
export async function probeDiscrete(open, { selector, prop, values, box, refImg }) {
  const shot = async () => PNG.sync.read(await open.screenshot());
  const old = await snapshotStyle(open.page, selector);
  const results = [];
  try {
    for (const v of values) {
      await open.page.evaluate(([sel, p, val]) => document.querySelector(sel).style.setProperty(p, val, 'important'), [selector, prop, v]);
      results.push({ value: v, error: regionError(refImg, await shot(), box) });
      await restoreStyle(open.page, selector, old);
    }
  } finally {
    await restoreStyle(open.page, selector, old);
  }
  results.sort((a, b) => a.error - b.error);
  return { prop, ranked: results, best: results[0].value };
}
