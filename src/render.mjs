// Stage 0: locked rendering contract. Same browser settings for reference (SVG) and candidate (HTML).
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// Width/height straight from the PNG IHDR so dimension gating needs no decoder.
export function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// Never pad or crop: a mismatch means the comparison is invalid.
export function assertSameDimensions(a, b) {
  const sa = pngSize(a.png), sb = pngSize(b.png);
  if (sa.width !== sb.width || sa.height !== sb.height) {
    const err = new Error(`screenshot dimensions differ: ${sa.width}x${sa.height} vs ${sb.width}x${sb.height}`);
    err.code = 'CVC_DIMENSION_MISMATCH';
    throw err;
  }
}

const LOCK_CSS = `
  *, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }
  html { scrollbar-width: none !important; }
  ::-webkit-scrollbar { display: none !important; }
`;

const VISIBLE_GEOMETRY = `(() => {
  const NON_RENDERED = 'defs,clipPath,mask,marker,pattern,symbol,linearGradient,radialGradient,filter,title,desc,metadata,style';
  const out = [];
  document.querySelectorAll('path,rect,circle,ellipse,line,polyline,polygon,image,use,text').forEach((el, i) => {
    if (el.closest(NON_RENDERED)) return;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return;
    }
    const r = el.getBoundingClientRect(); // screen space, deliberately unrounded
    if (r.width === 0 && r.height === 0) return;
    out.push({ index: i, tag: el.tagName.toLowerCase(), id: el.id || null, x: r.x, y: r.y, width: r.width, height: r.height });
  });
  return out;
})()`;

export async function launch() {
  return chromium.launch({ args: ['--font-render-hinting=none', '--disable-lcd-text'] });
}

/**
 * Open one document under the lock and leave the page open for further probing (knockouts, etc.).
 * Remote requests are blocked and reported; only file:/data:/blob: are allowed.
 */
export async function openPage(browser, file, { width = 1280, height = 832, dpr = 1 } = {}) {
  const context = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: dpr, colorScheme: 'light',
    reducedMotion: 'reduce', locale: 'en-US', timezoneId: 'UTC', javaScriptEnabled: true,
  });
  const page = await context.newPage();
  const blocked = [], failed = [], errors = [];
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (/^(file|data|blob):/.test(u)) return route.continue();
    blocked.push(u);
    return route.abort();
  });
  page.on('requestfailed', (r) => { if (!blocked.includes(r.url())) failed.push(r.url()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(pathToFileURL(file).href, { waitUntil: 'load' });
  // addStyleTag needs <head>, which standalone SVG documents lack.
  await page.evaluate((css) => {
    const root = document.documentElement;
    const style = document.createElementNS(root.namespaceURI, 'style');
    style.textContent = css;
    root.appendChild(style);
  }, LOCK_CSS);
  const state = await page.evaluate(async () => {
    await document.fonts.ready;
    const imgs = [...document.images];
    await Promise.all(imgs.map((i) => i.decode().catch(() => {})));
    return {
      fonts: [...document.fonts].map((f) => ({ family: f.family, weight: f.weight, status: f.status })),
      brokenImages: imgs.filter((i) => !i.complete || i.naturalWidth === 0).map((i) => i.currentSrc),
      scroll: { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight },
    };
  });
  const screenshot = () => page.screenshot({ type: 'png', animations: 'disabled', caret: 'hide', scale: 'device' });
  return { page, context, screenshot, blocked, failed, errors, state, file, width, height, dpr };
}

export async function render(browser, file, { width = 1280, height = 832, dpr = 1, geometry = false } = {}) {
  const op = await openPage(browser, file, { width, height, dpr });
  const png = await op.screenshot();
  const geom = geometry ? await op.page.evaluate(VISIBLE_GEOMETRY) : undefined;
  const version = browser.version();
  await op.context.close();
  const { state, blocked, failed, errors } = op;

  const size = pngSize(png);
  const expected = { width: Math.round(width * dpr), height: Math.round(height * dpr) };
  return {
    png,
    geometry: geom,
    manifest: {
      schema: 'cvc-render-manifest/v0.1',
      browser: `Chromium ${version}`,
      file, viewportCssPx: { width, height }, deviceScaleFactor: dpr,
      expectedPhysical: expected, physical: size,
      dimensionsVerified: size.width === expected.width && size.height === expected.height,
      pageScrollCssPx: state.scroll, fonts: state.fonts, brokenImages: state.brokenImages,
      blockedRequests: blocked, failedRequests: failed, pageErrors: errors,
      pngSha256: sha256(png),
    },
  };
}
