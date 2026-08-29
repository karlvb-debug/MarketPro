# Vercel deployment — MarketPro frontend + API

> Status: project not yet created — blocked on the GitHub App repo grant (§1).

The Next app in `apps/frontend` now carries the API too (M3), so one Vercel
project serves both the portal and `/api/*`.

## 1. Link the repository

Creating the project fails with *"you need to install the GitHub integration
first"* until the Vercel GitHub App can see this repo. The app is already
installed on the account (it links `notyilus` and `c-ccrm`), so what is
missing is the per-repository grant:

- https://github.com/apps/vercel → **Configure** → `karlvb-debug` → add
  `marketpro` to the selected repositories.

Then create the project with:

| Setting | Value | Why |
|---|---|---|
| Repository | `karlvb-debug/marketpro` | |
| Root directory | `apps/frontend` | monorepo; Vercel installs from the repo root so the `@repo/core` workspace resolves |
| Framework | Next.js (auto-detected) | |

`packages/core` ships TypeScript source with no build step, which is why
`next.config.js` sets `transpilePackages: ['@repo/core']`. Nothing extra is
needed on the Vercel side.

## 2. Environment variables

Set these in **Project Settings → Environment Variables**. They cannot be set
through the Vercel MCP tools, so this step is manual.

| Variable | Secret? | Where it comes from |
|---|---|---|
| `DATABASE_URL` | **yes** | Supabase → Database → Connection string. Use the **transaction** pooler (port 6543) for serverless functions. |
| `NEXT_PUBLIC_SUPABASE_URL` | no | `https://cxdmbpyuoptmjmnuuldq.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | no | the publishable key (`sb_publishable_…`) |
| `SUPABASE_SERVICE_ROLE_KEY` | **yes** | Supabase → API keys → `service_role`. Server-only: it bypasses RLS, so it must never reach the browser. |
| `DATABASE_CA_CERT` | no | Supabase project CA (PEM). Optional but recommended — without it the DB connection is encrypted **but the certificate is not verified**. |

Nothing is needed at build time: every `/api/*` route is dynamic, so a build
succeeds without database access. Missing variables surface at request time,
not as a failed build.

### Connection mode is not a free choice

- **Serverless functions → transaction mode (6543).** The runtime code is
  clean for this: the audit found no `LISTEN`/`NOTIFY`, temp tables,
  `SET LOCAL`, or prepared statements. The one `db.transaction()` (contact
  import) is fine — transaction-mode poolers pin a connection for a
  transaction's duration.
- **Migrations → session mode (5432).** `runMigrations()` takes a
  session-scoped `pg_advisory_lock`, which transaction mode will not hold.
  Do not run migrations through the 6543 endpoint.

## 3. Deploying this work

The migration lives on `claude/migration-plan-hzcvei`; `main` predates M3 and
has no `/api` routes, so a production deploy from `main` would test nothing.
Deploy a **preview from the feature branch** instead.

Note before merging to `main`: `.github/workflows/deploy.yml` still runs
`cdk deploy --all` on every push to `main`, against an AWS account that is
closed. It can only fail. Retiring it is M7 work, but it should go before or
with the merge.

## 4. What a deploy is actually for

It closes the last open item in M2. The build sandbox permits HTTPS egress
only — Postgres ports time out — so the integration suite has never run
against Supabase. A deployed preview runs in an environment that *can* open a
Postgres socket, which makes it the first real end-to-end check of the ported
route handlers against the live database.

Worth exercising once deployed, in order:

1. `GET /api/workspaces` — auth + the first real query. Auto-provisions a
   workspace on first call for a new user.
2. `GET /api/batch` — the widest read path (six parallel queries).
3. `POST /api/contacts` then `GET /api/contacts` — write, custom-field
   validation, and keyset pagination.
4. `POST /api/segments/preview-count` — the rule engine compiling to SQL.
