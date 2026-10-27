// Full single-viewport analysis: render lock -> residuals -> correspondence -> robustness -> acceptance.
import { launch, render, openPage, assertSameDimensions } from './render.mjs';
import { compareResiduals } from './residual.mjs';
import { proposeComponents, knockouts } from './components.mjs';
import { matchComponents } from './match.mjs';
import { checkRobustness } from './robustness.mjs';
import { evaluateAcceptance } from './acceptance.mjs';
import { resolve } from 'node:path';

export async function analyze(refFile, candFile, { width = 1280, height = 832, dpr = 1, widths = [1120, 1280, 1440], perturbFactor = 1.2, thresholds = {}, browser: given } = {}) {
  const t0 = Date.now();
  const browser = given ?? (await launch());
  try {
    const lock = { width, height, dpr };
    const ref = await render(browser, resolve(refFile), lock), cand = await render(browser, resolve(candFile), lock);
    assertSameDimensions(ref, cand);
    const residual = compareResiduals(ref.png, cand.png, { dpr });
    const ko = [];
    for (const [file, kind] of [[refFile, /\.svg$/i.test(refFile) ? 'svg' : 'html'], [candFile, 'html']]) {
      const op = await openPage(browser, resolve(file), lock);
      ko.push(await knockouts(op, await proposeComponents(op.page, kind)));
      await op.context.close();
    }
    const correspondence = matchComponents(ko[0], ko[1], { dpr });
    const rp = await openPage(browser, resolve(candFile), lock);
    const robustness = await checkRobustness(rp, { widths, height, perturbFactor });
    await rp.context.close();
    const manifests = { reference: ref.manifest, candidate: cand.manifest };
    const acceptance = evaluateAcceptance({ manifests, residual, correspondence, robustness }, thresholds);
    return { manifests, residual, correspondence, robustness, acceptance, runtimeMs: Date.now() - t0 };
  } finally {
    if (!given) await browser.close();
  }
}
