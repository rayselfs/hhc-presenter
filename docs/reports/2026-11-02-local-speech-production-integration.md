# Local speech production integration — 2026-11-02

## Authorized delivery boundary

Continue the original engineering plan, preserve Chinese Turbo / English Small, leave strong-noise experiments disabled, check CI and merge if green. No version tag, release, or production publication. Human recording labels remain user-owned. This report distinguishes source integration from release/hardware acceptance.

## Implemented path

- Bundled resident whisper.cpp C++ engine replaces the development Python dependency. Pinned engine source archive/hash, static packaging, embedded macOS Metal shaders; Windows CPU backend. No localhost server or runtime download.
- Chinese uses large-v3-turbo q5_0 with the measured covered-context rule; English uses Small with the measured short Bible prompt. Language selection is explicit. No auto-language or stronger-noise gain, guard, retry, or VAD experiments.
- App-owned model installation verifies exact bytes/SHA-256 before atomic activation. Download progress, cancel/retry, repair/removal, free-space checks, startup verification, and install/remove exclusion are present. The user supplies no directory or config.
- Main-window typed IPC validates language/session/PCM; one inference at a time. Stop cancels pending work, idle engines expire, old child output cannot revive a session. Suspend, device changes, hidden pages, manual navigation/search, and translation changes release capture and suppress stale results.
- Azure/GCP adapters, credentials API, SDKs, old model-directory protocol and download UI are removed. Only known retired credential files/keys are deleted; arbitrary old model directories remain untouched. Preference migration retains language and microphone without secrets.
- Browser recognition requires confirmed on-device support and an installed selected-language pack. Unsupported configurations keep manual Bible search and never silently send audio remotely.
- Shared traditional-Chinese/number normalization is used by index/query; cache format 2 rebuilds old indexes. Speech uses bounded approximate candidate recall followed by measured character/word and pronunciation scoring. Manual search keeps its existing exact-query behavior.
- The old default one-hour cloud cost cutoff is removed; explicit custom stop preferences remain available. An old value equal to the retired 60-minute default resets to unlimited, and the operator can explicitly reselect 60 minutes.
- Candidate navigation does not project. Manual actions cancel follow; next/previous projection resumes the committed passage rather than an uncommitted preview.

## Evidence

### Frozen transcript replay

The opt-in product parity test loads only the synthetic benchmark corpus and exercises the actual production index handler and locator. It is not a new ASR benchmark or a blind validation set.

| Language | Rows | Reference correct | Quotation correct | Negative controls | New wrong / lost correct |
| -------- | ---: | ----------------: | ----------------: | ----------------: | -----------------------: |
| Chinese  |  505 |           212/292 |            90/100 |                62 |                    0 / 0 |
| English  |  332 |           195/200 |             72/80 |                52 |                    0 / 0 |

The Chinese total also contains 51 compatibility/mixed rows; these are not added to the main reference denominator. English sample selection differs from prior aggregate reports; the model and prompt are unchanged. The production replay preserves every previously correct decision and produces no wrong decision in this corpus. This does not establish 98% Chinese accuracy or zero real-world false positives.

An initial strict-AND search integration lost 59 quotation decisions. Speech-only approximate candidate recall fixed those losses without changing the frozen score/margin thresholds or weakening ordinary manual search. English similarity compares word tokens, not characters. This initial failed result is retained in development logs; only the corrected replay is accepted.

### Native and UI checks

The native smoke runner verifies model ready, a known synthetic citation, digital silence, a second request and clean process shutdown for both models. First local smoke: Chinese 947 ms / English 558 ms native inference; startup is separately measured and excluded from utterance latency. This is not minimum-hardware acceptance.

The product-flow runner uses a temporary app profile, verified model files, real native IPC/AudioWorklet and real-time synthetic loopback. Only Bible content transport and the microphone source are fixture-controlled. It measures source last nonzero sample to a visibly positioned verse. Corrected real-time replay: 5 Chinese and 4 English positive controls all visibly located; Chinese maximum 2.690 seconds, English maximum 1.523 seconds. See the adjacent `2026-11-02-local-speech-product-flow.json`. These selected regression cases do not replace the full accuracy denominator or negative/audio acceptance.

A measurement-observer race in the initial UI harness produced stale/negative timestamps and overlapping fixtures. Those timings are rejected; the corrected runner isolates the current target and validates displayed reference and timestamp ordering.

### Distribution and website budget

Model/runtime files are not website assets. OpenCC imports are restricted to the simplified-to-traditional dictionary path. The renderer and Worker each embed normalization data; measured PWA precache is 5.03 MiB. Its explicit cap is increased by 256 KiB (5.00 to 5.25 MiB), while the existing individual-JS and font budgets remain unchanged. Development-only pilot UI is lazy and not precached.

## Release gates still open

- Human-labelled recordings, actual microphone/room behavior, and strong-noise acceptance. Automatic endpointing currently requires digital silence; ordinary microphone background audio uses Finish utterance. Strong-noise automatic following is not enabled.
- Windows 11 Intel i7 (generation unspecified), 32 GB physical-device latency; hosted CI proves native build/execution only.
- Signed/notarized macOS and signed Windows installers; current repository signing policy is unchanged.
- Two-hour microphone/media/projection coexistence and false-positive soak; platform cold/warm repetitions and minimum hardware resource budgets.
- Browser/version-specific Chinese/English local language-pack and offline real-microphone qualification. Unsupported environments remain explicitly unavailable.
- Ranges, chapter-only references and relative verse commands produce operator-confirmed suggestions. Relative commands require an explicit reference accepted in the same active capture within 30 seconds; stopping/manual navigation/language/translation changes discard that capture. Incomplete or self-correcting utterances never guess a verse. Automatic navigation retains the measured grammar; these extensions need separate audio qualification before automatic use.

These are retained release/Feature acceptance items. Source merge must not close the overall production-acceptance Feature or imply an authorized release.
