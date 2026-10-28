# SVG-To-HTML: Causal Visual Comparator (CVC)

CVC compares a reference SVG (for example a 1280×832 Figma export) with generated HTML/CSS and reports
measurements a coding agent can act on. It is deterministic and local: no LLM calls, no network, and it
never edits your candidate files.

## Install

```
npm install            # pixelmatch, pngjs; Playwright is a peer dependency
npx playwright install chromium   # if no Chromium is available
npm test               # 45 tests
npm run bench          # 6 synthetic cases, checks for false accepts and rejects
```

## Commands

| Command | Purpose |
| --- | --- |
| `node src/accept.mjs ref.svg cand.html [outDir] [--width=1280 --height=832 --widths=1120,1280,1440]` | Full analysis and verdict. Writes `cvc-acceptance.json` and `cvc-summary.json`. Exit code 1 unless accepted. |
| `node src/compare.mjs ref.svg cand.html [outDir] [--correspond --features --text]` | Detailed report: residual clusters, component matching, shape/edge/gradient/shadow features, text lines. Writes `cvc-report.json`, PNGs and `crops/`. |
| `node src/repair.mjs ref.svg cand.html --selector=SEL --props=left,width --box=x,y,w,h` | Probes one element's CSS in a live page and prints a verified patch. Writes `cvc-repair.json`. |
| `node src/benchmark.mjs` | Runs `bench/cases/`. |

## Outputs

- `cvc-summary.json` (`cvc-agent-summary/v0.1`): start here. A ranked `defects[]` list, each with selectors,
  signed measurements (candidate minus reference, CSS px), and a `suggestedCommand` or plain-language `action`.
  Also `verdict`, `thresholdsCalibrated`, `notTested`, `nextStep`.
- `cvc-acceptance.json`: every gate (render, critical-objects, component-geometry, measurement-confidence,
  residual-foreground, robustness) with its evidence. Verdicts: `accepted`, `rejected`, `needs_review`, `incomplete`.
- `cvc-report.json`: raw measurements from `compare.mjs`.

## How it works

Two witnesses: appearance (pixel residuals in Lab ΔE76, clustered into regions) and causal knockouts
(hide a component with `opacity:0` and see which pixels change). Components are matched by painted
footprint, then measured for geometry, corner radii, borders, gradients, shadows and text lines. Rendering is
locked (pinned Chromium, fixed DPR, no animation, remote requests blocked, fonts awaited) and a size
mismatch is a hard failure, never padded.

## Known limits

- Acceptance thresholds are uncalibrated defaults; the verdict says so. Calibrate on real data before trusting an accept.
- Fixtures are synthetic. Knockouts on a large real SVG take about 22 s.
- Outlined text: the tool measures ink lines and shapes but never claims exact words or fonts from outlines.
- Under heavy compositing, flat object IDs are not treated as ownership; ambiguous matches are flagged for review.
