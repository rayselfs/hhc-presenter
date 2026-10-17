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

## 2026-10-17 gate wiring and pre-remediation result

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

## 2026-10-17 transport-preserving logger remediation

The reviewed logger-only candidate overrides `global-agent`'s `roarr` dependency to
3.3.0 and retains `global-agent` 3.0.0 and its proxy transport. This removes the
`sprintf-js` path without accepting the rejected global-agent 4.1.3 transport
regression. A fresh own `npm ci --prefer-offline` and full `npm audit` report zero
vulnerabilities across production and development dependencies. npm skipped nine
dependency install scripts; the root postinstall and VLC rebuild did execute. This
does not establish real ONNX/Whisper model inference.

The actual installed baseline and candidate both pass HTTP proxy, HTTPS CONNECT
with a trusted synthetic origin certificate, and HTTP/HTTPS NO_PROXY, through both
direct bootstrap and the Electron downloader initialization. Each entry runs with
logging disabled and enabled. Enabled logging also serializes response headers, a
TLS CA Buffer array and request/socket errors. TLS certificate verification remains
enabled. The repository's four installed-dependency cases retain the HTTP success,
reset failure and enabled/disabled JSON logging contract in normal unit CI; those
cases alone do not cover the separate local HTTPS matrix. No real account, network
credentials, Linux CUDA download or Windows proxy installation is claimed.

roarr 3 changes serialization and its timestamp source, so the override is exact
and limited to the actual proxy caller. The independent review checked its default
export, child and log-level APIs, global state, actual caller arguments and lock
changes. All added transitive packages belong to the logger graph; this is not a
package-size optimization. The full audit gate and TLS checks are unchanged.

The candidate's final integrated package and exact-head CI results must be recorded
before merge. A zero audit is dependency metadata evidence, not a release or
complete security assessment. No tag, release or manual deployment is required.
