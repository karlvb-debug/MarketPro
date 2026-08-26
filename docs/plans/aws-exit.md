# AWS Exit — Vercel + Supabase + Twilio

> Status: planned · Created August 25, 2026
> Goal: run the whole product on Vercel + Supabase + Twilio with near-zero
> idle cost, preserving every load-bearing invariant and the 156-test suite.
> Trigger: the AWS account was closed when free credits ran out. Idle burn was
> ~$45–50/mo (NAT Gateway + RDS) at zero customers.

---

## 1. The decisive finding: the valuable code isn't AWS code

Measured coupling across `lambda/lib` — ~2,400 lines of core logic:

| File | Lines | AWS imports |
|---|---|---|
| `rules.ts` (AST→SQL rule engine) | 285 | **0** |
| `billing.ts` (authorize/settle ledger) | 285 | **0** |
| `merge.ts`, `timeline.ts`, `custom-fields.ts` | 204/188/176 | **0** |
| `bulk.ts`, `consent.ts`, `campaign-launch.ts` | 163/151/146 | **0** |
| `export.ts`, `segment-query.ts`, `gdpr.ts`, `engagement.ts` | 129/122/110/109 | **0** |
| `db.ts` | 166 | **1** ← Secrets Manager only |

Supabase is Postgres. The differentiator ports unchanged. What gets deleted is
the scaffolding that was costing money: 9 CDK stacks, VPC, NAT, Lambda
authorizer, DynamoDB idempotency table, SQS, Amazon Connect.

Two structural gifts already in the code:

- **`processCampaignDispatch()` is transport-agnostic.** All SQS coupling is
  isolated in `makeSqsHandler` (~50 lines, `engine.ts:211`). `timeRemainingMs`
  defaults to `POSITIVE_INFINITY` — the unbounded-worker case is the *default*.
- **`scheduled-dispatch.ts` is already a cron tick** (EventBridge/5min → claim
  due campaigns → launch), race-safe via conditional claim. Maps 1:1 to Vercel
  Cron with no semantic change.

---

## 2. Target architecture

| Concern | Runs on | Idle cost |
|---|---|---|
| Next.js portal + API routes | Vercel | $0 → $20 |
| Postgres, auth, storage | Supabase | $0 → $25 |
| Dispatch tick + queue | Vercel Cron + pg-boss (in Supabase) | $0 |
| SMS / email delivery | Twilio (+ SendGrid) | per-message |

**Dispatch stays on cron, not a worker.** Prototype evidence: multiday
campaigns already run fine this way. Ceiling is `batch × frequency`; average
load at 100 users is ~19 msgs/tick, which is nothing. Peak clustering is the
real limit — mitigated in M4 by in-invocation concurrency + round-robin
fairness. Switch signal is **backlog-age p95**, not user count (see §6).

---

## 3. Decision: keep app-level workspace scoping — do NOT adopt RLS in v1

The riskiest possible move is rewriting tenant isolation. Today every query is
workspace-scoped in code and the authorizer injects the role; this is covered
by the integration suite. Porting to Supabase RLS would invalidate those tested
query paths *and* collide with the rule engine's compiled SQL.

**v1:** Supabase Auth for identity only. Server routes connect with the service
role; existing workspace scoping stays exactly as-is and stays tested.
**Later:** add RLS as defense-in-depth, once the port is green.

---

## 4. Phases

### M0 — Accounts & decisions (~0.5 day)
- Supabase project, Vercel project, Twilio account (+ SendGrid for email).
- Recreate the 4 secrets as env vars: Stripe secret, Stripe webhook secret,
  DB URL, Twilio creds. **No plaintext in code.**
- Clear `cdk.context.json` (cached AZ lookups pin dead account 185011027929).

### M1 — Repo restructure: `packages/core` (~1–2 days)
Lift the portable logic out of `apps/infrastructure` so both Next routes and
the cron handler import one copy.

```
packages/core/     rules, billing, consent, merge, custom-fields,
                   segment-query, export, gdpr, engagement, bulk,
                   timeline, contact-validate, duplicates, personalize,
                   dispatch/core (engine, store, quiet-hours, errors)
apps/frontend/     Vercel — portal + API routes + cron handlers
```
- `db.ts` is the only rewrite: drop Secrets Manager, take `DATABASE_URL`.
- Move the tests with the code. **Gate must stay green at this step.**

### M2 — Database on Supabase (~1 day)
- Run the 6 append-only migrations against Supabase (runner is transactional +
  advisory-locked; do not edit applied migrations — add new ones).
- Point `TEST_DATABASE_URL` at a Supabase branch; run the full suite.
- Use **Supavisor transaction mode** from Vercel; direct pooled conn elsewhere.

### M3 — API: Lambda handlers → Next route handlers (~3–4 days)
9 handlers port to App Router routes: `batch, campaigns, contacts,
custom-fields, segments, settings, templates, views, workspaces`.
- `authorizer.ts` → Supabase Auth session; keep injecting role + workspace id
  into the same call signatures the lib functions already expect.
- Frontend: repoint `NEXT_PUBLIC_API_URL` (single env var) or move to relative
  routes. Frontend has ~zero AWS coupling — store slices are untouched.
- **Keep `useStore()` slice return shapes byte-stable.**

### M4 — Dispatch on cron + Twilio (~3–4 days)
- Add **pg-boss** in Supabase. Implement `requeue` as
  `boss.send('dispatch', payload, { startAfter: delaySeconds })` — this is the
  one-line seam. Quiet-hours deferral becomes a delayed job instead of the SQS
  max-delay dance.
- `makeSqsHandler` → `makeCronHandler`: drain N jobs, `timeRemainingMs` = own
  ~50s budget. Engine, claim row, pagination, error triage **unchanged**.
- Channel adapters: SES → SendGrid/Resend; Pinpoint SMS → Twilio.
  **Delete voice / Amazon Connect entirely.**
- `scheduled-dispatch.ts` → Vercel Cron route (same claim logic).
- **New work (this is where the headroom is):** in-invocation concurrency
  limiter (~30–50 in flight) + **round-robin across active campaigns per tick**
  so one big blast can't starve 99 other customers. Per-customer throughput cap
  mirroring their 10DLC allotment.

### M5 — Billing & Stripe (~1–2 days)
- `stripe-webhook.ts`, `idempotent-billing-capture.ts`, `reconcile-billing.ts`
  → Next routes + cron. DynamoDB idempotency table → a Postgres unique key.
- **Never send without a hold; never charge outside the ledger.**

### M6 — Ancillary handlers (~2–3 days)
`unsubscribe`, `inbound-sms` (Twilio webhook), `csv-parser` +
`csv-upload-trigger` (→ Supabase Storage), `export-worker`,
`right-to-be-forgotten`, `timezone-resolution`, `email-test-send`.

### M7 — Cutover (~1 day)
- Delete `apps/infrastructure` (9 stacks, CDK, deploy workflow).
- Rewrite CI: drop CDK assertion tests, keep lint/types/test/build.
- Update `CLAUDE.md` + `README.md` to the new stack.

**Total: ~2.5–3.5 weeks** of focused work.

---

## 5. Invariants that must survive (from CLAUDE.md)

| Invariant | How it survives |
|---|---|
| Rule engine is the only query path; values always bound params | `rules.ts` moves verbatim to `packages/core` |
| Migrations append-only | Same runner, same `schema_migrations`, new DB |
| Claim-before-send / exactly-once | Unique `(campaign_id, contact_id)` row is a **Postgres** constraint — transport-independent |
| Billing authorizes then settles | `billing.ts` verbatim; holds now also gate Twilio spend |
| Email body server-side (`html_content`) | Unchanged; SendGrid reads the same column |
| Tenant isolation, `SET NULL` FKs except `contact_segment` | Preserved by §3 decision (no RLS rewrite) |

**Test net:** 156 tests, 16 suites. `dispatch-engine.test.ts` calls
`processCampaignDispatch` **22 times directly** against fakes — transport-
independent, so it catches a botched dispatch port immediately. Integration
suites run against real Postgres; Supabase *is* real Postgres.

---

## 6. Watch this metric, not user count

Track **backlog age** = launch → last message out, p95. Set a customer promise
(e.g. 95% of blasts fully delivered within 30 min). When p95 crosses it, move
dispatch to a persistent worker (Railway, ~$5/mo).

Economic crossover: if the cron function is busy on most ticks, you're buying
~18h/day of compute at serverless prices to replace a $5 always-on process.
**Busy-most-ticks is the switch signal.** The `requeue` seam makes it an
afternoon: same engine, same queue, different trigger.

---

## 7. Open items (business, not code)

- **A2P 10DLC as ISV** — managed onboarding (chosen over BYOT) means per-customer
  brand+campaign registration, fronted fees, multi-day vetting, and rejections
  landing during onboarding. Automate via Twilio subaccounts + registration API.
  Charge a setup fee; the billing ledger already does prepaid holds.
- **Email reputation** — under a managed model one bad sender hurts everyone.
  Authenticate each customer's own domain (DKIM/SPF) from day one.
- **Voice** — dropped. Least differentiated, most compliance risk.
- **Full CRM** — declined. The list management (rule engine, segments, merge,
  dedupe, custom fields, consent, GDPR) is already the differentiator.
