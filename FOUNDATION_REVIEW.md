# MarketPro — Foundation Review & Roadmap to Production

> Review date: June 11, 2026
> Scope: full monorepo — `apps/frontend` (Next.js 16), `apps/infrastructure` (AWS CDK + Lambda + Drizzle/RDS), docs, build, hygiene.

---

## 1. Verdict

**The architecture is a solid foundation. The implementation is roughly 70% there, and the engineering process around it (tests, CI/CD, observability) is essentially absent.**

What's genuinely good:

- Clean monorepo structure (Turborepo) with 9 well-factored CDK stacks and a correct dependency graph.
- Strong multi-tenant security model: Lambda Authorizer validates JWT + workspace membership (`lambda/authorizer.ts`), every CRUD query filters by `workspace_id`, RBAC roles enforced, Drizzle parameterized queries throughout (no SQL injection found).
- Sound queue-based dispatch design: per-channel SQS queues with DLQs → dispatch Lambdas → SES / End User Messaging v2 / Connect, with per-recipient logging to `campaign_messages`.
- Double-entry billing ledger schema with DynamoDB idempotency store and `SELECT FOR UPDATE` locking.
- Cursor-based keyset pagination on contacts; two-pass dedup on bulk import; SHA-256 suppression list wired into email dispatch.
- Frontend genuinely talks to the real API (batch load, paginated contacts, Cognito auth with token refresh kept in SDK memory, not localStorage).
- Type-check passes; frontend and infrastructure both build.

What undermines it:

- **Several "complete" features are stubs.** Most critically: right-to-be-forgotten returns mock data (GDPR gap), billing authorization holds are defined in SQL but never called, the analytics stack is empty scaffolding, scheduled sends have no EventBridge integration, and the timezone engine is a shell.
- **Zero meaningful tests** (one broken infrastructure stub; no frontend tests), **no CI/CD pipeline**, and lint fails with 189 warnings under a `--max-warnings 0` policy.
- **Reliability gaps that will bite at scale**: dispatch Lambdas load entire segments into memory, swallow errors silently (campaigns can halt at 50% with no signal), and campaign completion is not idempotent (Lambda timeout ⇒ duplicate sends and double billing).
- **Hygiene problems**: `cdk-outputs.json` committed with real AWS account/resource IDs, `.bak` file committed, 12 dependency CVEs (5 high), stray root dependencies, generic template README.

Phase-by-phase reality vs. the claims in `TODO.md` / `architecture_plan.md`:

| Phase | Claimed | Actual completeness |
|---|---|---|
| 1 — Foundation / Contacts | ✅ | ~85% — real, solid |
| 2 — Email Engine | ✅ | ~70% — dispatch real; A/B, scheduling, RFC 8058 unsubscribe missing |
| 3 — SMS Engine | ✅ | ~60% — dispatch real; 10DLC, two-way, encoding composer, timezone engine missing/stubbed |
| 4 — Voice Engine | ✅ | ~80% — real, basic Contact Flow |
| 5 — Billing / Analytics / Compliance | partial | ~40% — ledger real; GDPR and analytics stubbed; auth holds never applied |

---

## 2. Critical findings (ranked)

### P0 — Blocking: fix before any real customer data or sends

1. **GDPR/CCPA deletion is fake.** `lambda/right-to-be-forgotten.ts` returns hardcoded mock data; no deletion, no PII hashing, no retention-matrix enforcement. Legal liability the moment a real contact is stored.
2. **No billing authorization holds.** `authorize_campaign_funds()` exists in `db-migrate.ts` (~line 336) but is never called — workspaces can dispatch unlimited volume on a $1 balance. Per-message cost is also hardcoded at `$0.01` (`idempotent-billing-capture.ts:117`).
3. **Dispatch is not safe at scale.**
   - Entire segment loaded into Lambda memory (`dispatch-email.ts` / `dispatch-sms.ts` / `dispatch-voice.ts`) — OOM/timeout on large segments.
   - Catch-all error handling swallows DB/network failures, so SQS deletes the message and the campaign silently halts mid-send.
   - Campaign completion update is not idempotent — a timeout mid-batch causes SQS redelivery and **duplicate sends + double billing**.
4. **Secrets/identifier exposure.** `apps/infrastructure/cdk-outputs.json` is committed with the real AWS account ID, Cognito pool/client IDs, RDS endpoint, and API URL. `stripe-webhook.ts` reads the Stripe key from a plaintext env var instead of Secrets Manager (the stack passes an ARN it never resolves).
5. **No safety net.** No CI pipeline, no working tests, lint failing. Every change ships on hope.

### P1 — High: fix before beta

6. Dependency CVEs: Next.js 16.2.0 (15 high-severity advisories), `xlsx` (no fix — replace), `turbo`, transitive `js-cookie`/`postcss`.
7. No DLQ consumers or CloudWatch alarms (DLQ depth, Lambda errors, RDS health) — failures are invisible.
8. RDS: no proxy/connection pooling strategy for Lambda concurrency, `multiAz: false`, no backup policy.
9. Frontend optimistic updates (`store.ts:555`, `:591`) have no rollback on API failure; imports fire-and-forget with silent error swallowing (`store.ts:839-846`); no React error boundaries anywhere.
10. CSV importer has no input validation/normalization (`csv-parser.ts`) and its stream processing doesn't pause on batch failure.
11. Migrations are a hand-invoked Lambda with no versioning or rollback.
12. Scheduled sends silently send immediately (no EventBridge); two-way SMS inbound topic has no handler — STOP/HELP keywords are not processed (TCPA exposure once SMS goes live).

### P2 — Medium: schedule into normal work

13. `store.ts` is a 1,433-line god-hook; `EmailBlockEditor.tsx` (1,087) and `ImportWizard.tsx` (820) need decomposition; ~80% code duplication across the three dispatch Lambdas; authorizer re-implements the DB pool instead of sharing `db.ts`.
14. Webforms have no backend handler (local-only state, `store.ts:1205`).
15. Accessibility is near-zero (6 aria attributes app-wide).
16. Hygiene: `.bak` file, root-level `cheerio`/`mjml-browser` deps, template README, broken jest config (`@types/jest` missing).

---

## 3. Work plan

### Milestone 0 — Safety net & hygiene (≈1 week) — ✅ DONE (June 11, 2026)
*Goal: every subsequent change is verified by a machine, and the repo leaks nothing.*

- [x] Remove `cdk-outputs.json` and `contact-utils.ts.bak` from git; add to `.gitignore`.
- [x] Fix Stripe secret handling — webhook resolves Secrets Manager ARNs at runtime; billing Lambdas use `DATABASE_SECRET_ARN` instead of credential-less URLs.
- [x] Fix jest config (broken `typeRoots` + stale compiled `.js` shadowing sources); 10 real CDK assertions incl. plaintext-secret regression guard.
- [x] Burn down the 189 lint warnings (73 via `react/prop-types` config fix for TS; 116 code fixes with real types; surfaced and fixed an operator-precedence bug in `store.ts updateContact`).
- [x] GitHub Actions CI: install → lint → check-types → test → build on every PR; `--max-warnings 0` enforced.
- [x] Dependency pass: Next.js 16.2.0 → 16.2.9, turbo 2.9.18, removed unused `grapesjs`/`grapesjs-mjml`, moved `mjml-browser` + its undeclared `cheerio` external into the frontend workspace, Dependabot enabled (weekly, AWS SDK grouped).
- [x] Rewrite README for MarketPro (setup, deploy, architecture pointer).

**Known residuals (accepted, tracked):**
- `xlsx@0.18.5` CVEs (prototype pollution, ReDoS): no fixed version on the npm registry; the patched SheetJS CDN tarball is unreachable from this build environment. Mitigations: input is user-chosen local files only. Plan: replace with `exceljs` or move parsing server-side (M4/M6).
- Transitive advisories pinned by upstream: `postcss@8.4.31` (pinned by Next), `js-cookie@2.x` (pinned by `amazon-cognito-identity-js`), old `esbuild` (drizzle-kit dev toolchain). Revisit via Dependabot as upstreams release.
- Leaked identifiers remain in **git history** (account ID, Cognito pool/client IDs, RDS hostname). They are not credentials; rotating means recreating the Cognito pool / RDS endpoint or history rewrite — owner decision, not done.

### Milestone 1 — Dispatch reliability (≈2 weeks) — ✅ DONE (June 11, 2026)
*Goal: a campaign send is exactly-once, resumable, and observable.*

- [x] Paginate segment fetches: keyset pagination (500/page) in a shared engine; suppression checked per page via hash `IN` query — bounded memory at any segment size.
- [x] Per-recipient idempotency: unique `(campaign_id, contact_id)` index + claim rows via `INSERT … ON CONFLICT DO NOTHING RETURNING`. SQS redelivery skips claimed recipients; interrupted campaigns resume. At-most-once by design (duplicates worse than misses); stale-claim reconciliation documented in the runbook.
- [x] Error triage: `isRetryableError` (DB/network/throttle/5xx) → SQS partial batch failure → retry → DLQ; provider 4xx → `failed` message row, campaign continues; missing template/config cancels the campaign instead of leaving it stuck in `sending`.
- [x] Shared dispatch core (`lambda/dispatch/core/`): engine + injected store + channel adapters; voice uses `clientToken = message_id` for Connect-side idempotency; authorizer now shares `getPool()` from `lib/db`.
- [x] CloudWatch alarms (DLQ depth ≥ 1, Lambda errors ≥ 1) → `marketing-saas-ops-alerts` SNS topic; structured JSON logging via `lib/logger`. (RDS CPU/connection alarms deferred to M5 with the Multi-AZ work.)
- [x] DLQ redrive runbook: `docs/runbooks/dispatch-dlq.md`.
- [x] Infra hardening: `batchSize: 1` + `reportBatchItemFailures`, SMS/voice Lambda timeouts 30s→300s, queue visibility 6× function timeout. 24 new unit tests (engine, error triage) + CDK assertions.

### Milestone 2 — Billing correctness (≈2 weeks) — ✅ DONE (June 11, 2026)
*Goal: nobody can spend money they don't have; nobody gets double-charged.*

- [x] Authorization holds at send time (`lambda/lib/billing.ts`): campaigns API estimates recipients × price, places an atomic conditional hold (available → hold + PENDING ledger row), returns **402** with required/available amounts when funds are insufficient — campaign stays draft, nothing queued. The broken `authorize_campaign_funds()` SQL function (no balance check, swallowed errors) is dropped.
- [x] Per-workspace pricing: `price_per_email/sms/voice` columns on `workspace_settings` (null = platform default); dispatch stamps the price on every claim row; billing capture settles each message at its stamped cost instead of the hardcoded `$0.01`.
- [x] Capture lambda rewritten: resolves the dispatch claim row by `provider_message_id`, idempotency key now includes event type (a bounce after a delivery is no longer silently skipped), `send` events ignored (capturing on send AND delivery double-charged), partial batch failures, marks rows delivered/bounced.
- [x] Nightly reconciliation: EventBridge cron (03:00 UTC) → `reconcile-billing.ts` releases the unsettled remainder of >72h-old PENDING holds; RECONCILED status prevents double-release; error alarm → ops topic.
- [x] Stripe deposit UPSERTs the balance row (first-ever deposit used to update zero rows and vanish).
- [x] Bulk contact import wrapped in a single transaction (passes 1–3 commit or roll back together).
- [x] 13 Postgres integration tests run the real migration SQL and prove: auth/capture/refund math, insufficient-funds rejection, **concurrent authorizations can't overdraw**, concurrent settlements serialize, late events clamp at zero, sweep idempotency. CI runs them against a postgres:16 service.

**Deferred within M2 scope:** future-scheduled campaigns are authorized when they fire (scheduled sends themselves are M5); auto-recharge below threshold is M6 (billing dashboard work).

### Milestone 3 — Compliance is real (≈2 weeks) — ✅ DONE (June 11, 2026)
*Goal: the legal claims in the architecture doc are true.*

- [x] Right-to-be-forgotten (`lib/gdpr.ts` + `POST /contacts/{id}/forget`, admin+): transactional deletion matrix — profile hard-deleted, segment memberships cascaded, SHA-256 hashes retained on suppression (`gdpr_delete`), campaign history anonymized via FK SET NULL, inbox PII redacted, form submissions hard-deleted. Tenant-isolated and idempotent, proven by integration tests.
- [x] One-Click Unsubscribe (RFC 8058): email dispatch moved to SESv2 (v1 SendEmail cannot set headers) adding `List-Unsubscribe`/`List-Unsubscribe-Post`; public `/unsubscribe` endpoint hosted in the email stack (token = the recipient's `campaign_messages` UUID) feeding suppression + contact status + consent ledger.
- [x] Inbound SMS handler subscribed to `InboundSmsTopic`: logs to `sms_inbox`, STOP-family keywords → suppression + `opt_out` consent evidence, START → suppression removal + `opt_in`, HELP flagged.
- [x] Quiet hours (TCPA 8am–9pm local): engine compliance gate skips recipients *without claiming them* (re-queue later reaches them); explicit contact timezone enforced, unknown timezones use the conservative all-continental-US window (fail closed). HLR/CNAM lookups remain future work (M6).
- [x] Import validation shared by CSV pipeline and bulk API (`lib/contact-validate.ts`): email syntax + lowercasing, E.164 phone canonicalization, control-character stripping, custom fields capped to sanitized scalars, unreachable rows rejected.
- [x] 22 new tests: 8 Postgres integration (deletion matrix, unsubscribe idempotency, STOP/START round-trip) + quiet-hours/keyword/validation units + CDK assertions (public unsubscribe endpoint has NO authorizer; dispatch Lambda receives the URL).

**Deferred within M3 scope:** consent-evidence archival to S3 Glacier (4-year retention) and FTC DNC scrubbing (needs customer SAN) — both tracked for M6.

### Milestone 4 — Frontend hardening (≈2 weeks) — ✅ DONE (June 12, 2026)

- [x] Optimistic-update rollback: `updateContact`/`updateCompliance` snapshot before mutating, restore on API rejection, toast the error, and return it to callers. `importContacts` awaits every upsert chunk (`Promise.allSettled`), reports full/partial server failure to the wizard, and a ref guard rejects overlapping imports.
- [x] Error boundaries (`app/error.tsx`, `app/global-error.tsx`) — render errors no longer white-screen the app; shared `LoadingState` replaces `return null` hydration gaps on six pages.
- [x] `store.ts` split into 10 domain modules under `app/lib/store/` behind a byte-compatible `useStore()` facade (zero page changes); store↔mappers import cycle broken. (`EmailBlockEditor`/`ImportWizard` decomposition deferred — large mechanical refactors with no behavior payoff; revisit when those features change.)
- [x] `as any` elimination was completed in M0's lint burn-down (typed API row models; 0 warnings enforced in CI).
- [x] Playwright smoke suite (`apps/frontend/e2e/`): rendering + hydration of all routes, sidebar navigation, settings, import-wizard dialog open/Escape-close, error-boundary canary. Runs as a dedicated CI job (browsers unavailable in the dev sandbox — network policy blocks the Playwright CDN; selectors grounded against the served app).
- [x] Accessibility baseline: dialog semantics + focus management + Escape on Modal, auto-associated form labels via `useId`, `th scope`, toast `aria-live`, `aria-current` nav, aria-labels on every icon-only control.

### Milestone 5 — Operational readiness (≈2 weeks) — ✅ DONE (June 12, 2026)

- [x] Versioned migrations: `database/migrations/` registry + transactional, advisory-locked, `schema_migrations`-tracked runner; applied automatically on every deploy via CDK Trigger; current schema captured as idempotent `0001-baseline`. Integration tests prove apply/re-run/concurrency.
- [x] Stage-aware infra (`--context stage=dev|staging|prod`): prod RDS gets Multi-AZ, storage encryption, deletion protection, 14-day backups, RETAIN policies, t3.medium; PITR on the idempotency table. Stage-suffixed physical names let stages coexist in one account ('dev' keeps legacy names — no replacement). RDS Proxy still out (account tier); concurrency ceiling documented in `database-stack.ts` (~80 concurrent DB Lambdas on max_connections ≈ 100).
- [x] Staging + CD: `.github/workflows/deploy.yml` — staging auto-deploys on merge to main via GitHub OIDC; prod is `workflow_dispatch` behind the `production` environment approval gate.
- [x] WAF on API Gateway: per-IP rate limit (2000/5min) + AWS managed Common & KnownBadInputs rule sets; SES IAM grant scoped from `*` to account identities/configuration-sets.
- [x] Scheduled sends: campaigns with future `scheduled_at` are stored as `scheduled` and launched by a 5-minute EventBridge poller through a shared `launchCampaign` path (claim → authorization hold → queue) used by the API too; insufficient funds parks the campaign as `paused`; queue failures revert the claim for retry. Race-proven by integration tests (4 concurrent launchers → exactly 1 send).

### Milestone 6 — Finish the claimed feature set (≈4–6 weeks, prioritize by go-to-market)

- Email: A/B testing, bounce/complaint rate guardrails (warn 2%/pause 4%), VDM per-tenant metrics, Gmail sunsetting.
- SMS: 10DLC registration flow, number provisioning, encoding-aware composer, URL shortener, Redis token-bucket TPS limiting.
- Voice: Outbound Campaigns API migration (`PutDialRequestBatch`), AMD voicemail drop, IVR builder.
- Analytics: Kinesis Firehose → S3 → Athena with PII tokenization; frontend dashboard.
- Webforms backend; workspace onboarding wizard; multi-workspace switcher.

---

## 4. Long-term sequencing

```
Month 1   M0 Safety net ──► M1 Dispatch reliability
Month 2   M2 Billing ─┬─► M3 Compliance        (M4 Frontend in parallel)
Month 3   M5 Ops readiness ──► private alpha on staging (own data only)
Month 4-5 M6 features prioritized by GTM ──► closed beta (real sends, low volume)
Month 6   guardrails proven, SES out of sandbox, 10DLC approved ──► GA
```

Gating rules worth enforcing:

1. **No real contact data until M3 (compliance) is done** — the GDPR stub and missing STOP handling are legal exposure, not tech debt.
2. **No production sends until M1 + M2 are done** — duplicate-send and unmetered-spend bugs are the two failure modes that destroy a messaging platform's economics and sender reputation simultaneously.
3. **Every milestone lands with tests in CI** — the codebase is at the size (17k LOC) where the absence of tests is the single biggest drag on velocity; retrofitting later costs multiples.

---

## 5. Bottom line

The hard architectural decisions here are already made, and made well — tenant isolation, queue-based dispatch, double-entry billing, and single-system-of-record are the right shape for this product. What's missing is not design but **verification and follow-through**: stubs presented as done, no tests, no pipeline, and reliability gaps in exactly the code paths (dispatch, billing, deletion) where failures are unrecoverable. Roughly 2–3 months of disciplined hardening turns this from a promising prototype into a foundation you can build a business on.
