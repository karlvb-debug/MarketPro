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

### Milestone 0 — Safety net & hygiene (≈1 week)
*Goal: every subsequent change is verified by a machine, and the repo leaks nothing.*

- [ ] Remove `cdk-outputs.json` and `contact-utils.ts.bak` from git; add to `.gitignore`; rotate/recreate any resources whose identifiers matter.
- [ ] Fix Stripe secret handling — resolve the Secrets Manager ARN at runtime like `db.ts` does.
- [ ] Fix jest config (`@types/jest`); replace the placeholder infrastructure test with real CDK assertions.
- [ ] Burn down the 189 lint warnings (mostly `no-explicit-any`, unused imports, hook deps).
- [ ] GitHub Actions CI: install → lint → check-types → test → build on every PR; block merge on red.
- [ ] Dependency pass: upgrade Next.js/turbo, replace `xlsx`, remove root `cheerio`/`mjml-browser`, enable Dependabot.
- [ ] Rewrite README for MarketPro (setup, deploy, architecture pointer).

### Milestone 1 — Dispatch reliability (≈2 weeks)
*Goal: a campaign send is exactly-once, resumable, and observable.*

- [ ] Paginate segment fetches in all three dispatch Lambdas (keyset batches, e.g. 500 contacts/iteration).
- [ ] Make dispatch idempotent: per-recipient send markers (DynamoDB or `campaign_messages` unique constraint) so SQS redelivery never re-sends.
- [ ] Error-handling triage: rethrow retryable errors (DB/network) so SQS retries; only swallow true poison pills; record per-recipient failures.
- [ ] Extract a shared dispatch core (fetch campaign/template/contacts, merge tags, suppression check, logging) used by all three channel Lambdas; share the DB client with the authorizer.
- [ ] CloudWatch alarms: DLQ depth > 0, Lambda error rate, RDS connections/CPU; structured JSON logging (lambda-powertools).
- [ ] DLQ redrive runbook or consumer Lambda.

### Milestone 2 — Billing correctness (≈2 weeks)
*Goal: nobody can spend money they don't have; nobody gets double-charged.*

- [ ] Call `authorize_campaign_funds()` at campaign schedule time; reject if insufficient balance; release/capture on delivery events.
- [ ] Per-workspace pricing config table replacing the hardcoded `$0.01`.
- [ ] Nightly reconciliation cron (EventBridge) sweeping stale holds > 72h.
- [ ] Single transaction wrapping all passes of bulk contact import (currently pass 2 failure orphans pass 1 rows).
- [ ] Integration tests for the ledger: auth → capture, auth → refund, duplicate event, concurrent capture.

### Milestone 3 — Compliance is real (≈2 weeks)
*Goal: the legal claims in the architecture doc are true.*

- [ ] Implement right-to-be-forgotten per the Data Retention Matrix: hard-delete profile, SHA-256 hash into suppression, strip billing PII, tokenized analytics. Tests proving each.
- [ ] One-Click Unsubscribe (RFC 8058) headers on every email + unsubscribe endpoint → suppression list.
- [ ] Inbound SMS handler: SNS topic → Lambda → STOP/HELP keyword processing → consent revocation chain (required before any production SMS).
- [ ] Quiet-hours enforcement in SMS dispatch using the timezone resolver (NPA fallback first; HLR lookups later).
- [ ] CSV import validation: email/phone normalization, field whitelist, custom-field sanitization.

### Milestone 4 — Frontend hardening (≈2 weeks, parallelizable with M2–M3)

- [ ] Rollback on failed optimistic updates; surface import success/failure to the user; remove silent catches.
- [ ] React error boundaries on route segments; loading states instead of `null` returns.
- [ ] Split `store.ts` into domain hooks (contacts/campaigns/templates/settings); decompose `EmailBlockEditor` and `ImportWizard`.
- [ ] Eliminate the `as any` casts by typing the API contract (consider generating types shared between Lambda handlers and the client).
- [ ] Smoke/E2E tests (Playwright) for the critical paths: login → import contacts → create segment → create campaign → send.
- [ ] Accessibility baseline: labels, alt text, keyboard navigation on the data table and modals.

### Milestone 5 — Operational readiness (≈2 weeks)

- [ ] Versioned migrations (drizzle-kit migrations or Flyway) replacing the imperative `db-migrate.ts`; run automatically on deploy.
- [ ] RDS: enable Multi-AZ + automated snapshots for production; add RDS Proxy (or document the concurrency ceiling without it).
- [ ] Staging environment + CD: GitHub Actions → `cdk deploy` to staging on merge, manual promotion to prod.
- [ ] WAF on API Gateway; scope the over-broad IAM grants (e.g. `ses:SendEmail` on `*` → identity-scoped).
- [ ] EventBridge scheduled sends (currently immediate-only despite UI accepting a schedule).

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
