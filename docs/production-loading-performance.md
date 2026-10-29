# Production loading performance — 30 October 2026

Base: deployed commit 9d3ac27df22468a20ac4da42d2e5b1c533656cb5. This includes the production Marrow external-image policy; GitHub main was behind that deployment.

Changes: render usable Home actions immediately after authentication, load only basic Home metadata plus exact continuation labels, keep navigation visible while route data loads, ignore obsolete route responses, overlap and deduplicate the initial QBank facet count, fetch module metadata in ordered 1,000-row pages with concurrency three, download immutable question payloads with concurrency four and unchanged SHA-256 validation, prioritize the first visible question image while explanations remain lazy, and preconnect to existing API/CDN hosts.

No database migration or data mutation. No image uploads, image substitutions, auth-policy changes, answer/scheduling changes, or full-question-bank fetches. The 2,932 repairs and 129 held placements remain database references untouched by this release.

## Measurements

Signed-in Chrome on the same host, baseline and candidate application assets served through the same interception mechanism, real production APIs. Desktop viewport 1280×900; mobile viewport 390×844 with a 150ms/1.6Mbps API-network simulation. This is not physical-phone benchmarking. Browser caching disabled. Single navigation sample per variant/device, so differences include normal API variability.

| Measure | Baseline | Candidate |
|---|---:|---:|
| Desktop first usable Home | 1,904ms | 955ms |
| Desktop populated Home summary | 1,907ms | 1,240ms |
| Mobile first usable Home | 2,297ms | 778ms |
| Mobile populated Home summary | 2,299ms | 2,067ms |
| Desktop QBank form | 2,364ms | 933ms |
| Desktop QBank count ready | 6,961ms | 2,265ms |
| Mobile QBank form | 3,337ms | 2,374ms |
| Mobile QBank count ready | 8,115ms | 2,511ms |
| Home API requests observed | 19 | 14 |
| QBank API requests observed | 16 | 14 |

Independent direct production baseline: Home 1,858–2,020ms; QBank count readiness 5,895–7,976ms. The user's 20-second Home load was not reproduced. Home had no observed >50ms JavaScript long tasks in those two baseline runs. Auth took 159–381ms. QBank's facet RPC took 3,985–6,051ms, and module metadata used eight sequential pages. The RPC's implementation is unchanged; overlapping it reduces critical-path wait, but lower sampled RPC latency must not be attributed entirely to this patch.

Core BTR uncached read-only sample: ten repaired questions, twelve repaired placements. Data hydration 663ms → 236ms, one → four concurrent payload downloads. Exact question text, explanation, options, correct keys and original repaired image URLs verified, all twelve repaired images loaded. An earlier run showed 5,527ms → 425ms but is excluded as the primary comparison because browser caching was not explicitly disabled.

## Validation and limits

Ten existing focused model/media/study suites plus the new concurrency/deduplication test pass. Rapid Home→QBank and Home→Test navigation with delayed Home responses passes. Global Importance, Analytics, Incorrect/Saved and History screens render without browser errors. Mobile Home has no horizontal overflow. Browser checks recorded no learner writes. Tests do not submit real answers or alter sessions; existing deterministic tests cover answer persistence, submission, recall rules and timers.

The older standalone Recall performance harness initially could not resolve Playwright and is not counted as a pass. The new signed-in browser tests supply the measured loading evidence instead.

Remaining: facet SQL latency varies, full module metadata is still fetched for builders, external original images can be large/slow, and authentication must finish before personalized UI appears. No promise of a subsecond fully populated page on every device/network.

Evidence lives alongside the isolated checkout in artifacts/production-performance-20261030: baseline-timings.json, comparison.json, core-comparison-uncached.json, navigation-check.json, tests.json, additional-tests.json, and screenshots. Deployment and direct post-release measurements are recorded separately after release.

Rollback: restore Vercel deployment dpl_HwtVKYe1AEW5x1GDFgkQzQPRuK2z. There are no database changes to undo.
