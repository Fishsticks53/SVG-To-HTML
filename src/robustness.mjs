// Stage 6a: robustness checks on the candidate HTML. A static SVG defines no responsive design, so
// these test declared layout invariants, never "resized screenshot vs stretched SVG".
// Violations carry the invariant that failed; using position:absolute is never a violation by itself.

const LAYOUT = `(opts) => {
  const out = [];
  const pathOf = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      parts.unshift(n.id ? n.tagName.toLowerCase() + '#' + n.id : n.tagName.toLowerCase() + ':nth-child(' + ([...n.parentElement.children].indexOf(n) + 1) + ')');
    }
    return parts.join(' > ') || 'html';
  };
  const shown = (el) => { for (let n = el; n && n.nodeType === 1; n = n.parentElement) { const cs = getComputedStyle(n); if (cs.display === 'none' || cs.visibility === 'hidden') return false; } return true; };

  const de = document.documentElement;
  if (de.scrollWidth > de.clientWidth + 1) out.push({ invariant: 'no-horizontal-overflow', selector: 'html', detail: 'scrollWidth ' + de.scrollWidth + ' > clientWidth ' + de.clientWidth });

  // Text-bearing leaves (measured with Range so inline text boxes, not the container, are compared) and controls.
  const items = [];
  const CONTROL = 'button,a[href],input,select,textarea,[role=button]';
  for (const el of document.body.querySelectorAll('*')) {
    if (items.length >= 300 || !shown(el)) continue;
    if (el.matches('script,style,svg *')) continue;
    let rect = null;
    const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim());
    if (own.length) {
      const r = document.createRange();
      r.setStartBefore(own[0]); r.setEndAfter(own[own.length - 1]);
      const b = r.getBoundingClientRect();
      if (b.width && b.height) rect = b;
    } else if (el.matches(CONTROL)) {
      const b = el.getBoundingClientRect();
      if (b.width && b.height) rect = b;
    }
    if (rect) items.push({ el, rect, text: own.length > 0 });
  }

  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = items[i], b = items[j];
    if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
    const w = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
    const h = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
    if (w <= 0 || h <= 0) continue;
    const inter = w * h, min = Math.min(a.rect.width * a.rect.height, b.rect.width * b.rect.height);
    if (inter > 16 && inter > 0.15 * min) out.push({ invariant: 'no-overlapping-text-or-controls', selector: pathOf(a.el), other: pathOf(b.el), detail: Math.round(inter) + 'px2 overlap' });
  }

  // Text cut off by an overflow clip, or pushed off the left edge. ellipsis is an intentional truncation.
  for (const { el } of items) {
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      const clips = /hidden|clip/.test(cs.overflowX + ' ' + cs.overflowY);
      if (clips && cs.textOverflow !== 'ellipsis' && (n.scrollWidth > n.clientWidth + 1 || n.scrollHeight > n.clientHeight + 1)) {
        out.push({ invariant: 'no-clipped-essential-content', selector: pathOf(el), clippedBy: pathOf(n), detail: 'content ' + n.scrollWidth + 'x' + n.scrollHeight + ' in ' + n.clientWidth + 'x' + n.clientHeight });
        break;
      }
    }
  }
  for (const { el, rect } of items) if (rect.right < 0 || rect.left > de.clientWidth + 1 && getComputedStyle(document.body).overflowX !== 'visible') out.push({ invariant: 'no-clipped-essential-content', selector: pathOf(el), detail: 'text outside the viewport' });

  // Reading order: each text block should not sit wholly above the block before it in DOM order.
  const blocks = items.filter((i) => i.text);
  for (let k = 1; k < blocks.length; k++) {
    const p = blocks[k - 1].rect, c = blocks[k].rect;
    if (c.bottom <= p.top - 1) out.push({ invariant: 'stable-reading-order', selector: pathOf(blocks[k].el), detail: 'appears above the previous block in DOM order' });
  }
  return { violations: out, itemCount: items.length };
}`;

const SEMANTIC = `() => {
  const out = [];
  const pathOf = (el) => el.id ? el.tagName.toLowerCase() + '#' + el.id : el.tagName.toLowerCase() + ':nth-child(' + ([...el.parentElement.children].indexOf(el) + 1) + ')';
  const name = (el) => (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.textContent || el.getAttribute('title') || el.getAttribute('value') || '').trim();
  for (const img of document.querySelectorAll('img')) if (!img.hasAttribute('alt')) out.push({ invariant: 'img-has-alt', selector: pathOf(img), detail: 'missing alt (use alt="" for decorative)' });
  for (const b of document.querySelectorAll('button,[role=button]')) if (!name(b) && !b.querySelector('img[alt]:not([alt=""])')) out.push({ invariant: 'control-has-name', selector: pathOf(b), detail: 'button without accessible name' });
  for (const a of document.querySelectorAll('a')) if (!a.hasAttribute('href')) out.push({ invariant: 'link-has-href', selector: pathOf(a), detail: 'anchor without href' }); else if (!name(a) && !a.querySelector('img[alt]:not([alt=""])')) out.push({ invariant: 'control-has-name', selector: pathOf(a), detail: 'link without accessible name' });
  for (const i of document.querySelectorAll('input:not([type=hidden]),select,textarea')) {
    const labelled = i.id && document.querySelector('label[for="' + i.id + '"]') || i.closest('label') || i.getAttribute('aria-label') || i.getAttribute('aria-labelledby');
    if (!labelled) out.push({ invariant: 'input-has-label', selector: pathOf(i), detail: 'form control without a label' });
  }
  let last = 0;
  for (const h of document.querySelectorAll('h1,h2,h3,h4,h5,h6')) { const l = +h.tagName[1]; if (last && l > last + 1) out.push({ invariant: 'heading-order', selector: pathOf(h), detail: 'h' + last + ' followed by h' + l }); last = l; }
  // The page must be real HTML, not the source SVG pasted back in.
  const vw = innerWidth, vh = innerHeight, cover = (r) => r.width * r.height >= 0.8 * vw * vh;
  for (const el of document.querySelectorAll('svg,img,object,embed')) {
    if (el.closest('svg') !== el && el.tagName.toLowerCase() !== 'svg') { /* html element */ }
    if (el.tagName.toLowerCase() === 'svg' && el.parentElement && el.parentElement.closest('svg')) continue;
    const isSvgImg = el.tagName.toLowerCase() === 'svg' || /\\.svg(\\?|#|$)/i.test(el.getAttribute('src') || el.getAttribute('data') || '');
    if (isSvgImg && cover(el.getBoundingClientRect())) out.push({ invariant: 'no-whole-page-svg', selector: pathOf(el), detail: 'SVG covers >= 80% of the viewport' });
  }
  const abs = [...document.body.querySelectorAll('*')].filter((e) => getComputedStyle(e).position === 'absolute').length;
  return { violations: out, info: { absolutelyPositioned: abs, elements: document.body.querySelectorAll('*').length, landmarks: document.querySelectorAll('main,nav,header,footer,aside,[role=main],[role=navigation]').length, h1Count: document.querySelectorAll('h1').length } };
}`;

// Lengthen short labels/headings by ~factor and pad long numbers, to see whether the layout survives real content.
const PERTURB = `(factor) => {
  let changed = 0;
  for (const el of document.body.querySelectorAll('*')) {
    const nodes = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim() && n.textContent.trim().length <= 60);
    for (const n of nodes) {
      const t = n.textContent, core = t.trim();
      const extra = Math.max(1, Math.ceil(core.length * (factor - 1)));
      const grown = /^[\\d.,%$€£\\s-]+$/.test(core) ? core + '0'.repeat(extra) : core + ' ' + core.slice(0, extra).replace(/\\s+$/, '') + 'x'.repeat(Math.max(0, extra - core.length));
      n.textContent = t.replace(core, grown); changed++;
    }
  }
  return changed;
}`;

const key = (v) => `${v.invariant}|${v.selector}`;

/**
 * @param {object} open  openPage() result for the candidate HTML
 * @param {object} o
 * @param {number[]} [o.widths]       viewport widths to test (declared by the product, not by the SVG)
 * @param {number}   [o.height]
 * @param {number}   [o.perturbFactor] text growth factor; 0 disables the perturbation pass
 */
export async function checkRobustness(open, { widths = [1120, 1280, 1440], height = 832, perturbFactor = 1.2 } = {}) {
  const perWidth = [];
  const violations = [];
  for (const w of widths) {
    await open.page.setViewportSize({ width: w, height });
    const r = await open.page.evaluate(`(${LAYOUT})()`);
    perWidth.push({ width: w, violations: r.violations.length });
    for (const v of r.violations) violations.push({ ...v, width: w, phase: 'baseline' });
  }
  await open.page.setViewportSize({ width: widths[0] ?? 1280, height });
  const sem = await open.page.evaluate(`(${SEMANTIC})()`);
  for (const v of sem.violations) violations.push({ ...v, width: null, phase: 'semantic' });

  let perturbation = { tested: false };
  if (perturbFactor > 1) {
    const changed = await open.page.evaluate(`(${PERTURB})(${perturbFactor})`);
    const introduced = [];
    for (const w of widths) {
      await open.page.setViewportSize({ width: w, height });
      const r = await open.page.evaluate(`(${LAYOUT})()`);
      const before = new Set(violations.filter((v) => v.phase === 'baseline' && v.width === w).map(key));
      for (const v of r.violations) if (!before.has(key(v))) { const rec = { ...v, width: w, phase: 'text-perturbation' }; introduced.push(rec); violations.push(rec); }
    }
    perturbation = { tested: true, factor: perturbFactor, textNodesChanged: changed, newViolations: introduced.length };
  }
  const severity = (v) => (v.invariant === 'no-whole-page-svg' || v.invariant === 'no-horizontal-overflow' ? 'critical' : 'high');
  return {
    schema: 'cvc-robustness/v0.1',
    status: violations.length ? 'fail' : 'pass',
    widths, perWidth, perturbation, semanticInfo: sem.info,
    violations: violations.map((v) => ({ ...v, severity: severity(v) })),
    contract: ['no-horizontal-overflow', 'no-overlapping-text-or-controls', 'no-clipped-essential-content', 'stable-reading-order', 'img-has-alt', 'control-has-name', 'link-has-href', 'input-has-label', 'heading-order', 'no-whole-page-svg'],
    note: 'Invariant checks only. Visual fidelity at other widths is not asserted because a static SVG defines none. position:absolute is not itself a violation.',
  };
}
