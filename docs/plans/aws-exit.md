# AWS Exit — Vercel + Supabase + Twilio

> Status: **M1 complete · M3 server-side complete** · Created August 25, 2026 · Updated August 26, 2026
> Goal: run the whole product on Vercel + Supabase + Twilio with near-zero
> idle cost, preserving every load-bearing invariant and the 156-test suite.
> Trigger: the AWS account was closed when free credits ran out. Idle burn was
> ~$45–50/mo (NAT Gateway + RDS) at zero customers.

---

## 1. The decisive finding: the valuable code isn't AWS code

Measured coupling across `lambda/lib` — ~2,400 lines of core logic
(paths as of planning; this code now lives in `packages/core/src` — see M1):

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

### M0 — Accounts & decisions (~0.5 day) — *in progress*
- ☑ **Supabase project created**: `MarketPro` (`cxdmbpyuoptmjmnuuldq`),
  region `us-east-1`, **Postgres 17.6**, on the `Karl's Pro` org
  ($10/mo additional-project compute). Note the version gap: local tests run
  against Postgres 16, so M2 must confirm the migrations apply cleanly on 17
  rather than assume it.
- ☐ Vercel project, Twilio account (+ SendGrid for email).
- ☐ Secrets as env vars — see `apps/frontend/.env.example` for the contract.
  Two are dashboard-only and cannot be read back through the Management API:
  the **database password** (needed for `DATABASE_URL`) and the
  **service-role key** (needed by the route handlers to verify tokens).
  **No plaintext in code.**
- ☑ Clear `cdk.context.json` (cached AZ lookups pinned dead account
  185011027929) — now `{}`.

### M1 — Repo restructure: `packages/core` ✅ **DONE**
The portable logic now lives in `@repo/core`, imported by one copy.

```
packages/core/src/      rules, billing, consent, merge, custom-fields,
                        segment-query, export, gdpr, engagement, bulk,
                        timeline, contact-validate, duplicates, db, logger,
                        migrate, schema, database/migrations/
packages/core/src/dispatch/   engine, store, quiet-hours, personalize,
                              errors, types, testing
apps/infrastructure/    AWS adapter only — CDK stacks, handlers,
                        lambda/lib/db.ts (API-Gateway helpers),
                        lambda/dispatch/sqs-handler.ts
```

What landed:
- **`@repo/core` has zero AWS imports** — verified, not assumed.
- **`db.ts` rewritten**: Secrets Manager dropped; `DATABASE_URL` is the single
  source of truth and it now *fails fast* when unset. The portable RBAC
  hierarchy (`roleMeetsMin`) moved with it; the API-Gateway-shaped helpers
  (`respond`, `requireRole`, authorizer-context readers) stayed behind in
  `apps/infrastructure/lambda/lib/db.ts`, which M3 deletes.
- **`engine.ts` split at its real seam**: `processCampaignDispatch` is core;
  `makeSqsHandler` became `lambda/dispatch/sqs-handler.ts`. The engine no
  longer names a transport, in code *or* comments — M4 swaps SQS for
  cron/pg-boss by passing a different `requeue`.
- **Dispatch fakes published** as `@repo/core/dispatch/testing`, so the engine
  tests and any transport adapter's tests share one set of doubles.
- **Tests moved with the code**: 110 in core (12 suites), 46 in infrastructure
  (5 suites) — **156 total, unchanged**. `dispatch-engine.test.ts` split into
  the engine's 22 transport-independent assertions (core) and the 3
  SQS-transport assertions (infra).
- **`packages/core` is linted** at `--max-warnings 0`, which
  `apps/infrastructure` never was; the gate went from 7 tasks to 10.
  `DATABASE_URL` added to `turbo.json` globalEnv.

> ⚠️ Consequence, accepted: with Secrets Manager gone, the CDK stacks can no
> longer run as deployed — they inject `DATABASE_SECRET_ARN`, not
> `DATABASE_URL`. The AWS account is already closed and M7 deletes these
> stacks, so this is the intended direction, not a regression to fix.
> `test/infrastructure.test.ts` still asserts no plaintext `DATABASE_URL` in
> Lambda env and still passes.

### M2 — Database on Supabase (~1 day) — *blocked on the DB password*
- Run the 6 append-only migrations against Supabase (runner is transactional +
  advisory-locked; do not edit applied migrations — add new ones).
- Point `TEST_DATABASE_URL` at Supabase; run the full suite.
- Use **Supavisor transaction mode** from Vercel; direct pooled conn elsewhere.

> Both steps need a direct Postgres connection, which needs the database
> password. Supabase generates it at project creation and never returns it
> through the API, so it has to be set once in the dashboard
> (Project Settings → Database → Reset database password).
>
> Running the migrations by pasting their SQL through the Management API was
> considered and rejected: the baseline alone is 16.6KB, and hand-transmitting
> it risks a silent transcription error in the schema. `apply_migration` was
> rejected too — it keeps its own `supabase_migrations.schema_migrations`
> table, which would leave two competing sources of truth against our own
> `public.schema_migrations`. The tested runner stays the only thing that
> writes the schema.

### M3 — API: Lambda handlers → Next route handlers — ✅ **server-side done**

All nine handlers (`batch, campaigns, contacts, custom-fields, segments,
settings, templates, views, workspaces`) are ported to transport-neutral
functions in `@repo/core/api/*`, exposed as **27 Next route handlers**.

The decomposition follows M1's: the old authorizer did two things, and only
one was vendor-specific.

- `@repo/core/api/context` — `RequestContext {userId, workspaceId, role,
  isSuperAdmin}` and `resolveRequestContext`, reproducing the authorizer's
  rules exactly (global/absent workspace, super-admin impersonation,
  `users_workspaces` lookup, graceful deny on malformed UUIDs).
- `@repo/core/api/result` — `ApiResult {status, body}` plus
  `requireRole`/`requireWorkspace`. Knows nothing about API Gateway or Next.
- `@repo/core/api/input` — typed readers for untrusted JSON bodies.
- `apps/frontend/app/api/_lib` — the Next adapter: an `AuthProvider`
  interface with a Supabase implementation (bearer token verified with the
  service role; super-admin read from `app_metadata`, which users cannot
  write to, rather than self-writable `user_metadata`), and `withContext()`.

Remaining AWS couplings were **inverted, not reimplemented**:

| Was | Now |
|---|---|
| SQS client in `campaigns` | `CampaignDeps.enqueue` callback |
| S3 presign in `contacts` | `ContactsDeps.presignUpload/presignDownload` |
| Lambda invoke for export | `ContactsDeps.startExport` |
| APIGW event for audit log | `RequestMeta {ip, userAgent, path}` |

The Next routes pass these **unwired on purpose**: dispatch moves to pg-boss
in M4 and storage to Supabase Storage in M6. An absent dependency behaves
exactly as a missing queue-URL/bucket env var did before — no URL is ever
fabricated.

Frontend: `config.apiUrl` now defaults to the relative `/api`, so the API
ships with the app; `NEXT_PUBLIC_API_URL` remains an override. `isApiConfigured`
became `isAuthConfigured` (the API is always present now; what gates real mode
is having an auth provider). **`useStore()` slice shapes are untouched** — the
api-client's paths and payload shapes are unchanged, so no store slice moved.

#### Typing the handlers found four latent 500s

The Lambda handlers read request bodies off `any` and were never linted or
type-checked (infrastructure's tsconfig excludes `test/`, and it has no lint
script). Porting them into a linted, type-checked package turned four opaque
500s into correct 4xx responses:

1. `campaigns.templateId` / `segmentId` are `NOT NULL`, but the handler
   inserted whatever the body held → Postgres error as a 500. Now a 400.
2. `contacts.consent_source` is an enum column written through unvalidated →
   500 on any unrecognised string. Now simply not set.
3. `contacts.status` on PUT, same enum problem → 500. Now a 400 naming the
   accepted values.
4. Import rows were passed to `normalizeContactRow` without checking they were
   objects, so a CSV payload containing a bare string threw.

Accepted enum values are read from the schema's own `pgEnum` definitions, so
they cannot drift from the database constraint.

#### Still open on M3

- **Client-side auth swap (Cognito → Supabase).** `app/lib/auth.tsx` is still
  a 246-line Cognito provider. The server accepts Supabase tokens today; the
  browser still mints Cognito ones. This is **blocked on M0** — writing it
  without a Supabase project to authenticate against would be unverifiable,
  and login is not something to ship untested.
- **The Lambda handlers still hold their original copies of this logic.** They
  were left intact rather than made to delegate, so `apps/infrastructure` and
  `@repo/core/api` now describe the same behaviour twice. The AWS account is
  closed and M7 deletes those handlers, so nothing calls them — but until then
  treat `@repo/core/api` as the only live copy and do not edit the Lambda
  versions.

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
