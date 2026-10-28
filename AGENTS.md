# AGENTS.md: using CVC from a coding agent

Goal: make generated HTML/CSS match a reference SVG at 1280×832 without breaking layout at other widths.

## Loop

1. Generate or edit the candidate HTML.
2. `node src/accept.mjs <ref.svg> <cand.html> out` and read `out/cvc-summary.json`.
3. If `accepted` is true, stop. If not, fix `defects[0]` only:
   - `geometry`: run its `suggestedCommand` (`repair.mjs`), then apply the printed CSS patch to your source.
   - `missing`: add an element painting at `boxCssPx`. `extra`: remove the candidate element.
   - `residual`: run `compare.mjs --features --text` and inspect the crops for the listed boxes.
   - `robustness`: replace fixed pixel widths with fluid constraints; verify at 1120, 1280 and 1440.
4. Regenerate and rerun. Keep a change only if the verdict improves and no critical gate regresses. Stop after a small fixed number of iterations and report what remains.

## Rules

- Signed values are candidate minus reference, in CSS px. A positive `dx` means the candidate is too far right.
- Never claim exact text or fonts from outlined SVG paths. Use real text copy only if the user supplied it.
- Do not treat flat component IDs as ownership when objects overlap; respect `ambiguous: true` and ask for review.
- A high aggregate similarity never overrides a failing critical gate.
- `notTested` and `needs_review` mean the tool abstained. Say so; do not report them as passes.
- `thresholdsCalibrated: false` means an accept is provisional.
- `repair.mjs` only prints a patch. You apply it to the source, not to a scanned or reference file.
- Do not skip, loosen or delete tests or thresholds to get a pass.

## Verify the tool itself

`npm test` and `npm run bench` (expect 0 false accepts, 0 false rejects).
