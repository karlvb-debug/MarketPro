# CLAUDE.md — MarketPro

Multi-channel marketing platform (email MVP). Turborepo: `packages/core`
(portable domain logic + schema + migrations), `apps/frontend` (Next.js 16,
React 19) + `apps/infrastructure` (AWS CDK, Lambda — being retired, see
`docs/plans/aws-exit.md`). Architecture: `architecture_plan.md`. Status & roadmap:
`FOUNDATION_REVIEW.md`. Active plans: `docs/plans/`.

> Sessions are ephemeral (fresh clone). Nothing survives but the repo — commit
> work that matters, and trust this file over re-deriving conventions.

## Verify before you call something done

From the repo root, this gate must pass — it's what CI runs:

```
TEST_DATABASE_URL=postgresql://marketpro:marketpro@localhost:5432/marketpro_test \
  npx turbo run lint check-types test build
```

- Lint is **zero-warning** (`--max-warnings 0`). Don't relax it; fix the code.
- Postgres is needed for tests: `sudo service postgresql start`; the
  `marketpro_test` DB/user is created by the SessionStart hook (or by hand —
  see git history). Integration tests **skip** without `TEST_DATABASE_URL`, so
  always run with it set or you'll get false green.

## Testing conventions

- Integration tests run against **real Postgres**, never a mock. Pattern:
  `runMigrations(pool)` in `beforeAll`, a fresh workspace per test for
  isolation, `closePool()` in `afterAll` if the code under test uses the
  shared singleton pool (`@repo/core/db`). See `packages/core/test/*.int.test.ts`.
- Pure logic (rule compiler, CSV escaping, error triage, validators) has
  fast unit tests with a hostile-input section where untrusted input enters.
- CDK stacks have assertion tests (`apps/infrastructure/test/infrastructure.test.ts`); bundling is
  skipped via the test App context.

## Package boundary — `packages/core` vs `apps/infrastructure`

`@repo/core` holds everything portable: it depends on Postgres and nothing
else, and has **zero** AWS imports. Both the Lambda handlers today and the Next
route handlers after M3 import the one copy.

- Domain logic, schema, and migrations go in `packages/core/src/`. If you find
  yourself adding an `@aws-sdk/*` or `aws-lambda` import there, it belongs in
  an adapter instead.
- `apps/infrastructure` is the AWS adapter layer (CDK stacks, handler shims,
  `lambda/lib/db.ts` API-Gateway helpers, `lambda/dispatch/sqs-handler.ts`).
  It is scheduled for deletion — don't grow it. Its `lambda/api/*` handlers
  are thin adapters over `@repo/core/api/*` (`lambda/lib/adapt.ts` does the
  event↔`ApiResult` translation); the only logic left in them is the
  AWS-specific side-effects they inject.
- HTTP lives in `packages/core/src/api/`: handlers are
  `(ctx: RequestContext, input) => Promise<ApiResult>`, with side-effects that
  differ per platform (queue, object storage, async workers) taken as injected
  deps. Next route handlers in `apps/frontend/app/api/**` are thin adapters
  over them — put logic in core, not in a route file.
- Read untrusted request bodies through `@repo/core/api/input`
  (`str`/`num`/`bool`/`obj`/`strArray`), never off an `any`. Validate against
  the schema's own `pgEnum` values so accepted input can't drift from the
  database constraint.
- The dispatch engine is transport-agnostic on purpose: `processCampaignDispatch`
  takes a `requeue` callback and a time budget. SQS today, cron/pg-boss next;
  the engine itself must not learn about either.

## Load-bearing invariants — violating these causes real bugs

- **Rule engine is the only query path** for contact filtering / segments /
  bulk selection / export (`packages/core/src/rules.ts`). It's a whitelist AST→SQL
  compiler; values are **always bound parameters**. Never build a parallel
  query string or interpolate user input — that reintroduces injection.
- **Migrations are append-only.** Add
  `packages/core/src/database/migrations/NNNN-*.ts` and
  register it in `index.ts`; never edit an applied migration. They run
  automatically on deploy via a CDK Trigger; the runner is transactional and
  advisory-locked.
- **Dispatch is claim-before-send / exactly-once.** A unique
  `(campaign_id, contact_id)` claim row is inserted before the provider call,
  so redelivery/continuation never double-sends. Retryable errors propagate
  (transport retry → dead-letter); per-recipient errors are recorded and the
  campaign continues.
  Quiet-hours skips self-heal via delayed re-queue. Don't bypass the claim.
- **Billing authorizes then settles.** Campaign launch places an atomic
  authorization hold (insufficient funds → 402); delivery/bounce events
  settle against it. Never send without a hold or charge outside the ledger.
- **Email body lives server-side.** `email_templates.html_content` is what
  dispatch sends; `editor_json` is the builder's source of truth. The builder
  must persist both (this is the E1 work — see `docs/plans/email-mvp.md`).
- **Tenant isolation**: every query is workspace-scoped; the authorizer
  injects the role. Contact FKs are `SET NULL` (anonymize, keep aggregates)
  except `contact_segment` (CASCADE) — GDPR erasure and merge depend on this.

## Secrets & hygiene

- The DB connection is `DATABASE_URL`, supplied by the platform's own secret
  store (Vercel/Supabase env). Stripe creds likewise. **Never** hardcode a
  credential or commit one; `@repo/core/db` fails fast if `DATABASE_URL` is unset.
- **Never commit** `cdk-outputs.json` (real account/resource IDs) or `.bak`
  files; both are gitignored.

## Infrastructure

- Stage-aware: `cdk deploy --all --context stage=dev|staging|prod`. `dev`
  keeps legacy unsuffixed names; other stages are namespaced. `prod` gets
  Multi-AZ, encryption, deletion protection, backups.
- CD: push to `main` → staging; prod is a gated manual `workflow_dispatch`.

## Frontend conventions

- State is `useStore()` composed from domain slices in `app/lib/store/`
  (public API is byte-stable — don't change slice return shapes casually).
- Mutations follow **optimistic update → rollback on failure → `showToast`**
  (see `store/contacts.ts`). Surface API errors; never swallow them.
- Server-side everything: filtering, segments, views, export all go through
  the API. localStorage is for drafts only, not the system of record.

## Working agreement

- Develop on the designated feature branch. **Commit/push only when asked.**
- Commit trailer: `Co-Authored-By: Claude ...` + the session link (see git log
  for the exact format).
- For multi-file frontend surfaces, a sub-agent scoped to `apps/frontend` is
  the established pattern; always re-run the full gate before committing its work.
- Harness config lives in `.claude/`: a SessionStart hook
  (`hooks/session-start.sh`) starts Postgres + ensures the `marketpro_test` DB
  on fresh web sessions, and `settings.json` sets `TEST_DATABASE_URL`, allows
  the safe recurring commands, and keeps `git push` / `npm install` / `sudo`
  as explicit confirmations.
