// Stage 2a: visual-component proposals and causal knockout footprints.
// A component is a *proposal*; whether it matters is decided by the footprint it actually paints.
import { PNG } from 'pngjs';

const TAG = 'data-cvc-id';

// Runs in the page. Tags proposed components and returns their static description.
const PROPOSE = `(kind) => {
  const NON_RENDERED = 'defs,clipPath,mask,marker,pattern,symbol,linearGradient,radialGradient,filter,title,desc,metadata,style,script,head';
  const DRAWABLE = 'path,rect,circle,ellipse,line,polyline,polygon,image,text';
  const visible = (el) => {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false;
    }
    return true;
  };
  const pathOf = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      const i = [...n.parentElement.children].indexOf(n) + 1;
      parts.unshift(n.tagName.toLowerCase() + ':nth-child(' + i + ')');
    }
    return parts.join(' > ');
  };
  const out = [];
  const add = (el, why) => {
    const r = el.getBoundingClientRect();
    const id = kind + ':' + out.length;
    el.setAttribute('${TAG}', id);
    out.push({ id, selector: pathOf(el), tag: el.tagName.toLowerCase(), why,
      bbox: { x: r.x, y: r.y, width: r.width, height: r.height } });
  };

  if (kind === 'svg') {
    const root = document.documentElement;
    const walk = (el) => {
      for (const c of el.children) {
        if (c.matches(NON_RENDERED) || !visible(c)) continue;
        if (c.tagName.toLowerCase() === 'g') {
          const drawables = c.querySelectorAll(DRAWABLE).length;
          if (!drawables) continue;
          add(c, 'group');
          // Also propose children of multi-drawable groups so a failing group can be subdivided.
          if (c.children.length > 1) walk(c);
        } else if (c.matches(DRAWABLE)) {
          add(c, 'drawable');
        } else walk(c);
      }
    };
    walk(root);
  } else {
    const PAINTS = (el, cs) => {
      if (el.matches('img,svg,canvas,video,input,button,select,textarea,hr')) return 'replaced-or-control';
      if (parseFloat(getComputedStyle(el).opacity) === 0) return null;
      const bg = cs.backgroundColor;
      if (bg && !/rgba\\(0, 0, 0, 0\\)|transparent/.test(bg)) return 'background';
      if (cs.backgroundImage !== 'none') return 'background-image';
      for (const s of ['Top', 'Right', 'Bottom', 'Left']) {
        if (parseFloat(cs['border' + s + 'Width']) > 0 && cs['border' + s + 'Style'] !== 'none' && !/rgba\\(0, 0, 0, 0\\)/.test(cs['border' + s + 'Color'])) return 'border';
      }
      if (cs.boxShadow !== 'none') return 'shadow';
      for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim()) return 'text';
      return null;
    };
    const walk = (el) => {
      for (const c of el.children) {
        if (c.matches(NON_RENDERED) || !visible(c)) continue;
        const why = PAINTS(c, getComputedStyle(c));
        if (why) add(c, why);
        if (!c.matches('img,svg,canvas,video,input,button,select,textarea')) walk(c);
      }
    };
    const body = document.body;
    const bodyWhy = PAINTS(body, getComputedStyle(body)) ?? PAINTS(document.documentElement, getComputedStyle(document.documentElement));
    if (bodyWhy) add(body, 'page-' + bodyWhy);
    walk(body);
  }
  return out;
}`;

export async function proposeComponents(page, kind /* 'svg' | 'html' */) {
  return page.evaluate(`(${PROPOSE})(${JSON.stringify(kind)})`);
}

// Sum of absolute channel differences above this counts as "this pixel changed".
export const DEFAULT_FOOTPRINT_THRESHOLD = 6;

function footprintOf(base, other, threshold) {
  const idx = [];
  let minX = base.width, minY = base.height, maxX = -1, maxY = -1;
  for (let p = 0, i = 0; p < base.width * base.height; p++, i += 4) {
    const d = Math.abs(base.data[i] - other.data[i]) + Math.abs(base.data[i + 1] - other.data[i + 1]) + Math.abs(base.data[i + 2] - other.data[i + 2]);
    if (d > threshold) {
      idx.push(p);
      const x = p % base.width, y = (p / base.width) | 0;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  return {
    indices: Uint32Array.from(idx),
    area: idx.length,
    bbox: idx.length ? { x0: minX, y0: minY, x1: maxX, y1: maxY } : null,
  };
}

// Suppress a component's own painting while keeping layout. The page background propagates to the
// canvas, so hiding <body> would not remove it; clear html/body backgrounds instead.
async function suppressed(page, comp, mode, screenshot) {
  const sel = `[${TAG}="${comp.id}"]`;
  const pageBg = comp.why.startsWith('page-');
  const prev = await page.evaluate(([s, m, pbg]) => {
    const targets = pbg ? [document.documentElement, document.body] : [document.querySelector(s)];
    const olds = targets.map((el) => el.getAttribute('style'));
    for (const el of targets) {
      if (pbg) { el.style.setProperty('background', 'none', 'important'); continue; }
      el.style.setProperty(m === 'opacity' ? 'opacity' : 'visibility', m === 'opacity' ? '0' : 'hidden', 'important');
    }
    return olds;
  }, [sel, mode, pageBg]);
  try {
    return PNG.sync.read(await screenshot());
  } finally {
    await page.evaluate(([s, olds, pbg]) => {
      const targets = pbg ? [document.documentElement, document.body] : [document.querySelector(s)];
      targets.forEach((el, i) => { if (olds[i] === null) el.removeAttribute('style'); else el.setAttribute('style', olds[i]); });
    }, [sel, prev, pageBg]);
  }
}

/**
 * Knock each component out (opacity:0 keeps layout), screenshot, and record which pixels changed.
 * For HTML, a second visibility:hidden pass flags knockouts that depend on the suppression method.
 * `open` is an openPage() result.
 */
export async function knockouts(open, comps, { threshold = DEFAULT_FOOTPRINT_THRESHOLD, crossCheck = false, max = 200 } = {}) {
  const base = PNG.sync.read(await open.screenshot());
  const warnings = [];
  if (comps.length > max) warnings.push(`only the first ${max} of ${comps.length} proposals were knocked out`);
  const out = [];
  for (const c of comps.slice(0, max)) {
    const fp = footprintOf(base, await suppressed(open.page, c, 'opacity', open.screenshot), threshold);
    const rec = { ...c, footprint: fp, compositionSensitive: false };
    if (crossCheck) {
      const alt = footprintOf(base, await suppressed(open.page, c, 'visibility', open.screenshot), threshold);
      // Descendants may override visibility, so only flag when painted area differs materially.
      rec.compositionSensitive = Math.abs(alt.area - fp.area) > 0.05 * Math.max(alt.area, fp.area, 1);
    }
    out.push(rec);
  }
  return { width: base.width, height: base.height, components: out, warnings };
}
