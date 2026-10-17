# Dependency Security Review

Date: 2026-08-22
Scope: v2.2.2 release closure
Command: `npm audit --audit-level=low`

## Result

A clean `npm ci` followed by the full dependency audit reports 0 vulnerabilities.
This includes both production and development dependencies.

The previously accepted advisory paths were closed by:

| Root/path                                    | Resolution                                                                                                           |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `@xenova/transformers`                       | Replaced with `@huggingface/transformers` 3.8.1; patched `sharp` 0.35.3 is enforced until upstream widens its range. |
| `electron-vlc-player` -> `@electron/rebuild` | Enforced rebuild 4.2.0, removing the vulnerable rebuild 3 / tar 6 toolchain.                                         |
| `electron`                                   | Upgraded to 41.10.6, outside the reported affected range and closest to the VLC-validated Electron line.             |
| `pdfjs-dist`                                 | Upgraded to 6.2.108; `@aiden0z/pptx-renderer` 1.2.4 supports PDF.js 6.                                               |
| Compatible transitive advisories             | Updated through the lockfile with `npm audit fix` without `--force`.                                                 |

## Release gate

The lockfile must reproduce with `npm ci`, and `npm audit --audit-level=low` must remain at
0 vulnerabilities. Any advisory is a failed release gate and requires a new review.

## 2026-10-17 gate wiring and current result

The release quality job now runs the documented `npm audit --audit-level=low`
command after dependency installation. Packaging and publication already depend on
that job, so any advisory or audit failure blocks them. No release workflow was run
while making this change.

A fresh full audit of the integrated lockfile reports **10 moderate affected
packages, with no high or critical findings**. Earlier remediation reduced the
2026-10-17 baseline of 24 affected packages (10 high and 14 moderate). The
2026-08-22 zero-advisory result above is historical, not the current gate state.
The audit exits nonzero; this gate is not bypassed with an allowlist, a higher
severity threshold, or production-only filtering.

The remaining paths include `global-agent`, `roarr` and `sprintf-js`, propagated
through Electron download/build tooling and ONNX runtime installation. npm suggests
major root dependency changes; those are not compatibility evidence. A tested
`global-agent` override was rejected after a valid HTTPS CONNECT proxy case failed
certificate hostname validation. Its zero-audit result does not justify merging a
known transport regression or disabling TLS verification.

Compatible remediation, a clean install and a repeated full audit remain required
before a future release. This wiring change does not resolve those findings or
claim that the affected paths are exploitable in Presenter. No release workflow,
tag or manual deployment is needed to review or merge this gate.
