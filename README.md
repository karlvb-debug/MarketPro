# MarketPro

Multi-channel bulk marketing platform (Email, SMS, Voice) built on native AWS services. A Next.js portal drives a serverless backend: API Gateway + Lambda over RDS PostgreSQL, with per-channel SQS dispatch queues feeding Amazon SES (email), AWS End User Messaging (SMS), and Amazon Connect (voice).

- **Architecture & design:** [architecture_plan.md](./architecture_plan.md)
- **Work tracking:** [TODO.md](./TODO.md)
- **Current-state assessment & roadmap:** [FOUNDATION_REVIEW.md](./FOUNDATION_REVIEW.md)

## Repository layout

```
apps/
  frontend/         Next.js 16 (App Router) user portal — contacts, segments,
                    campaigns, email builder, templates, inbox, settings
  infrastructure/   AWS CDK (TypeScript) — 9 stacks, Lambda handlers,
                    Drizzle ORM schema (23-table PostgreSQL)
packages/
  ui/               Shared React components
  eslint-config/    Shared ESLint flat configs
  typescript-config/ Shared tsconfig bases
```

Key infrastructure paths:

- `apps/infrastructure/lib/*.ts` — CDK stacks (database, auth, api, email, sms, voice, billing, contact-ingestion, analytics)
- `apps/infrastructure/lambda/api/*` — REST CRUD handlers behind the Lambda authorizer
- `apps/infrastructure/lambda/dispatch/*` — SQS-driven campaign dispatch per channel
- `apps/infrastructure/drizzle/schema.ts` — single system of record schema

## Prerequisites

- Node.js >= 22, npm >= 10
- For deploys: AWS credentials + CDK bootstrap in the target account, and two
  Secrets Manager secrets: `marketing-saas/stripe-secret` and
  `marketing-saas/stripe-webhook-secret` (plaintext secret values).
  RDS credentials are generated automatically at `marketing-saas/rds-credentials`.

## Common commands

Run from the repo root:

```sh
npm install            # install all workspaces
npm run dev            # start the frontend dev server (turbo)
npm run lint           # ESLint, zero-warning policy
npm run check-types    # TypeScript across all workspaces
npm test               # infrastructure CDK assertion tests (jest)
npm run build          # build all workspaces
```

## Deploying

```sh
cd apps/infrastructure
npx cdk deploy --all --outputs-file cdk-outputs.json
```

`cdk-outputs.json` contains live account/resource identifiers and is
intentionally gitignored — never commit it. Database migrations currently run
via the `db-migrate` Lambda (invoke manually after deploy); see
FOUNDATION_REVIEW.md M5 for the planned move to versioned migrations.

Optional deploy-time env vars:

- `SES_DOMAIN` — enables SES domain identity + managed dedicated IP pool
- `CORS_ORIGIN` — restricts API Gateway CORS (defaults are dev-friendly)

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs lint → type-check → test →
build on every PR and push to `main`. All four must pass; the lint step
enforces `--max-warnings 0`.
