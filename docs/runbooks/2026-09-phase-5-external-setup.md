# Phase 5 external setup — Robert's checklist

Phase 5 is the first phase that needs **nothing new provisioned**. No new vendor, no new API key, no
new environment variable, no new bucket, no new console. Everything it adds runs on what Phases 3
and 4 already set up: the Anthropic key the `agent` role already holds, the Voyage key it already
holds for retrieval, the mailbox OAuth the `send` role already holds.

What it does need is your judgment — because this is the phase where a reply can leave the building
without a human having read it. The list below is the live walk that proves that path end to end,
the privacy sentence the learned-answer store now owes a customer, and the operator notes for the
two new background passes.

Read `docs/runbooks/2026-09-phase-3-external-setup.md` (the `send`-role environment, the
`MAIL_FROM` / `APP_BASE_URL` / `APP_WEB_ORIGIN` identity rule, the Anthropic Console spend limit) and
`docs/runbooks/2026-09-phase-4-external-setup.md` (Voyage, the object store, the `vector` extension)
first if either is not already done. Phase 5 assumes both.

---

## 1. Nothing new to provision

| | |
|---|---|
| New third-party account | none |
| New environment variable | **none** — `apps/api/.env.example` and `apps/worker/.env.example` are unchanged |
| New queue | `memory.capture` and `guidance.suggest`, both created at boot by the pre-create lists in `apps/worker/src/index.ts` and `apps/api/src/boss.ts` |
| New cron | `stats.rollup`, registered by the `cron` role at boot |
| New migrations | `0016_cool_phalanx.sql` (generated) and `0017_autonomy_hardening.sql` (hand-written) |

**Deploy migrations before code, as always.** Both are cheap. `0016` creates three new tables
(`resolved_answers`, `category_stats_daily`, `guidance_suggestions`) and adds five nullable columns
to `drafts`, three to `agent_category_policies` and one to `workspaces` — all `ADD COLUMN` with no
default, so no table rewrite. `0017` forces RLS on the three new tables, adds two `CHECK`s, creates
three indexes, and **drops and re-adds `notifications_kind_check`** to admit the four new kinds
(`auto_send`, `graduation`, `demotion`, `memory_sample`). That last one takes an `ACCESS EXCLUSIVE`
lock on `notifications` for the duration of one constraint validation — `notifications` is a small,
short-lived table, so this is metadata-only in practice, but it is the one statement in the pair
worth running in a quiet minute rather than at peak.

Two **org settings** (not env) decide behaviour that is off by default. They live in `org_settings`
and are per-workspace:

- `notifications.push_auto_sends` — **default `false`**. When on, every auto-send sends the owner a
  push carrying the Hold button. Off is the intended steady state for a workspace that trusts
  Autopilot; turn it on for the walk below, and for any workspace that has just graduated a category.
- `guidance.daily_suggest_cap` — **default `50`**. The per-org daily ceiling on the small Haiku call
  that turns one edited approval into one suggested operating rule.

```sql
-- turn the auto-send push on for one workspace (the walk needs it)
insert into org_settings (org_id, key, value)
values ('<org id>', 'notifications.push_auto_sends', 'true'::jsonb)
on conflict (org_id, key) do update set value = excluded.value;
```

---

## 2. The live verification walk (both providers)

Do this once, with real credentials, on a real workspace, with a real phone in your hand. It is the
only thing that proves the autonomy path, and no gate can stand in for it. Use a **Gmail** sender and
an **outlook.com** sender so both threading paths are covered, exactly as the Phase 3 walk did.

### 2.1 Teach one answer (Review mode)

1. In **Settings → Autopilot**, pick the agent and set **Returns & refunds** to **Review**. (Every
   category starts there; this is just making it explicit.)
2. From the Gmail test account, send the same returns question three times — three separate threads,
   three days of pretending to be three customers is not needed, three fresh threads is enough.
3. Approve each draft **unchanged** from the phone. (Unchanged matters: an edited approval supersedes
   rather than reinforces, and produces a guidance suggestion instead.)
4. Open **Settings → Learned answers**. The **Active** tab should show **one** answer with
   **3 approvals** — not three answers. Its question and answer are the scrubbed forms: no greeting
   line, no signature block, no email address, no phone number, no long digit run.

   ```sql
   select status, approvals, reuse_count, strikes, question_text, expires_at
   from resolved_answers where org_id = '<org>' order by created_at;
   ```

   `approvals` 3, `reuse_count` 2, one row.

### 2.2 Graduate the category and watch the fourth go out on its own

5. The **cold-start lock** needs **10 human decisions** for that agent and category before Auto can
   be selected at all — the screen says so and disables the control until then
   (`Auto unlocks after 10 decisions (N so far)`). Keep reviewing that category until it unlocks, or
   let the nightly rollup's suggestion banner tell you it is ready ("It would have auto-sent X of your
   last 20 unchanged approvals at 80%").
6. Set the category to **Auto** with the **Balanced** preset — 80%, which is also
   `DEFAULT_AUTO_SEND_THRESHOLD` (Cautious is 90, Eager 70). Leave **Hold window** at 2 minutes for
   the walk.
7. Send the same question a fourth time. Within a minute the Inbox's **Auto-sending** tab should show
   the ticket with a counting-down `m:ss` chip and a **Hold** button.
8. **Let it go.** The reply should land in the customer's inbox, threaded under the original message,
   with the agent's signature appended. Check `In-Reply-To`/`References` in the raw message — and do
   this half of the walk from BOTH a Gmail sender and an outlook.com sender.

### 2.3 Hold one from the push

9. Turn `notifications.push_auto_sends` on (section 1) and send a fifth question.
10. When the push arrives, **long-press it and tap Hold** — from the notification shade, without
    opening the app. The ticket should leave Auto-sending and appear in **To review** with the draft
    waiting, and nothing should reach the customer. This is the single most important interaction in
    the phase: it is the owner's brake, and it has never run outside jest and the worker E2E.
11. Tap **Hold** on a sixth one from inside the ticket screen too — the bar and the chip render the
    same `m:ss` clock, and the button is the same call.

### 2.4 Sample an auto-send, and flag one

12. Open **Settings → Learned answers → To check**. Every auto-sent reply leaves a **candidate**
    answer there, and a candidate is **never** retrieved into another draft until a human samples it.
    Tap **Looks good** on one: it becomes `active` with 1 approval and starts being reused.
13. On another auto-sent reply, open the ticket and tap **Should not have sent**. Confirm:
    - the candidate answer that reply produced is **retired** (`sampled_bad`) on the Learned answers
      screen's **Retired** tab;
    - any answer that reply *used* carries a **strike** (two strikes retire it);
    - **on the second such flag within 30 days**, the category comes off Autopilot by itself —
      **Settings → Autopilot** shows the amber "Autopilot paused for …" notice and the mode is back to
      Review, and you get a `demotion` notification. One flag is not enough; that is the rule.

### 2.5 Check the numbers

14. The per-category 30-day line on **Settings → Autopilot** reads
    `Last 30 days: N unchanged · N edited · N rejected · N auto-sent`. It is fed by
    `category_stats_daily`, which the nightly rollup writes — so it is a day behind for today's
    activity. The live counters are the meters:

    ```sql
    select meter, sum(value) from usage_counters
    where org_id = '<org>' and day = current_date group by meter;
    ```

    `auto_sends` and `review_sends` are separate meters and the split is by `drafts.decision_source`,
    so a reply you held and then approved bills as a review send, not an auto-send — which is the
    right answer for both billing and the "did the agent do this?" question.

    The **Activity** screen still shows one combined "Sent" tile: `activity.summary` returns an
    `autoSent` count, but no tile renders it yet (recorded as a carry in `docs/STATUS.md`). Until it
    does, the Autopilot screen's per-category line and the `auto_sends` meter are where you read the
    autonomy numbers.

---

## 3. Privacy and the DPA

**Phase 5 stores customer questions.** `resolved_answers` holds, per workspace, the **scrubbed**
customer question and the business's own approved reply, for up to **365 days** (fixed at capture,
never rolled forward by reuse), keyed by a **salted per-workspace hash** of the customer's email
address. The address itself is never stored on the row and never returned by an API; the salt is
minted lazily, lives in `workspaces.customer_hash_salt`, and never leaves the server.

Before the first real auto-send:

- **Say so in the privacy policy's retention section.** "We keep a scrubbed copy of questions we have
  answered, and the answers we gave, for up to 12 months, so the assistant can answer the same
  question consistently" is the substance. The scrub is structural (greeting line, sign-off block,
  email addresses, phone numbers, long digit runs, the customer's own name) — it is lossy by design,
  not a guarantee of anonymity, and the policy should not claim more than that.
- **Name the erasure path.** `memory.deleteByCustomer` (Settings → Learned answers → *Forget one
  customer*) deletes every answer whose salted hash matches one address. It is the interim erasure
  route for a deletion request and it is complete for this store; **the org-delete path in Phase 7
  must cascade `resolved_answers`** along with everything else, and that is a ledgered Phase 7
  requirement, not something Phase 5 provides.
- **No new sub-processor.** The answers are embedded with the SAME Voyage model as knowledge chunks,
  already disclosed in Phase 4, and are only ever sent to Anthropic inside the draft prompt, already
  disclosed in Phase 3. Nothing new goes to a new vendor.
- **Auto-sending itself is worth a product-copy sentence**, separate from privacy: a business turning
  a category to Auto is agreeing that replies in it go to its customers without a person reading them
  first. The Autopilot screen says so in the moment; the terms should say so once.

---

## 4. Operator notes

- **`stats.rollup` runs at 02:15 UTC** (`registerCron`, `singleton`, `expireInSeconds: 1800`, no
  retry). One row per night in `pgboss.job` under the name `stats.rollup`:

  ```sql
  select created_on, state, output from pgboss.job where name = 'stats.rollup'
  order by created_on desc limit 7;
  ```

  A night it does not run costs only the **suggestion** (the "ready for Autopilot" banner and
  `auto_graduate`), the **30-day stats line**, the **demotion backstop** and the **Monday sampling
  nudge**. It costs no safety: every demotion rule also runs INLINE inside the owner's own
  reject/flag/edit transaction, so a category that has earned a demotion comes off Autopilot the
  moment the second rejection lands, not overnight.
- **`sweeps.daily` gained three memory arms** — expired answers (365 days), unsampled candidates
  (30 days), and answers whose source knowledge changed underneath them (parked `needs_review`). Each
  writes **one audit row per org per arm**, carrying that org's own count and nothing else:

  ```sql
  select action, detail from audit_log
  where actor = 'system:cron:sweeps.daily' and action in ('memory.retired','memory.needs_review')
  order by created_at desc limit 20;
  ```

  An arm that touched nothing writes nothing.
- **`memory.capture` never fails a send.** It is enqueued from `send.execute`'s post-commit `onSent`
  seam and its failure is caught and logged there — a delivered reply is never dead-lettered because
  the learning step tripped. If answers stop appearing, look for failed `memory.capture` jobs:

  ```sql
  select state, count(*) from pgboss.job where name = 'memory.capture' group by state;
  ```
- **`memory.capture` runs on the `agent` role, not `send`.** It embeds, so a `send`-only replica
  enqueues the job and an `agent` replica runs it. A deployment with a `send` role and no `agent`
  role anywhere would deliver replies and learn nothing.
- **An empty answer is a skip, not a failure.** `scrubForMemory` can legitimately reduce a reply to
  nothing (see the carry in `docs/STATUS.md` about one-line replies that open with "Thanks"), and
  `memory.capture` then audits `memory.skipped` with `empty_after_scrub` and stores no row. That is
  the correct behaviour for an empty string; it is also why a workspace can send replies and gain no
  answers.
- **Nothing but `ticket.draft`'s auto landing may write `decision_source = 'auto'`.** If you are ever
  asked "did a human approve this?", that column plus `auto_decided_at` is the answer:
  `auto_decided_at` is set once and never cleared, so a reply the owner held and re-approved still
  reads as "the agent proposed it, the human sent it".
- **The kill levers still win.** `workspaces.kill_switch`, `workspaces.agent_enabled` and the
  platform `killswitch.global` are all checked before an auto-send is ever decided, and `send.execute`
  re-checks them before delivery. A tripwire phrase and a failed DMARC check also still route to a
  human in Auto — they are evaluated before the category's mode is even read.

---

## 5. Voyage: the warning now covers answers too

Phase 4's warning about `KNOWLEDGE_EMBED_MODEL` gets bigger in Phase 5. Learned answers are embedded
with **the same `KNOWLEDGE_EMBED_MODEL`** as knowledge chunks, and the answers leg of retrieval
filters on `embedding_model` exactly as the chunk leg does.

So changing that value on a live workspace now hides **every existing learned answer** from
retrieval as well as every existing chunk — silently, with no boot-time refusal, and with the only
symptom being weaker drafts. The value must be identical on every `knowledge` **and** `agent`
replica, and changing it on a live workspace needs the re-embed job that is still a carry-over.

`memory.capture`'s own embed spend is **not metered and not capped** (a carry: it is one short
question per delivered reply, so the volume is bounded by the send volume, but it does not count
against `knowledge.daily_embed_tokens_cap`). The Voyage console billing limit from the Phase 4
runbook is still the backstop.
