# MarketPro — Master TODO

> Last updated: April 29, 2026

---

## Phase 1: Foundation, Workspaces & Contacts

### Infrastructure
- [x] Provision VPC, subnets, security groups (`database-stack.ts`)
- [x] Provision RDS PostgreSQL instance
- [x] Provision DynamoDB idempotency table
- [x] Provision Cognito User Pool & Identity Pool (`auth-stack.ts`)
- [x] Provision API Gateway + Lambda Authorizer (`api-stack.ts`)
- [x] Create 22-table Drizzle ORM schema (`drizzle/schema.ts`)
- [x] Create DB migration Lambda (`db-migrate.ts`)

### Auth & RBAC
- [x] JWT verification via `aws-jwt-verify`
- [x] Workspace RBAC — authorizer queries `users_workspaces` for role
- [x] Deny policy for unauthorized workspace access (IDOR fix)
- [x] `RequestAuthorizer` caches by Authorization + X-Workspace-Id
- [ ] Role-based route restrictions (editor can't delete, viewer is read-only)
- [ ] Super Admin Cognito Group + impersonation audit trail

### Contacts
- [x] Contacts CRUD Lambda (`contacts.ts`)
- [x] Cursor-based keyset pagination (no OFFSET)
- [x] Search by name, email, company
- [x] Bulk import endpoint (`POST /contacts/import`, 1,000 max)
- [x] Two-pass UPSERT (email-based + phone-only deduplication)
- [x] Bulk delete endpoint
- [x] Contact ingestion stack (S3 + Step Functions) (`contact-ingestion-stack.ts`)
- [x] CSV parser Lambda (`csv-parser.ts`)
- [ ] Wire ImportWizard.tsx to S3 upload for files > 1,000 rows
- [ ] FTC DNC scrubbing integration (requires SAN number)
- [ ] Third-party email validation API during import

### Segments
- [x] Segments CRUD Lambda (`segments.ts`)
- [x] Contact ↔ Segment many-to-many schema
- [ ] Dynamic segment rules (filter by status, source, custom fields)
- [ ] Segment count preview before campaign send

### Workspace Management
- [x] Workspaces CRUD Lambda (`workspaces.ts`)
- [x] Workspace settings Lambda (`settings.ts`)
- [ ] Workspace onboarding wizard (frontend)
- [ ] Multi-workspace switcher UI

---

## Phase 2: Email Engine

### Infrastructure
- [x] SES domain identity provisioning (`email-stack.ts`)
- [x] `EmailDispatchQueue` (SQS) with event-source mapping
- [x] `dispatch-email.ts` Lambda — SES `SendEmailCommand`
- [ ] SES Managed Dedicated IP provisioning (high-volume senders)
- [ ] CloudFront distribution for image asset hosting
- [ ] SES Configuration Set for delivery event tracking

### Email Builder
- [x] Email templates CRUD Lambda (`templates.ts`)
- [x] `/email-builder` frontend page
- [ ] GrapesJS drag-and-drop HTML editor integration
- [ ] Template thumbnail generation
- [ ] Merge tag preview (live `{{first_name}}` replacement)

### Campaigns
- [x] Campaigns CRUD Lambda (`campaigns.ts`)
- [x] Campaign → SQS queue routing by channel
- [x] `dispatch-email.ts` — merge tag replacement + per-contact sending
- [x] Campaign message logging to `campaign_messages` table
- [ ] A/B split testing (split segment, measure winner, auto-send remainder)
- [ ] Scheduled send via EventBridge (currently immediate only)
- [ ] One-Click Unsubscribe headers (RFC 8058)

### Deliverability
- [ ] SES VDM integration for per-tenant metrics
- [ ] Bounce rate monitoring — warn at 2%, pause at 4%
- [ ] Complaint rate monitoring — warn at 0.08%, pause at 0.4%
- [ ] Gmail engagement sunsetting (auto-suppress after 6 months inactive)
- [ ] Google Postmaster Tools integration (Pro feature)

---

## Phase 3: SMS Engine

### Infrastructure
- [x] ~~Pinpoint CfnApp / CfnSMSChannel~~ (removed — deprecated Oct 2026)
- [x] Migrated to AWS End User Messaging v2 (`SendTextMessageCommand`)
- [x] `SmsDispatchQueue` (SQS) with DLQ
- [x] `dispatch-sms.ts` Lambda — End User Messaging v2
- [ ] Phone number provisioning via End User Messaging API
- [ ] 10DLC registration flow + async approval handling
- [ ] Toll-Free Verification (TFV) flow

### SMS Features
- [x] SMS templates CRUD (via `templates.ts`)
- [x] SMS template UI modal in `templates/page.tsx`
- [ ] Encoding-aware composer (GSM-7 vs Unicode segment calculation)
- [ ] Custom URL shortener for click tracking (`txt.brand.com/xY7z`)
- [ ] Two-way messaging — inbound SNS topic + STOP/HELP handling

### Compliance
- [x] Timezone resolution Lambda (`timezone-resolution.ts`)
- [ ] Waterfall timezone engine integration (HLR/CNAM lookups)
- [ ] Quiet hours enforcement in dispatch Lambda
- [ ] ElastiCache Redis token bucket for 10DLC TPS rate limiting

---

## Phase 4: Voice Engine

### Infrastructure
- [x] Amazon Connect instance provisioning (`voice-stack.ts`)
- [x] `VoiceDispatchQueue` (SQS) with event-source mapping
- [x] `dispatch-voice.ts` Lambda — Connect `StartOutboundVoiceContact`
- [ ] Migrate to Outbound Campaigns API (`PutDialRequestBatch`) for bulk
- [ ] Contact Flow provisioning via CDK (`CfnContactFlow`)
- [ ] Connect Customer Profiles integration

### Voice Features
- [x] Voice script (SSML) templates in store
- [x] Voice script modal in `templates/page.tsx` with Polly voice selection
- [ ] IVR builder UI → Contact Flow translation
- [ ] AMD (Answering Machine Detection) voicemail drop
- [ ] Call recording and transcription

### Compliance
- [ ] STIR/SHAKEN A-Level attestation registration
- [ ] Carrier analytics registration (FreeCallerRegistry, First Orion, Hiya)
- [ ] Verifiable Regional Presence (no neighbor spoofing)
- [ ] Associate End User Messaging numbers with Connect

---

## Phase 5: Billing, Analytics & Compliance

### Billing
- [x] Stripe webhook Lambda (`stripe-webhook.ts`)
- [x] Double-entry ledger schema (`account_balances`, `transactions_ledger`)
- [x] Idempotent billing capture Lambda with DynamoDB + `SELECT FOR UPDATE`
- [x] Bounce/complaint → SHA-256 suppression list
- [ ] Campaign cost estimation + AUTHORIZATION hold at schedule time
- [ ] Nightly reconciliation cron (EventBridge → sweep stale holds > 72hrs)
- [ ] Auto-recharge via Stripe when balance < threshold
- [ ] Billing dashboard UI (credits, usage history, invoices)

### Analytics
- [x] Analytics stack scaffolded (`analytics-stack.ts`)
- [ ] Kinesis Firehose → S3 Data Lake streaming
- [ ] Athena table definitions for engagement events
- [ ] QuickSight dashboard integration
- [ ] PII Tokenization — UUIDs only in the Data Lake
- [ ] Frontend analytics dashboard with charts

### GDPR / CCPA Compliance
- [x] Right-to-be-forgotten Lambda (`right-to-be-forgotten.ts`)
- [x] Consent ledger schema
- [x] Suppression list with SHA-256 hashed PII
- [ ] Full Data Retention Matrix enforcement
- [ ] Consent evidence archival to S3 Glacier (4-year retention)
- [ ] Automated GDPR deletion orchestrator

---

## Security Fixes (from audit)
- [x] ~~IDOR cross-tenant data breach~~ — authorizer now validates workspace access
- [x] ~~OFFSET pagination~~ — replaced with cursor-based keyset pagination
- [x] ~~Null-email UPSERT duplicates~~ — two-pass import strategy
- [x] ~~Billing race condition~~ — SELECT FOR UPDATE row locking
- [x] ~~Silent auth expiry~~ — 401 auto-redirect to /login

---

## Frontend Polish
- [x] Contacts page with CRM table view
- [x] Import Wizard
- [x] Email builder page
- [x] Templates page (Email, SMS, Voice, WebForm modals)
- [x] Campaigns page
- [x] Inbox page (SMS, Email, Forms)
- [x] Settings page
- [x] Login page
- [ ] Workspace onboarding wizard
- [ ] Multi-workspace switcher in nav
- [ ] Campaign performance detail view
- [ ] Real-time campaign send progress indicator
- [ ] Mobile-responsive polish pass

---

## DevOps
- [x] Turborepo build orchestration
- [x] GitHub repo sync (karlvb-debug/MarketPro)
- [ ] CI/CD pipeline (GitHub Actions → CDK deploy)
- [ ] Staging environment
- [ ] WAF rules on API Gateway
- [ ] CloudWatch alarms for Lambda errors + SQS DLQ depth
