# Phase 6 external setup — Robert's checklist

Phase 6 adds **no new environment variable to either app** and **no new platform vendor**. What it
adds is the opposite of a vendor: the ability for a *customer* to bring their own model provider —
Anthropic, OpenAI, DeepSeek, Groq, Together, OpenRouter, or any OpenAI-compatible https endpoint —
paste one API key in **Settings → AI**, and point an agent's drafting and triage at it.

So the list below is short on provisioning and long on two things CI cannot do: **the KEK ring has to
reach the `agent` role** (it did not have to before), and **a real key from a real provider has to be
walked end to end**, because every preset's model ids, prices and structured-output behaviour are
seeds that only a live probe can confirm.

Read `docs/runbooks/2026-09-phase-3-external-setup.md` (the `send`-role environment, the Anthropic
Console spend limit) and `docs/runbooks/2026-09-phase-4-external-setup.md` (Voyage, the object store,
the `vector` extension) first if either is not done. Phase 6 assumes both.

---

## 1. What has to be provisioned

| | |
|---|---|
| New third-party account | **none** (the customer brings theirs) |
| New environment variable | **none** — `AESA_KEK_V<n>`/`AESA_KEK_ACTIVE` already existed; what changed is **which roles need it** (§2) |
| New runtime dependency | `openai@7.15.0`, pinned exactly, `packages/llm` only — `pnpm install` on deploy |
| New queue | `llm.probe` (`policy: 'short'`), pre-created at boot by BOTH `apps/worker/src/index.ts` and `apps/api/src/boss.ts` — it has a producer on both sides (the api's *Test connection*, the worker's own re-probe sweep), as `ticket.draft`, `send.execute` and `notify.dispatch` already do |
| New cron | `llm.reprobe-sweep`, `15 */6 * * *`, registered by the **`cron`** role |
| New migrations | `0018_crawl_url_uidx.sql`, `0019_polite_phil_sheldon.sql` (generated), `0020_provider_hardening.sql` (hand-written) |

**Deploy migrations before code, as always.** Two notes on this set:

- **`0018_crawl_url_uidx.sql` is the one with a lock.** It creates a *non-concurrent* unique index
  `(org_id, url) WHERE kind = 'crawl' AND status <> 'failed'` on `knowledge_sources`, so it takes
  `ACCESS EXCLUSIVE` for the build **and fails outright if the table already holds duplicate live
  crawl rows for one `(org_id, url)`**. Pre-check before applying, and clean up anything it reports:

  ```sql
  select org_id, url, count(*) from knowledge_sources
  where kind = 'crawl' and status <> 'failed'
  group by org_id, url having count(*) > 1;
  ```

  `knowledge_sources` is small pre-launch, so the build is seconds; a later run against a big table
  is the case that wants `CREATE INDEX CONCURRENTLY` by hand instead.
- **`0020` drops and re-adds `notifications_kind_check`** to admit `provider_health` (one constraint
  validation's `ACCESS EXCLUSIVE` on a small table — same shape as Phase 5's `0017`), `REVOKE`s
  `aesa_app` from `llm_credential_secrets` outright and from `model_pricing`'s writes, forces RLS on
  the three tenant tables, and **seeds `model_pricing`** (see §5).

---

## 2. The KEK ring must reach the `agent` role — the same ring

This is the one deployment change in the phase and the one that fails silently if it is got wrong.

A BYOK key is pasted in the browser, **sealed** to the workspace's box public key by the api, carried
to the worker on the `llm.probe` job payload, and re-wrapped there under the **org DEK**, which is
itself wrapped by the KEK ring. Every subsequent model call opens it again. So:

- `AESA_KEK_V<n>` + `AESA_KEK_ACTIVE` are now **required in production on any replica whose
  `WORKER_ROLES` includes `agent`**, not only `sync` and `send`. `loadConfig`
  (`apps/worker/src/config.ts`) refuses to boot without it, with that sentence — this one is caught
  loudly, not silently.
- **It must be the SAME ring on every replica.** A key sealed and re-wrapped by a replica holding
  ring A cannot be opened by a replica holding ring B: `resolve` returns `no_secret`, the ticket
  lands `needs_owner` / `provider_unavailable`, and nothing says "wrong KEK" anywhere. If you rotate,
  rotate by *adding* a version and moving `AESA_KEK_ACTIVE` — never by replacing `AESA_KEK_V1`'s
  value — and roll every replica before the new version is made active.
- **`llm.probe` is gated by the ring ALONE**, independently of `ANTHROPIC_API_KEY`. A ringed replica
  with no Anthropic key still adds, probes and re-wraps BYOK credentials; it simply has no Managed AI
  to offer. (That is also the new dev behaviour: outside production a missing `ANTHROPIC_API_KEY` no
  longer skips the agent role — every job registers, `managed = null`, and an agent *configured for
  Managed AI* lands `provider_unavailable` while BYOK agents work normally.)

---

## 3. The live verification walk

Do this once, with a real key, on a real workspace, with a real phone. Nothing in CI can stand in for
it: every preset in the catalog is a *seed*, and the probe against a live key is the only thing that
tells the truth about model ids and structured-output support.

Do it for **at least** the two presets the business will offer first — **OpenAI** and
**Anthropic-BYOK** — and repeat §3.1–3.2 for any other preset before it is offered.

### 3.1 Add a key and watch the probe

1. **Settings → AI**. The screen opens on **Managed AI** with a **consent sentence** under the
   provider picker: *"Email content will be sent to {provider} under its terms."* Read it as a
   customer would; it is the sentence the DPA in §6 has to match.
2. Pick **OpenAI**, paste a real key, Save. The card appears with health **unknown** and the screen
   polls for up to **two minutes**; then it says so and offers **Test connection** again.
3. Within seconds the card should read **healthy**, with:
   - a **models list** pulled from the provider's own `/models`;
   - the **structured-output verdict** the probe found (`native` / `json_mode` / `none`);
   - the **quality tier** (`calibrated` / `standard` / `limited`) and what it caps.
4. Check the row and the probe verdict in the database:

   ```sql
   select provider, base_url, key_fingerprint, health_status, consecutive_failures,
          last_error, last_probed_at, last_probe
   from llm_credentials where org_id = '<org>';
   ```

   **`key_fingerprint` (sha256 prefix 8 + the key's last 4) is the ONLY thing an API ever returns.**
   If a whole key or a `sk-`-shaped string ever appears in `last_error`, `last_probe` or a log line,
   stop and report it — that is a secrets-discipline defect, not a configuration problem.

### 3.2 Point an agent at it, and send a real email

5. **Settings → Agents → (agent) → Model**. Pick the connection and a draft model (`gpt-5` for
   drafting, `gpt-5-mini` for triage is the seeded suggestion). Save.
   - Expect the **pre-save banner** when the model actually changes: changing an agent's provider,
     model or mode **bumps `model_generation`, demotes every Autopilot category of that agent back to
     Review** with the reason `model_changed`, and restarts its graduation window. That is by design
     (a different model is a different writer), and it is the single most surprising thing in the
     phase — make sure the banner reads clearly.
   - Re-saving **Managed AI** on an agent that was already managed changes nothing and demotes
     nothing (fixed in the whole-branch review; worth re-confirming by eye).
6. Send a real customer email from a **Gmail** sender and again from an **outlook.com** sender.
   **Approve the draft from the phone.** Confirm the reply lands threaded, with the agent's signature.
7. Confirm the calls say `byok`, and whose key paid:

   ```sql
   select mode, provider, model_id, credential_id, cost_unknown, cost_micros, role
   from llm_calls where org_id = '<org>' order by created_at desc limit 10;

   select meter, sum(value) from usage_counters
   where org_id = '<org>' and day = current_date group by meter;
   ```

   BYOK cost bumps **`llm_cost_micros_byok`** and NEVER `llm_cost_micros` — the managed daily USD cap
   is the platform's money and a tenant's own spend must never trip it. The **Activity** screen shows
   the combined headline with *"$X.XX of this on your own provider keys"* under it when BYOK spend is
   non-zero; the per-credential 30-day breakdown lives on Settings → AI.

### 3.3 Revoke the key and watch it fail correctly

8. **Revoke or delete the key in the provider's own console** (do not just edit the row).
9. Send another customer email. Expect, within one ticket:
   - a **`provider_health` push** to the owner's phone, deep-linking to **Settings → AI**, once per
     credential per day;
   - the card flipping to **dead** with a scrubbed `last_error`;
   - the ticket landing in **Review** as `needs_owner` / **`provider_unavailable`**, with the owner
     copy *"AI provider unavailable"* / *"…so replies wait for you — check Settings → AI."*;
   - the **next** inbound refused by the resolver *before* any model call or run row at all.
10. Then flip **Fall back to Managed AI** on that same (dead) connection and send once more: the
    draft should land from Managed AI, the credential should stay dead and the owner should still
    have been paged **once**. (Re-saving the *current* dead credential to change fallback or effort is
    allowed on purpose — it is the one remedy the product offers; only *newly pointing* an agent at a
    dead key is refused.)
11. Put a working key back and press **Test connection**. A `dead` credential is only ever re-probed
    by the owner pressing that button — the 6-hourly sweep skips dead credentials deliberately.

### 3.4 A custom endpoint (only if you will offer one)

12. **Custom (OpenAI-compatible)** requires a base URL that is **https, a hostname (never an IP
    literal), with no credentials in the URL, resolving to a public address** — validated when the
    connection is saved AND re-resolved and pinned on **every single call** (redirects are refused,
    not followed). Non-standard ports are allowed.
13. **A local Ollama / vLLM / LM Studio will NOT work in v1.** `http://localhost:11434` is refused
    three times over (http, loopback, not a public address). It needs a public https hostname —
    a tunnel, a reverse proxy with a real certificate, or the on-prem bridge the spec parks for later.
    The screen says so; make sure support does too, because this is the question a self-hosting
    customer will ask first.
14. A custom endpoint is `limited` tier (cap 0.6) and **can never self-graduate a category to
    Autopilot**. That is deliberate and it is not a bug report.

---

## 4. Re-verify DeepSeek's live model ids and prices — before DeepSeek is offered

**This is its own line item, not part of a general "check the provider details" sweep.**

The catalog (`packages/contracts/src/llm.ts`) names DeepSeek's suggested models as
**`deepseek-chat`** and **`deepseek-reasoner`**, and migration `0020` seeds `model_pricing` rows for
both — and `0020`'s own comment records those two rows as **UNVERIFIED**: a 2026-09 check found
DeepSeek's public pricing page no longer listing either id, with the live catalog reportedly moved to
a peak/off-peak **`deepseek-flash` / `deepseek-v4-pro`** scheme and the two names retired as legacy
aliases on 2026-07-24. That claim was not confirmed against a real key, so the phase deliberately did
not churn the catalog on it (ruling: an unverified web claim should not drive a mid-phase rename; the
probe on a real key shows the truth).

**Before DeepSeek is offered to a customer:**

1. Add a real DeepSeek key on a test workspace and read the probe's **models list** — that list comes
   from the provider's own `/models` and is the answer.
2. If `deepseek-chat` / `deepseek-reasoner` are gone, this is **two catalog ids and two
   `model_pricing` rows** to rename: `PROVIDER_PRESETS.deepseek.suggestedModels` in
   `packages/contracts/src/llm.ts` (which is also what `qualityTierFor` reads, so the tier follows
   the rename automatically) plus the two seeded rows — a price change is a migration, there is no
   admin UI, by design. `packages/db/test/llm-tables.test.ts` pins their presence and will fail
   until it is updated too.
3. Re-verify **every** offered preset's prices against that provider's current price page at the same
   time. A wrong price does **not** break drafting — it mis-states the owner's own dashboard and
   nothing else (the platform's caps read the managed meter alone) — but it is the number a customer
   will compare against their provider invoice.

A wrong model **id**, by contrast, fails loudly: the probe refuses, the card shows `degraded` or
`dead`, and the owner sees it. That is why this is a pre-launch chore and not a hotfix.

---

## 5. `model_pricing`: what is seeded and what it is for

`model_pricing` is a **platform** table (RLS-exempt, like `platform_state`), seeded by migration
`0020` and read once at worker boot (`loadModelPricing`) into the metering wrapper. A model with no
row writes `cost_unknown = true` and cost 0 — honest, not silently wrong.

```sql
select model_pattern, input_per_mtok, output_per_mtok, cache_read_per_mtok, effective_from
from model_pricing order by model_pattern;
```

Verified at seed time (2026-09-12 web check): `gpt-5` (1.25 / 10, cache read 0.125), `gpt-5-mini`
(0.25 / 2, 0.025), `llama-3.3-70b-versatile` (0.59 / 0.79), `llama-3.1-8b-instant` (0.05 / 0.08), and
the Anthropic rows mirroring `packages/llm/src/pricing/seed.ts`. **Unverified:** the two DeepSeek
rows (§4).

**Together and OpenRouter have no seeded rows at all.** Their catalog models therefore write
`cost_unknown = true` and cost 0, so the first Together or OpenRouter owner sees an **empty cost
column** on Settings → AI. That is honest, not a bug — but it is a support answer worth having ready,
and adding those rows is a migration whenever either provider is actually offered. (OpenRouter's
`anthropic/…` ids correctly do NOT collide with the Anthropic price patterns.)

---

## 6. Privacy, the DPA, and the sub-processor list

**BYOK changes who the customer's email content is sent to — and it is the customer who chooses.**
Under a BYOK connection, a ticket's customer email, the business's knowledge excerpts and its
operating guidance are sent to **the provider that workspace selected, under that provider's terms,
on that workspace's own account.** We are not that provider's customer; they are.

Before the first real BYOK draft:

- **The consent sentence already exists in the product** — *"Email content will be sent to {provider}
  under its terms."*, shown on Settings → AI at the moment of choosing. **The privacy policy and the
  DPA have to say the same thing**, and they currently do not.
- **Say it structurally, not per-vendor.** The sub-processor list cannot enumerate providers we do
  not control: the right shape is "Anthropic (Managed AI, our default)" as a named sub-processor,
  plus a clause saying a customer who connects their own provider key thereby **appoints that
  provider as their own sub-processor** for the content their agents send it, under the terms they
  accepted with that provider — and that we neither hold nor negotiate those terms.
- **Say where the key lives.** The pasted API key is sealed in the browser's request, stored only in
  `llm_credential_secrets` (platform-role-only, `REVOKE`d from the api's role outright), opened only
  by a worker holding the KEK ring, and never returned by any API — only a fingerprint is. It is
  deleted with the connection.
- **Nothing else changes.** Voyage still embeds, the object store still stores, and neither is
  affected by which chat provider a workspace picked. No new *platform* sub-processor is added by
  this phase.
- **Quality variance is a support answer, not a legal one** (spec §Launch risks): a weaker model's
  self-assessed confidence is capped by its quality tier, so it cannot talk its way onto Autopilot,
  and a `limited` model can never self-graduate. Say that in the help copy the first time a customer
  asks why their cheap model's drafts still wait for review.

---

## 7. Operator notes

- **`llm.reprobe-sweep` runs at `15 */6 * * *`** (`cron` role, singleton, no retry, 300 s expiry) and
  enqueues `llm.probe` for every credential that is **not `dead`** and has not been probed in the last
  6 hours. Two consecutive failures mark a credential `degraded`; only an `auth` failure marks it
  `dead`, and `dead` is **sticky** — a transient failure can never lift it back to `degraded`.

  ```sql
  select created_on, state, output from pgboss.job where name = 'llm.reprobe-sweep'
  order by created_on desc limit 5;
  ```

- **`llm.probe` runs on the `agent` role** (gated on the ring), not on `cron` and not on the api. A
  deployment with a `cron` role and no `agent` role anywhere would enqueue re-probes that nothing
  runs — credentials would sit at their last verdict forever.
- **A revoked key is discovered by whichever job meets it first.** `ticket.triage` and `ticket.draft`
  both mark the credential dead and page the owner once on an `auth` failure — **whether or not
  `fallback_to_managed` saved that particular reply.** Only the ticket escalation is skipped when the
  fallback landed. The sweep is the backstop, not the detector.
- **The provider cache is freshness-keyed, not identity-keyed.** A worker caches a decrypted key per
  `(credentialId, lastProbedAt)` for at most 15 minutes, so a probe on *any* replica retires *every*
  replica's entry. That is what makes a future "rotate this key" surface safe; until then, the way to
  force every replica to re-read is **Test connection** (it re-probes, which moves `last_probed_at`).
- **Five connections per workspace** (`LLM_MAX_CREDENTIALS`), a soft cap enforced by a
  count-then-insert.
- **Nothing about the guardrails changed.** A BYOK draft is screened by the same three gates against
  the same `WorkspacePolicy`; the provider never enters that policy. The tripwire, the kill switch,
  `agent_enabled` and the platform killswitch all still win, before a provider is even resolved.
- **The BYOK stop-loss is token-based:** a BYOK run that has produced **30,000 output tokens** skips
  its automatic redraft, the same way a managed run does at **$0.40**. That matters because a model
  with no `model_pricing` row records cost 0, which would make the dollar stop-loss inert for exactly
  the models that need it.
- **Spend is capped at the provider, not here.** The platform's `autonomy.daily_llm_usd_cap` covers
  Managed AI only, on purpose. Tell a BYOK customer to set a spend limit in **their own** provider
  console — that is their backstop, and it is the same advice as the Anthropic Console limit in the
  Phase 3 runbook, pointed at them.

---

## 8. One thing only a real device proves

The **Settings → AI** screen (route 25) and the agent edit screen's **Model** card have never been
rendered outside jest — the Playwright smoke still ends at the gated mailbox step. Open both signed
in, once in a browser at wide and phone widths and once on a real phone, and check:

- the **paste** path for a long key (the field caps at 512 characters and truncates silently);
- the **two-minute probe wait** and its "we haven't heard back — try Test again" copy;
- **Remove**'s armed confirm **and its Cancel**;
- the **`provider_health` push** actually deep-linking to `/settings/ai` from the notification shade;
- **dark mode** on both screens, and the health chips' colours in it.
