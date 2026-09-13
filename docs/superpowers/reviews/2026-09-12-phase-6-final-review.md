# Phase 6 — whole-branch final review record

Branch `phase-6`, base `99a852d` (`main`, after PR #6) → reviewed at `3018e71` (38 commits, 149 files,
~18.9k insertions: the Phase 5 hand-off cherry-pick `0449596`, the plan `266532f`, Tasks 1–10 with
their seven one-round fix loops), fixed through `7a3b77f`, then `024ff65` (the re-review's two
one-line Low residuals) and the close-out commit. **Four reviewers on the most capable model, one area
each** — A: `@aesa/llm` + `@aesa/crypto` + `@aesa/contracts` + `@aesa/core` + `@aesa/queue`; B:
`@aesa/db` + `apps/worker`; C: `apps/api` + `apps/app`; D: the cross-cutting seams (the contracts
BETWEEN packages, the invariants that span them, the spec's Verify list as a whole, every controller
ruling, and the docs/env drift the close-out had to close) — each pointed at the execution ledger's
deferred minors for triage. Gate at the reviewed commit `3018e71`: full gate exit 0, 580 worker tests.
After the wave and the close-out, with `S3_*` exported: **2,599 tests** plus 4 conditional test-kit
skips, **25 web routes**, `db:check` clean, the Playwright signup smoke green. Raw output at the end
of this record.

## Verdict

Approved for the PR after the fix wave. **Critical: none, in any area.** Important: **12** across the
four reports, deduplicated into **ten changes** — all landed in ONE wave by ONE implementer
(`f5df280` llm + crypto + queue, `a079dde` contracts + api + app, `7a3b77f` worker + db) and verdicted
**all addressed** by the scoped re-review over `3018e71..7a3b77f`, with no new Critical or Important
breakage and four Low residuals (below). Every reviewer's verdict was "with fixes"; **no reviewer
would reverse any of the twenty-three execution-time rulings**, and D qualified exactly one (ruling 4,
DeepSeek) with a documentation obligation rather than a code change.

## What the branch-level review found

### Important, by area (all fixed in the wave)

**A — `@aesa/llm` / `@aesa/crypto` / `@aesa/contracts` / `@aesa/core` / `@aesa/queue`** (2)

- **`packages/llm/src/core/structured.ts:145` — a probe-raised `native` rung that the endpoint
  rejects hard-failed the draft instead of stepping down.** The late ruling (16) made
  `structuredOverride` apply in both directions and priced the risk as "one extra call before the
  ladder's json_mode rung catches it". The ladder did not catch it: rung 1 was a bare
  `await callRung('native','native')` with no `try`, and an OpenAI-compatible server that does not
  support `response_format: json_schema` answers **400**, which maps to `permanent` — not retryable,
  and not in `FALLBACK_CODES`, so there was no managed retry either. Every draft and triage on that
  credential would have failed to `agent_failed`. Reachable without anybody lying, because the probe
  verdict is stored per **credential** and applied to every **model** on it: a Groq credential probed
  on `llama-3.3-70b-versatile` (seeded `native`) raises the agent's triage model
  `llama-3.1-8b-instant`, which is seeded `json_mode`-only precisely because it is not expected to
  honour `json_schema`. Fixed per ruling 19: the ladder catches a `permanent` `LlmError` on the
  **native rung only** and continues to `json_mode` exactly as if native had returned `parsed: null`;
  every other code and every other rung propagates unchanged.
- **`packages/llm/src/core/probe.ts:72` — the one error path in the probe that skipped
  `scrubSecrets`, and its message is persisted and shown to the owner.**
  `new LlmError(String(err), 'permanent', false)` stringified an arbitrary throw verbatim into
  `ProbeResultView.error.message`, which `llm-probe.ts` writes WHOLE into
  `llm_credentials.last_probe` — api-visible metadata the Settings → AI card renders. A
  defence-in-depth gap rather than a demonstrated leak (no live path puts a key in a non-`LlmError`
  throw today), but it is the single owner-visible, DB-persisted string the phase introduces, and the
  Global Constraint is unconditional. Scrubbed.

**B — `@aesa/db` / `apps/worker`** (3)

- **`ticket.triage` had no `auth` landing at all** (`ticket-triage.ts:390–413`). The catch mapped the
  error to a run `errorCode` but hard-coded `needsOwnerReason: 'triage_failed'`; `markCredentialDead`
  and `notifyProviderHealth` were never called from this job. Triage is the FIRST job to touch a
  ticket, so it is the first to meet a revoked key — the observable sequence was two attempts burning
  the retry budget, the wrong owner-facing reason, no `provider_health` push, and the credential still
  reading `healthy` in Settings → AI for up to six hours until the re-probe sweep happened to run. The
  spec's Verify list says "a dead key routes tickets to Review **with the reason**"; that only held on
  the draft path. The E2E routed around it deliberately (scenario 4 arms the 401 *between* the triage
  call and the draft call), so nothing covered it.
- **With `fallback_to_managed` on, an `auth` failure was swallowed** (`ticket-draft.ts:731`,
  `&& !triedFallback`). `FALLBACK_CODES` includes `auth`, so a rejected tenant key is covered by the
  opt-in — and `triedFallback` then suppressed the kill-and-page branch entirely. This is the one
  configuration where the symptom is invisible to the owner: the draft lands, so nobody notices, while
  every subsequent ticket costs a failed BYOK call **plus a full managed draft billed to the platform
  allowance**. Deviation 7 asserts both halves and the implementation had silently resolved the
  tension in favour of the half that hides the problem. Fixed per ruling 20: kill and page **always**;
  only the ticket escalation is skipped when the fallback landed the draft.
- **The provider cache had no freshness in its key and `invalidate` is process-local**
  (`provider-resolver.ts:141,182–200`). On the shipped multi-replica topology the replica that runs
  `llm.probe` is usually not the replica that drafts, so after a probe narrowed a credential from
  `native` to `json_mode` every other replica kept asking for `json_schema` indefinitely. Not a
  confidence leak (the tier is re-read every `resolve`) and not yet a stale-key leak (the api mints a
  new credential row per connect), which is why it was Important and not Critical — but the cache is
  the one piece of Phase 6 state that is not re-derived per call, and it is the piece that holds a
  secret, and the code around it already anticipates a re-key. Keyed on
  `${credentialId}:${lastProbedAt}` with a 15-minute ceiling.

**C — `apps/api` / `apps/app`** (3)

- **An agent's first model-config row always counted as a model change, so a no-op "back to Managed
  AI" save demoted every Autopilot category** (`llm/service.ts:445`). `changed = !existing || …`, but
  an agent that has only ever run Managed AI HAS no `agent_model_config` row — that is deviation 2's
  design. So `!existing` made `changed` true for a byte-for-byte managed default, bumping
  `model_generation`, moving `stats.rollup`'s graduation window and demoting every category the
  workspace had spent weeks graduating, with the reason `model_changed` and a notification saying "the
  agent's model was changed", which was simply untrue. Reachable from the UI with **no warning**: on
  such an agent the Model card seeds `managed`, so tapping a connection and then "Managed AI" again
  leaves `dirty` true while `modelChanges` is false — the pre-save banner does not appear. Fixed to
  compare against the RESOLVED current config.
- **A `dead` credential was refused for EVERY byok save, which blocked the one remedy the product
  offers** (`llm/service.ts:423`). Refusing to newly *point* an agent at a rejected key is right; the
  same check fired when the agent was already on that credential and the owner was changing something
  else — and the something else an owner most wants at that exact moment is `fallbackToManaged`. The
  AI screen's own copy tells them so and the Model card offers the switch, and Save then returned
  `PRECONDITION_FAILED`. Fixed per ruling 21: refused only when the save selects a *different*
  credential.
- **Owner-facing copy was keyed on the api's exact English error sentences**, duplicated across
  `routers/llm.ts`, both screens and both screens' tests — and the app tests mock tRPC, so **nothing
  in CI failed if the api reworded a message**. It degraded silently to "Could not add that
  connection. Try again.", which is a dead end for `unsafe_url` — the one refusal only a different
  input can fix, and the single most important sentence on the screen. `data.code` could not
  substitute (`keys_not_provisioned` and `cap_reached` share `PRECONDITION_FAILED`). Fixed with
  `LLM_ERROR_MESSAGES` in `@aesa/contracts`.

**D — the cross-cutting seams** (4)

- **A fourth hand-rolled `needs_owner` landing that CLAUDE.md's Escalation rule does not sanction,
  with a dedupe key that contradicted the draft job's for the same reason**
  (`ticket-triage.ts:299–310`). CLAUDE.md enumerates exactly three grandfathered landings in that file
  and gives the reason: they also write the VERDICT columns in the same UPDATE. This one wrote no
  verdict columns — exactly the three fields `escalateTicket` writes — so nothing blocked routing it
  through the sanctioned entry. And the divergence was already real: this landing used the plain
  day-scoped `escalationDedupeKey(ticketId, day)` while `ticket.draft` used the reason-scoped
  `provider_unavailable:${ticketId}:${day}` for the SAME reason, so whether an owner is paged for a
  provider outage depended on which job met the dead key first. Routed through `escalateTicket` with
  the reason-scoped key; the rule stays at three.
- **The spec's BYOK stop-loss was unimplemented and unflagged** (`ticket-draft.ts:63,769`). Spec
  §Budgets: "stop-loss $0.40 managed / **30k output tokens BYOK**". Only the managed half existed, and
  a BYOK model with no `model_pricing` row records `cost_micros = 0` — so the dollar stop-loss was
  silently inert for exactly the models the spec wrote the token variant for. `grep -i "stop.loss"`
  over the plan returned nothing, making it an unrecorded spec gap rather than a considered
  narrowing. Implemented (`STOP_LOSS_BYOK_OUTPUT_TOKENS = 30_000`).
- **Activity read "$0.00" for a workspace spending real money on BYOK** (`routers/activity.ts:57`).
  Phase 6 correctly routed BYOK cost to `llm_cost_micros_byok` so a tenant's spend can never trip the
  platform's daily cap — but nothing was done at the read side, so a workspace fully on its own key
  saw exactly zero on the one screen an owner opens to ask "what is this costing me". Wrong on the
  first render, not a drift risk. Fixed per ruling 18: the headline sums both meters with a
  "$X.XX of this on your own provider keys" subtitle; the meter SEPARATION is untouched.
- **The resolver cache's freshness** — the same finding as B-I3, reached independently from the seam
  side, with the rotate-surface argument: the probe's store step is a `delete+insert` whose comment
  says "correct for a first connect AND a re-key", and the re-wrap's byte guard exists specifically
  for "an owner who re-keyed mid-probe". The moment a rotate surface exists, a replica that did not
  run that probe would keep calling the provider with the revoked key indefinitely.

### Two ledger minors ruled into the same wave

- `packages/crypto/src/ssrf/pinned-fetch.ts:174` silently dropped a non-string `init.body` and still
  sent the request, turning a body-less POST into a confusing 400. Now throws
  `PinnedFetchError('unsupported_body')`.
- `packages/queue/test/define-job.test.ts` had no unit test for `defineJob`'s `QUEUE_OPTIONS`
  default-resolution branch nor for the "no queue options" throw — the one behaviour Task 1 added to
  `defineJob`, and the thing that underwrites the four-places rule. Both added.

## The fix wave

Three commits, one implementer, grouped by package so they share one git index cleanly:

| Commit | Scope | Findings closed |
|---|---|---|
| `f5df280` | `llm`, `crypto`, `queue` | A-I1 (the native rung falls through), A-I2 (the probe's unscrubbed throw), ledger 63b (the dropped body), ledger 42 (the two `defineJob` tests) |
| `a079dde` | `contracts`, `api`, `app` | C-I1 (an honest `changed`), C-I2 (the dead-key remedy), C-I3 (`LLM_ERROR_MESSAGES`), D-I3 (the BYOK half of the cost tile) |
| `7a3b77f` | `worker`, `db` | B-I1 + D-I1 (triage's dead-key landings, through `escalateTicket`), B-I2 (the fallback that hid a rejected key), B-I3 + D-I4 (the freshness-keyed cache), D-I2 (the BYOK stop-loss) |

Each change carries its own covering test, named in the wave's report. The implementer noted two
things worth recording: `ResolvedModelConfig.credential.lastProbedAt` was added specifically to make
the cache key possible, and an unchanged first save writes `model_generation_at = agent.created_at`
rather than `now`, so an agent that never changed its model has no artificial window boundary. Full
gate at `7a3b77f`: exit 0, worker 586 / api 301 / app 458.

## The re-review, and the four Low residuals

The scoped re-review over `3018e71..7a3b77f` on the most capable model verdicted **all eleven wave
items addressed with no new Critical or Important breakage**, and left four Low residuals plus one
out-of-scope observation. Ruling 22: **no second fix wave** — none is load-bearing, and a dead key is
refused by the resolver at run time regardless.

- **(r1) `provider-resolver.ts`'s `keyByCredential` map was never trimmed on LRU eviction** — one dead
  string pair per eviction for the life of the process; no correctness effect. **Fixed** in the
  close-out commit `024ff65`: each cache entry now carries its own `credentialId` so the eviction can
  trim the reverse map, guarded so a credential already rebuilt onto a newer key keeps it.
- **(r2) the draft job's credential kill no longer carries the `!aborted` guard**, so an abort during
  an `auth` failure would map to transient. Implausible sequencing; **carried** in STATUS.
- **(r3) the token stop-loss keys off `config.mode` even when attempt 1 fell back to managed** — the
  only consequence is "no free redraft" on that run. **Carried** in STATUS.
- **(r4) `ticket.triage`'s docblock over-claimed** that all three grandfathered landings write the
  verdict columns; `triage_cap` does not — it is grandfathered by name in CLAUDE.md because it
  predates `escalateTicket`. **Fixed** in `024ff65`.
- **Out of scope, recorded:** under ruling 21 an agent already on a dead credential may also change
  its **model** on that key, which bumps the generation and demotes while the key is still rejected.
  **Carried** in STATUS; the resolver refuses the key at run time either way.

## The spec's Phase 6 Verify list, item by item (reviewer D)

| Spec Verify item | Proving test | Verdict |
|---|---|---|
| The drafting E2E passes against a mock OpenAI-compatible server **on every ladder step** | `apps/worker/test/e2e-phase6.test.ts` case 3 — (a) native, (b) json_mode with **no** native attempt after the probe narrows it, (c) `plain`, (d) prose → repair → extract, (e) refusal short-circuits; case 2 proves the full triage + draft chain on native. Unit backstops: `packages/llm/test/structured-none.test.ts`, `openai-compatible.test.ts` | **Proven** |
| Hostile base URLs (private IP, rebinding, redirect) refused | Write-time: `e2e-phase6.test.ts` case 7 — http, `https://10.0.0.1`, embedded credentials, a loopback-resolving hostname, each `unsafe_url` with no row, no secret, **no request**. Call-time: `packages/crypto/test/pinned-fetch-fn.test.ts` — http/IP-literal/private-resolving refused; re-resolved on EVERY call so a rebinding hostname is refused on the second request; a 3xx throws `PinnedFetchError(redirect_not_followed)` | **Proven** (both halves) |
| A dead key routes tickets to Review **with the reason** | `e2e-phase6.test.ts` case 4 — 401 mid-draft → credential `dead` with a scrubbed `last_error`, ONE `provider_health` page, ticket `needs_owner`/`provider_unavailable`, and the *next* inbound refused by the resolver before any run row or model call. Units: `ticket-draft.test.ts` 17c/17d, `llm-probe.test.ts`, `ticket-triage.test.ts` (the triage half added by the wave) | **Proven** |
| Contract suite green for **both** adapters | `packages/llm/test/contract.test.ts` runs `runProviderContract` (11 cases: plain call, best-rung structured, schema violation → `parsed: null` not a throw, refusal, 401/429-with-retry-after/500 mapping, key-never-in-the-message, aborted signal) over both the Anthropic and the OpenAI-compatible wires | **Proven** |

Phase 6 scope items checked beyond the Verify list, each with a named proving test: the
OpenAI-compatible adapter + presets; the four tables (including "`aesa_app` has NO privilege on the
secrets table" and `model_pricing` in `RLS_EXEMPT`); `llm.probe` with capability probes (13 cases
including the re-wrap byte guard, sticky `dead`, `none` → tier `limited`, metered under role `probe` /
mode `byok`); `llm.probe` in its four places (`queue-preflight.test.ts`); quality-tier confidence caps
(including E2E case 6's 0.9 × 0.6 = 0.54 < Eager 0.70 → no auto-send); graduation bars scaling with
tier; BYOK dashboards from `llm_calls`; Settings → AI + the per-agent override; and §Launch risks'
BYOK consent sentence (`testID="consent-sentence"`). The one item D marked **not yet written** at
review time was §Launch risks' DPA — this close-out's runbook, §6.

## Rulings verdict (reviewer D, against the spec)

All twenty-three execution-time rulings are listed in STATUS.md's Phase 6 record and in the plan's
"Rulings during execution". D read every one against the spec and **would reverse none**. The
load-bearing verdicts:

| Ruling | Verdict |
|---|---|
| Probe test 1 drives the RAW fake, not `withStructuredLadder` | **Ratify** — the probe's contract is "drive the raw adapter's rungs itself"; through the ladder it would test the ladder. |
| `push-routing.ts`'s `provider_health` entry is Task 5's edit, asserted by Task 9 | **Ratify** — verified one entry, asserted; no duplication. |
| `REASON_CHIP` keeps the short label, `REASON_SENTENCE` gets a sentence in its siblings' voice | **Ratify** — the sibling pattern was the right tiebreak. |
| Keep the DeepSeek catalog ids and pricing rows pending re-verification | **Ratify with a condition.** The reasoning is right — an unverified web claim should not drive a mid-phase churn, and a wrong id fails loudly (the probe refuses, the card shows `degraded`/`dead`). But the entire mitigation lived in a runbook that did not exist at HEAD. **The condition: a named, explicit line item, not a general sentence.** → runbook §4. |
| `runProviderContract` on `@aesa/llm/testing`; `withCauseMessage` to `core/shared.ts`; `structured-none.test.ts` | **Ratify** — the sub-path keeps vitest out of production graphs. |
| `createByokProvider` DEFAULTS `fetchFn` to `createPinnedFetch` | **Ratify — the most valuable ruling on the branch.** Verified on BOTH adapter branches; the resolver and the probe pass it explicitly too, so the default is belt-and-braces rather than the only guard. "SSRF at every call" must not depend on every caller remembering. |
| The four-deps shape, `'unknown'`, the `fetchFn?` seam | **Ratify** — `memory.capture` genuinely never chats; `'unknown'` is the honest health for a never-probed credential. |
| Task 5's two promoted minors (the re-wrap byte guard; no plaintext in a parse error) | **Ratify** — both are real; `readApiKey` and the byte guard are the code they produced, and both are right. |
| Task 6's fix round (the fallback's own idempotency key, per-attempt provenance, …) | **Ratify** — each is correctness of a recorded fact the rollup and cost screens read. |
| `confidence_breakdown.modelGeneration` is the AGENT's configured generation | **Ratify** — `stats.rollup` windows on `resolveModelConfig(...).modelGenerationAt`, never on the breakdown field, so the breakdown is provenance and the window is authoritative. The stated cost already applies to managed agents. |
| The in-transaction `llm.probe` enqueue | **Ratify** — it is the transaction's LAST statement, mirroring `mailbox.store-credentials`; a throwing enqueue takes the credential row with it, which is the property that matters (the sealed key rides the payload and nowhere else). |
| `agentsUsing` = `countDistinct(agent_id)` | **Ratify** — the plan's "config rows" wording would have double-counted every BYOK agent (draft + triage rows). Correctly caught. |
| Task 9's fix round (capped probe wait, card error state, `gcTime: 0`, required-field hint, Cancel) | **Ratify** — each is a UX dead end or a secrets-hygiene line; UX-first is this product's stated priority. |
| `probeTimedOut`'s banner kept | **Ratify** — accurate and actionable; gating on `armedAt` would hide a real never-probed connection. |
| **The spec wins over plan deviation 4** — the probe raises as well as narrows | **Ratify — and this is the right call.** The spec is explicit twice: `json_schema` is "treated as `json_mode` unless probe passes", and "presets are **overridden by** the stored probe result". Deviation 4's downward-only narrowing would have permanently fossilized a guess about someone else's endpoint. Verified in `probe.ts` (the rung table) and `registry.ts` (both directions, with Anthropic correctly exempt because its table is a fact, not a guess). The accepted cost — one refused `native` attempt per probe against a server lacking `json_schema`, plus one error row in `llm_calls` — is the correct price for discovering a capability instead of assuming it. E2E case 3(b) proves the narrowing direction and 3(a)/2 the raising one. |

## Residuals parked after the review (with rulings)

- **Structure and duplication, named for a third time:** the `src/drafts/learning.ts` split (ruled a
  "Phase 6 cleanup" by Phase 5's review and NOT done); `ticket-draft.ts` at ~1,021 lines, with
  `escalateProviderUnavailable`/`killCredential` belonging in `drafting/outcomes.ts`; `relativeTime`
  in four app files, `lookup()` in two, `meterValue` re-implemented in `ticket.draft`.
- **Behaviour the brief or a ruling mandated, recorded:** `probe.ts` reports chat ok on a refusal or
  an empty reply, so an endpoint that answers 200-with-nothing reads `healthy`; a probe against a
  server that refuses `json_schema` now costs three calls and lands one error row in `llm_calls`;
  `registry.ts`'s `preset.structuredOutput === 'none'` arm is unreachable; `guidance.suggest` ignores
  `resolved.fallback`, narrowing deviation 7's stated scope; an agent on a dead credential may change
  its model on it (ruling 21's accepted edge).
- **Hardening carried:** `provider-resolver.ts`'s `baseUrlFor` throws where the header promises a
  typed refusal; `llm.probe` builds its own limiter instead of sharing the resolver's per-credential
  slots; the probe's connect-store runs before the credential read, so a credential deleted in that
  window is an FK violation and a failed job after retries (the same shape as
  `mailbox.store-credentials`); the credential cap's count-then-insert is not atomic (soft cap,
  manager-only); two concurrent first saves both compute generation 1 (cosmetic);
  `llm-reprobe-sweep.ts`'s due-credential select has no `LIMIT` and enqueues serially;
  `loadModelPricing`'s dedupe picks by pattern length before `effective_from`;
  `scrubJobError` replaces the whole error, so a failed job's output loses the stack and the pg
  `constraint`/`table`; `err instanceof DrizzleQueryError` depends on one resolved copy of
  `drizzle-orm` across the workspace; `QUALITY_CAPS[tier]` yields `NaN` for a tier value outside the
  union (the tier arrives from a DB column, so `?? QUALITY_CAPS.limited` would fail safe); the OpenAI
  SDK would read `OPENAI_ORG_ID`/`OPENAI_PROJECT_ID` from the process env and send them to a
  CUSTOMER-supplied endpoint (none is set today; passing `organization: null, project: null` would
  make that independent of a future environment).
- **Cosmetic and coverage:** `scrubSecrets`' unanchored `sk-` over-redacts ordinary words;
  `structured.ts` computes the JSON schema twice on the plain→repair path and leaves zod's `$schema`
  key in the prompt; `openai-compatible/index.ts`'s `if (refusal)` treats an empty-string refusal as
  absent; the shared contract suite only ever exercises the `json_mode` rung and never `listModels`;
  `ProbeResult.probedAt`/`error.code` are free strings; `define-job.test.ts` still tests
  `scrubJobError` directly rather than `registerJob`'s catch wiring; `error-surface.test.ts` does not
  walk `./src/llm/service.ts` as its own entry point; `packages/llm` declares `@aesa/contracts` in
  `dependencies` though it imports it type-only; `agents.list` is an N+1 on a hot list query
  (documented and bounded); the backstop's arm (b) sweeps triage run rows at the DRAFT expiry
  threshold though `ticket.triage`'s queue expires at 120 s; `stats-rollup.ts`'s local
  `unchangedApprovals` shadows the `CategorySignals` field it filters; `createEnqueue`'s throwaway
  definition carries a dead `queue` option.
- **App polish:** `busy` disables Test/Remove on every card while one probe runs; the key field's
  `maxLength` 512 truncates silently (no catalog provider issues keys near that; dropping it and
  letting the zod parse fail visibly would be the cheap fix); Test on card B disarms card A's Remove;
  with two never-probed connections the within-cap banner masks the timed-out one.
- **Pricing gaps, runbook-recorded:** Together and OpenRouter have no seeded `model_pricing` rows, so
  their BYOK calls write `cost_unknown = true` and a zero cost column; the two DeepSeek rows are
  UNVERIFIED. Both in runbook §4–5.
- **→ Phase 7:** `agent_runs` retention, newly urgent because `ticket.triage` now writes one run row
  per inbound email and nothing sweeps it; the stuck-source sweep; `platform.access` audit retention;
  the `KNOWLEDGE_EMBED_MODEL` re-embed job; `context_too_long`'s "halve retrieval, retry once"
  (deviation 7, carried from Phase 3).

## What the review verified holds

**Tenancy and secrets.** RLS enabled, forced and two-policied on all three new tenant tables, with
`model_pricing` correctly in `RLS_EXEMPT`; `llm_credential_secrets` `REVOKE`d from `aesa_app`
outright with a test asserting the grant list is empty; `openCredentialKey` is the one place RLS is
bypassed and it still filters `orgId` AND `credentialId`. The pasted key's whole path was traced: the
api seals with `sealTo` and never stores it → sealed base64 on the `llm.probe` payload → the worker's
platform-role store → the DEK re-wrap guarded on **the exact ciphertext bytes it opened** →
`readApiKey` deliberately avoids `JSON.parse`'s first-ten-characters-in-the-SyntaxError leak →
`Secret` → adapter → `scrubSecrets` on every error → `last_error` capped at 200 chars; only
`key_fingerprint` ever leaves an API. `createPinnedFetch` is the **default** transport on both
`createByokProvider` branches, re-resolving every call with `redirect: 'error'`.

**The seams are genuinely single-sourced.** `resolveModelConfig` is the ONE reader of an agent's model
choice and all four consumers go through it (the worker's resolver, `agents.list`'s Model line,
`getAgentModel`, `sandboxStart`'s run stamp, `stats.rollup`'s graduation window) — so the list screen
and the drafting job cannot disagree about which model an agent runs on, which is the failure mode
that would be invisible until a customer got the wrong reply. `ProbeResultView` is one zod schema
doing five jobs (the probe's return, `last_probe`'s stored shape, `resolveModelConfig`'s
tier-downgrade input, `createByokProvider`'s `structuredOverride`, the app's chip line), parsed back
defensively by the api so an unrecognized shape renders "never tested" instead of a 500.
`QUEUE_OPTIONS` closes the pre-create drift hole for real — `defineJob` and both pre-create lists read
one table, `RegisteredJobDefinition` makes "forgot the queue options" a compile error, the four-places
rule is honoured literally for `llm.probe`, and the cron is correctly in none of them.

**The invariants are untouched.** `packages/core/src/autonomy.ts` has no diff — `decide()`'s order is
the spec's, and the quality tier touches the maths in exactly ONE place
(`apps/worker/src/drafting/evidence.ts`, now the single `computeEvidence` imported by both
`ticket.draft` and `agent.sandbox`), clamping only the `model` term while `drafts.confidence` still
stores the raw self-assessment. The three guardrail gates' call sites are unchanged and the provider
never enters the `WorkspacePolicy`. The four-position lock order holds in every transaction that
touches more than one kind. `memory.capture` is still the sole `insert(resolvedAnswers)` in the tree;
`send.execute`'s only diff is a type rename. The api's module graph still refuses `@aesa/llm` and the
app still refuses every server package. No `withOrg` transaction spans network I/O: the api resolves
the base URL's hostname BEFORE its transaction opens, the resolver opens a key in one transaction and
calls the model outside every transaction, and the probe's three network steps sit between its read
and its write transactions.

**The Phase 6 E2E is the best test artefact on the branch** (D's words): eight scenarios against a
real OpenAI-compatible mock, driving the real api service, the real `llm.probe` job, the real resolver
and the real adapter — including the ladder walking every rung with the *probe* moving it between
drafts and the resolver cache invalidating in between. That is the spec's Verify item 1 proven end to
end rather than approximated.

**The comment discipline is exceptional and load-bearing** (D): nearly every non-obvious line explains
the failure it exists to prevent — the fallback's distinct idempotency key, the re-wrap's byte guard,
why the enqueue is the transaction's last statement, why `dead` is sticky through a transient failure.
A reviewer can check the reasoning, not just the code.

**Robert's manual checks before real tenants** are in `docs/runbooks/2026-09-phase-6-external-setup.md`:
the KEK ring on every `agent` replica and the SAME ring everywhere; the live walk per preset (add a
key → probe `healthy` with a models list → point an agent → a real email from BOTH a Gmail and an
outlook.com sender → approve from the phone → revoke the key at the provider → the `provider_health`
push and the `needs_owner`/`provider_unavailable` ticket); the DeepSeek model-id and price
re-verification as its own named item; migration 0018's duplicate-crawl-row pre-check; the BYOK
DPA/privacy clause; and "a local Ollama needs a public https hostname in v1".

## Adjudication after the re-review

The re-review verdicted every wave item ADDRESSED with no new breakage. Ruling 22 declined a second
wave and disposed of the four Low residuals: (r1) and (r4) were folded into this close-out's own first
commit `024ff65` (the docs task is reviewed anyway, and both are one-liners), and (r2), (r3) and the
out-of-scope ruling-21 observation are carried in STATUS's residual list. The close-out then worked
reviewer D's docs/env drift checklist item by item — CLAUDE.md's Env, Layout and Rules (the TEN short
queues, `QUEUE_OPTIONS` as the four-places rule's option source, `llm.reprobe-sweep` as a cron, the
Escalation rule staying at three, `model_pricing` in `RLS_EXEMPT`, the new **Provider credentials**,
**Provider choice** and **Metering** rules, the tier cap on the ONE `model` term, graduation by tier
and the generation window, the guardrail sentence, 25 routes), both `.env.example` files, STATUS's
phase count, Phase 6 record and Phase 7 hand-off, the plan's execution rulings, and this record.

**One checklist item was answered differently from D's wording, deliberately.** D asked that all three
"24 routes" occurrences in STATUS become 25. Two of them sit inside the **Phase 5 record** — one is
that phase's gate line, the other a Phase 5 execution ruling — and rewriting them would make STATUS
lie about what Phase 5 measured. Both were annotated instead ("25 since Phase 6, which is the current
baseline — this line records the Phase 5 gate"), and the live baseline says 25 in the Phase 6 record,
the Phase 7 hand-off and CLAUDE.md. The Phase 5 record's "Carries still open" list was given the same
treatment: a lead-in marking it as a record of that moment and pointing at the Phase 6 record's list
as the live one, rather than editing the history.

## The final gate

Raw output at the close-out tree, with `S3_ENDPOINT=http://localhost:9000 S3_REGION=us-east-1
S3_BUCKET=aesa-dev S3_ACCESS_KEY_ID=aesa S3_SECRET_ACCESS_KEY=aesaaesa S3_FORCE_PATH_STYLE=true`
exported and minio up.

### `pnpm typecheck && pnpm lint && pnpm test && pnpm db:check` — exit 0

```
$ pnpm typecheck && pnpm lint && pnpm test && pnpm db:check

# typecheck: Scope: 15 of 16 workspace projects — every project "Done".
# lint:      Scope: 15 of 16 workspace projects — clean.
# test (pnpm -r test), per package:
packages/contracts test:  Test Files  9 passed (9)
packages/contracts test:       Tests  36 passed (36)
packages/crypto test:  Test Files  6 passed (6)
packages/crypto test:       Tests  52 passed (52)
brand test:  Test Files  6 passed (6)
brand test:       Tests  110 passed (110)
packages/platform-mail test:  Test Files  3 passed (3)
packages/platform-mail test:       Tests  19 passed (19)
packages/core test:  Test Files  11 passed (11)
packages/core test:       Tests  247 passed (247)
packages/llm test:  Test Files  12 passed (12)
packages/llm test:       Tests  158 passed (158)
packages/agent test:  Test Files  6 passed (6)
packages/agent test:       Tests  71 passed (71)
packages/db test:  Test Files  19 passed (19)
packages/db test:       Tests  95 passed (95)
packages/queue test:  Test Files  5 passed (5)
packages/queue test:       Tests  23 passed (23)
packages/mail test:  Test Files  12 passed (12)
packages/mail test:       Tests  242 passed (242)
packages/knowledge test:  Test Files  14 passed (14)
packages/knowledge test:       Tests  162 passed (162)
packages/test-kit test:  Test Files  2 passed (2)
packages/test-kit test:       Tests  39 passed | 4 skipped (43)
apps/api test:  Test Files  28 passed (28)
apps/api test:       Tests  301 passed (301)
apps/app test: Test Suites: 58 passed, 58 total
apps/app test: Tests:       458 passed, 458 total
apps/worker test:  Test Files  40 passed (40)
apps/worker test:       Tests  586 passed (586)

# TOTAL: 2,599 passed + 4 conditional skips (test-kit's).

# db:check
No schema changes, nothing to migrate 😴
migrations in sync with schema
EXIT=0

# NOTE — the known `e2e-phase3` case-10 flake. The gate was run twice on this tree. The
# first run was green end to end (the counts above). The second run had exactly one failure:
#
#   FAIL test/e2e-phase3.test.ts > Phase 3 close-out E2E (real pg-boss + the real api draft
#   service) > 10. gmail: approve -> send.execute -> one threaded, marked, signed reply, ONE
#   outbound row (still one after sync), the two meters, and a follow-up that reopens into a
#   fresh draft
#     - 2 / + 1   at test/e2e-phase3.test.ts:895  expect(rows).toHaveLength(2)
#   Test Files  1 failed | 39 passed (40)
#        Tests  1 failed | 585 passed (586)
#
# Re-run of that file alone, per the standing flake rule:
#
#   $ pnpm --filter @aesa/worker test test/e2e-phase3.test.ts
#   Test Files  1 passed (1)
#        Tests  21 passed (21)
#      Duration  223.40s
#
# This is the pre-existing timing flake STATUS has carried since Phase 1 (the follow-up's second
# draft has not landed yet when the poll's deadline expires under full parallel load). Nothing on
# this branch touches that path; `db:check` was re-run separately after it and is clean.
```

### `pnpm --filter @aesa/app export:web`

```
$ EXPO_PUBLIC_API_URL=http://localhost:3001 pnpm --filter @aesa/app export:web

› Static routes (25):
/ (index) (22KB)
/terms (25KB)
/privacy (25KB)
/_sitemap (18KB)
/post-auth (22KB)
/+not-found (22KB)
/(app)/inbox (22KB)
/invite/[id] (22KB)
/(auth)/verify (22KB)
/(app)/activity (22KB)
/(auth)/sign-in (22KB)
/create-workspace (22KB)
/(app)/settings/ai (22KB)          <-- the one new route file (24 -> 25)
/(app)/ticket/[id] (22KB)
/onboarding/[step] (22KB)
/(app)/settings/team (22KB)
/(app)/settings (22KB)
/(app)/settings/agents (22KB)
/(app)/settings/memory (22KB)
/(app)/settings/autopilot (22KB)
/(app)/settings/knowledge (22KB)
/(app)/settings/mailboxes (22KB)
/(app)/settings/workspace (22KB)
/(app)/settings/agents/[id] (22KB)
/(app)/settings/notifications (22KB)

Exported: dist
EXIT=0
```

### `pnpm e2e` (the Playwright signup smoke)

```
$ BETTER_AUTH_SECRET=playwright-secret-… pnpm e2e

> @aesa/app@0.1.0 e2e
> playwright test

Running 1 test using 1 worker

  ✓  1 e2e/signup.spec.ts:28:5 › sign up with an email code, create a workspace, finish the
     profile step, and reach the gated mailbox step (878ms)

  1 passed (3.4s)
EXIT=0

# The dev database was migrated first — 0018–0020 had not been applied to `aesa_dev`:
#   $ DATABASE_URL=postgres://aesa:aesa@localhost:5434/aesa_dev pnpm --filter @aesa/db migrate
#   migrations applied
# Without that step `workspace.create` fails with a 42703 and the smoke cannot run at all.
```
