Title: AWS Bulk Marketing Tool Architecture Plan

Source: https://docs.google.com/document/d/e/2PACX-1vT77fiDMWwlvbs4PTiE3T5pJzH-7t92yPvdFwKwPc_G9ZADqKElod2501YyF-F9LMDiNp_bl78YapXJ/pub

---

[Report abuse](https://drive.google.com/abuse?id=AKkXjoythXNtEVZBG_pwmDQIYr5pKxu2kN1lw2KTisnffT0DX0WejWnO7_87SsYXJMc8IDrgdXwYhuna1LyIyEY:0&docurl=https://docs.google.com/document/d/e/2PACX-1vT77fiDMWwlvbs4PTiE3T5pJzH-7t92yPvdFwKwPc_G9ZADqKElod2501YyF-F9LMDiNp_bl78YapXJ/pub)
[Learn more](https://support.google.com/docs/answer/183965)

## 1. Executive Summary
This document outlines the architecture and implementation plan for a multi-channel bulk marketing platform (Email, SMS, Voice) built entirely on native AWS services. By leveraging AWS's managed messaging, database, and serverless compute services, the platform will be highly scalable, cost-effective, and capable of handling millions of outbound messages while tracking granular engagement metrics.
The core of this platform revolves around a highly decoupled, serverless orchestration engine (using AWS Step Functions and EventBridge), Amazon SES (for email delivery, templates, and reputation), AWS End User Messaging (for telecom compliance and SMS delivery), Amazon Connect (for advanced voice dialing, AMD, and IVR), and a Double-Entry Billing Ledger to track usage, apply markups, and reconcile asynchronously.

## 2. Core Service Mapping
Component
Service
Purpose
Frontend/Hosting
AWS Amplify, S3, CloudFront
Host the React/Vue web application for user portal.
Authentication
Amazon Cognito
Secure user login, MFA, and identity management.
API Layer
Amazon API Gateway, AWS Lambda
Serverless backend; Lambda Authorizers resolve Workspace permissions.
Primary Database
Amazon RDS (PostgreSQL)
The Single System of Record (Source of Truth) for Contacts, Consent, and Billing Ledgers.
Ephemeral State
Amazon DynamoDB
Strictly used for high-throughput ephemeral state (Idempotency keys, WebSocket connections, Support Audit Logs).
Contact Import
Amazon S3, AWS Step Functions
S3 for CSV uploads; Step Functions to orchestrate batch processing.
Campaign Orchestration
AWS EventBridge, SQS, Step Functions
EventBridge for scheduling; Step Functions for execution; SQS for strict rate limiting.
Email Engine
Amazon SES
Raw sending, domain authentication, and SES native templates.
SMS Engine
AWS End User Messaging (SMS)
Number provisioning, 10DLC registration, outbound/inbound routing.
Voice Engine
Amazon Connect (Outbound Campaigns)
High-volume outbound dialing, Answering Machine Detection (AMD), IVR, and live-agent handoff.
Analytics
Amazon Kinesis (Firehose), Athena, QuickSight
Streaming engagement events to S3, querying via Athena.
Billing & Payments
Stripe API, Amazon SQS, EventBridge
Stripe for MRR/usage payments; SQS for transactional billing events; EventBridge for reconciliation.

### Module A: Contact Management, Segmentation & State Minimization
- Single System of Record (State Consolidation):
- To eliminate race conditions and simplify compliance (GDPR/CCPA deletions), the platform enforces strict state minimization. Amazon RDS (PostgreSQL) is the sole persistent store for workspace configs, contact profiles, segments, consent, and billing.
- Campaign audiences are NOT synced to secondary stores. They are queried from RDS just-in-time during campaign execution and injected directly into stateless dispatch queues (SQS).
- Multi-Channel Ingestion:
- CSV Uploads: Users upload CSV files via the frontend to a secure Amazon S3 bucket. An S3 event triggers an AWS Step Function that parses the file in chunks (using Lambda), sanitizes data, and loads it into RDS.
- API & Webhooks: Expose API Gateway endpoints for real-time CRM syncs.
- Data Hygiene & Validation:
- Duplicate Detection & Merging: Automatically merge duplicates by phone number/email using PostgreSQL UPSERT rules.
- FTC/National DNC Integration & Scrubbing: Require users to input their FTC Subscription Account Number (SAN), manage billing for access beyond the 5 free area codes, and automate the legally required 31-day rolling scrubs to maintain safe harbor status.
- Pre-Send Verification: Integrate a third-party email validation API during import to flag risky emails.
- Contact Profiles & Consent Evidence System:
- TCPA Consent Ledger: The system enforces a strict, immutable "Consent Ledger" in RDS for SMS/Voice tracking the Source, Timestamp, exact Disclosure Text version, Purpose, and a complete Revocation Chain.
- GDPR/CCPA "Right to be Forgotten": Implemented via a strict Data Retention Matrix (see Section 5B) that balances consumer privacy rights with the platform's legal obligation to maintain TCPA defense records and financial billing accuracy.

### Module B: Email Marketing
- Domain, DNS & Deliverability Management:
- Core Authentication: Backend integrates with the Amazon SES API to generate DKIM, SPF, and DMARC DNS records.
- SES Sandbox Clarification: Note: The platform administrator must manually submit a request to AWS Support to move the master AWS account out of the SES sandbox prior to production launch. Once the master account is in production, individual verified tenant domains can send freely.
- Custom Tracking Domains: Configure custom subdomains (e.g., link.userdomain.com) to protect sender reputation.
- Dedicated IP & Warmup: For high-volume senders, provision SES Managed Dedicated IPs, which automatically handle IP warmup routing natively without requiring custom Lambda throttling or over-engineered warmup logic.
- Content, Personalization & Testing:
- Template Builder: The UI features a drag-and-drop builder (e.g., GrapesJS). HTML is saved as an Amazon SES Template.
- Asset Hosting: Images are served globally via Amazon CloudFront.
- Dynamic Merge Tags: Support personalization attributes (e.g., {{first_name}}) using SES's native replacement tags.
- A/B Testing (Split Testing): The backend splits the segment, measures the winner, and auto-sends to the remainder.
- Monitoring, Compliance & The Gmail Blindspot Mitigation:
- One-Click Unsubscribe (RFC 8058): Automatically inject List-Unsubscribe headers into every outgoing email. This ensures that when a user clicks the native "Unsubscribe" button in Gmail/Yahoo, a standardized HTTPS webhook or mailto event is routed back to the platform for instant suppression.
- Aggregate Domain Health (Google Postmaster Tools): Gmail does not return standard abuse complaints (ARF) to SES. Therefore, knowing exactly who marked a message as spam is impossible. Workspaces must verify sending domains with Google Postmaster Tools. The platform provides a "Pro" feature/integration guiding the user to authorize a Service Account email as a "Reader" in their Postmaster dashboard, allowing the platform to poll metrics safely.
- Engagement Sunsetting: Because the platform cannot rely on Gmail for individual spam reports, it enforces a strict "Sunset Policy" in RDS. If a Gmail recipient has not opened or clicked an email from the workspace in X months (e.g., 6 months), the system automatically suppresses them to protect the domain's inbox placement.

- Telephony Asset Lifecycle (Number Procurement & Association):
- Provisioning & Ownership: Utilize AWS End User Messaging API to search and purchase numbers. Numbers are strictly mapped to a specific workspace_id in RDS, defining absolute tenant ownership.
- Omnichannel Sharing: If a workspace utilizes both SMS and Voice, the system explicitly associates the End User Messaging number with the shared Amazon Connect instance via API, allowing the tenant to use a single, recognizable Caller ID for both texts and calls.
- Tenant Offboarding: Upon workspace deletion, numbers are unassociated from Connect, 10DLC campaigns are deactivated, and the number is either released back to AWS or ported out based on the user's request.
- Registration Flows: Submit brand and campaign data to AWS for 10DLC registration or Toll-Free Verification (TFV). Given TCR (The Campaign Registry) approval can take 2-14 days and involves manual vetting, the UI/UX must seamlessly accommodate this delayed state. SMS dispatching must remain locked until asynchronous AWS SNS webhooks confirm full approval.
- Content, Personalization & Link Tracking:
- Encoding-Aware Message Composer: A flat 160-character rule is insufficient and leads to billing disputes. The UI utilizes real-time, encoding-aware segment calculation.
- If strictly GSM-7 characters are used, segments are 160 characters (153 for multipart).
- If a single Unicode / UCS-2 character (e.g., an emoji, accented letter, or pasted "smart quote") is detected, the composer automatically alerts the user, drops the segment limit to 70 characters (67 for multipart), and instantly recalculates the estimated billing cost.
- Custom URL Shortener: Internal URL shortener using API Gateway & DynamoDB (txt.brand.com/xY7z) for precise click tracking.
- Scheduling, Sending & Compliance Enforcement:
- Dynamic Timezone & "Quiet Hours" Enforcement: The Step Function orchestrator utilizes a waterfall Timezone Resolution Engine:
1. Explicit Data: User-provided CRM timezone.
2. Third-Party HLR/CNAM Lookup: Real-time carrier lookup via specialized third-party compliance APIs (e.g., Telesign, Twilio Lookup) to determine the number's actual registered physical state. Note: Native AWS phone lookup APIs provide country/region data but do not provide reliable U.S. state/timezone data required for TCPA compliance, making this external API integration mandatory.
3. NPA Fallback with Safety Buffer: Buffered area code fallback (e.g., waiting until 11 AM EST to ensure it's safely 8 AM PST).
- Throughput & Queue Management: Dispatching uses Amazon SQS as a buffer. Since SQS natively controls concurrency rather than exact throughput (TPS), strict 10DLC permitted TPS limits will be enforced using an ElastiCache (Redis) Token Bucket algorithm inside the dispatch Lambdas.
- Two-Way Messaging & Mandatory Keywords:
- Inbound Routing: Inbound messages route to an SNS Topic.
- Automated Keyword Handling: Lambda natively supports STOP/UNSUBSCRIBE and HELP.

### Module D: Voice Calling (Amazon Connect Integration)
- Amazon Connect Tenancy Model (Pooled Instance):
- To avoid hitting strict AWS account limits (e.g., maximum Connect instances per account) and to minimize operational overhead, the platform utilizes a Single Shared (Pooled) Amazon Connect Instance rather than a siloed instance per tenant. Note: AWS Support must be proactively contacted to significantly raise default service quotas for "Concurrent active calls" and "Outbound calls per second" on this pooled instance before onboarding major clients.
- Logical Isolation Strategy: When a workspace provisions voice features, the backend provisions a dedicated Routing Profile and Queue. The shared numbers procured in Module C are associated here. Every outbound contact is injected with a workspace_id Contact Attribute to govern routing logic and data segregation.
- Orchestration & IVR (Amazon Connect Outbound Campaigns):
- Contact Flows (IVR): Users build IVR experiences within the UI, which translates into shared Amazon Connect Contact Flows. The flows use the injected workspace_id attribute to fetch workspace-specific Amazon Polly SSML scripts.
- Answering Machine Detection (AMD): Utilize Amazon Connect's native AMD. If a voicemail is detected, inject a pre-recorded "Voicemail Drop" and disconnect gracefully.
- Number Management & Reputation:
- Verifiable Regional Presence (No Neighbor Spoofing): Enforce a Verifiable Regional Presence strategy using the static, localized numbers owned by the workspace in Module C.
- STIR/SHAKEN Attestation & Caller ID Authentication: Register workspace business profiles to achieve "A-Level" STIR/SHAKEN attestation. Crucial Distinction: A-Level attestation solely verifies caller ID authenticity (anti-spoofing). It does not guarantee answer rates or prevent third-party analytics engines from applying "Spam Likely" labels.
- Spam Label Mitigation: To actively manage reputation, workspaces must systematically register their dedicated numbers with major carrier analytics databases (e.g., FreeCallerRegistry, First Orion, Hiya) and rely on the platform's telemetry to pause campaigns with chronically low answer rates or short durations.

### Module E: Multi-Brand Workspace Management (Agency Mode)
- Independent Workspaces (Modern AWS Resource Mapping):
- SES Tenant-Level Features & Virtual Deliverability Manager (VDM): The platform utilizes modern SES multi-tenant capabilities. A tenant_id is injected into all outgoing message tags, natively integrating with SES VDM for tenant-level metrics and reputation pausing.
- Data Isolation: All contact lists, segments, templates, and consent ledgers are strictly siloed in PostgreSQL using workspace_id foreign keys. Connect CTRs (Contact Trace Records) in the Data Lake are partitioned by the workspace_id Contact Attribute.
- Role-Based Access Control (RBAC):
- A single Cognito User can have different permission levels across different workspaces.

### Module F: Billing, Accounting & Immutable Ledger
- SaaS Base Subscription (MRR):
- Users pay a monthly SaaS platform fee via Stripe Billing.
- Double-Entry Pre-Paid Ledger (Accounting Discipline):
- Billing state is strictly maintained in PostgreSQL using a double-entry accounting ledger to ensure zero orphaned credits.
- Every workspace has an Account_Balance table and a Transactions_Ledger table.
- Authorization vs. Capture: When a campaign is scheduled, the orchestrator queries RDS, calculates the estimated cost, and creates an AUTHORIZATION entry (putting credits on hold).
- Idempotent Event Processing (SNS Fan-Out to SQS):
- As delivery, bounce, and failure events are generated by AWS services, they are published to a central Amazon SNS Topic.
- SNS fans out these events to an Amazon SQS Billing Queue. A Lambda function consumes from this queue, ensuring guaranteed delivery and DLQ (Dead Letter Queue) capabilities for financial transactions.
- Crucial: To handle carrier delays and duplicate webhook firings, DynamoDB is used strictly as an Idempotency Store. The Message_ID acts as the primary key with a 7-day TTL. If an event ID already exists in DynamoDB, the billing Lambda safely discards it, preventing double-charging. If new, it executes a CAPTURE or REFUND in the RDS ledger.
- Asynchronous Reconciliation:
- Carrier events can be lost or delayed by days. An EventBridge Cron Job runs a nightly reconciliation process. It compares authorized campaign holds in RDS against captured delivery receipts. Any authorizations older than 72 hours without matching delivery receipts are automatically refunded to the user's ledger.
- Auto-Recharge:
- Auto-charge via Stripe when the available ledger balance falls below a threshold.

- Super Admin Identity: Separate Cognito Group for your internal company employees.
- Secure Support Access (Zero-Trust Impersonation):
- "Impersonation" is inherently risky. To prevent abuse, support access requires:
1. Step-Up Authentication: Support agents must pass a fresh MFA prompt to initiate the flow.
2. Reason Codes: The agent must supply a valid Zendesk/Jira ticket ID.
3. Short-Lived Sessions: The generated impersonation JWT is strictly bound to a 15-minute expiration.
4. Immutable Audit Logs: Every API request executed under the impersonated token is logged to a write-only DynamoDB Audit Table.
- Global Kill Switches: API endpoints for Super Admins to instantly pause a specific workspace's SES/SNS queue or Connect dialer.

### A. Data Ingestion & Hygiene Pipeline
1. Upload: User uploads CSV to S3 Bucket.
2. Orchestration: Step Functions process chunks via Lambda.
3. Validation: Scrubbed against FTC DNC registries and deduplicated.
4. Storage: Clean records persisted directly to Amazon RDS (Single System of Record).

### B. Campaign Orchestration & Dispatch Pipeline
1. Trigger: Amazon EventBridge triggers the Campaign Orchestrator.
2. Segmentation & Authorization: Lambda queries RDS to generate the segment, calculates estimated cost, and creates a hold in the RDS Double-Entry Ledger.
3. Queueing: Push message jobs directly to Amazon SQS with workspace routing rules and a unique Message_ID.
4. Dispatch: SQS consumers pull at allowed TPS rates, verify the Timezone Resolution Engine, and fire API calls to SES, End User Messaging, or Amazon Connect Outbound Campaigns.

### C. Inbound Interaction Pipeline (Two-Way)
1. Inbound Event: Carrier routes reply to AWS -> Amazon SNS / Connect.
2. Processing: Lambda looks up the workspace_id, logs the reply to RDS, and processes STOP flags into the Revocation Chain.

### D. Telemetry, Billing & Reconciliation Pipeline
1. Event Generation: SES/SMS/Connect generate downstream status events.
2. Canonical Event Bus (Fan-Out): Events are published to a central Amazon SNS Topic, acting as the canonical event router.
3. Cold Storage & Analytics: SNS forwards a copy of every event to Amazon Kinesis Data Firehose, which batches JSON into the S3 Data Lake (queried by Athena).
4. Idempotent Billing Capture: SNS forwards a second copy to an Amazon SQS Billing Queue. A Lambda monitors this queue, checks the Message_ID against DynamoDB (Idempotency Store), executes financial mutations in the RDS Ledger, and updates suppression lists.
5. Reconciliation: A nightly cron job sweeps RDS for stale authorizations and executes final account true-ups.

### A. State Minimization & Guardrails
- Idempotency: Keep transactional state firmly in PostgreSQL. Use DynamoDB strictly for high-throughput, ephemeral TTL storage. Design all event-driven functions to be fully idempotent so retries never corrupt billing.
- Multi-Workspace Isolation: A Lambda Authorizer validates the user's JWT token, verifies permission to access the workspace_id header, and securely injects that ID into the downstream execution context to enforce RDS Row-Level Security.
- Deliverability Guardrails: * Bounce Rates: Trigger a warning to the tenant at 2%, pause at 4%.
- Complaint Rates: Trigger a warning at 0.08%, pause at 0.4%.

### B. Data Retention & Anonymization Matrix (GDPR / TCPA Conflict Resolution)
A naive "delete everything" button creates massive legal and financial liabilities. When a contact requests their "Right to be Forgotten," the system executes the following retention matrix:
- Operational Data (RDS Profiles): Hard deleted. Names, custom attributes, and CRM data are permanently purged.
- Consent & Suppression Ledger (RDS): PII is cryptographically hashed (e.g., SHA-256 of the phone number). The hash is retained on the Suppression List to guarantee the platform never contacts them again, and the original consent evidence is archived in S3 Glacier for 4 years (the standard TCPA statute of limitations).
- Billing Ledger (RDS): Transactional records (costs/credits) are retained for 7 years to comply with IRS/accounting laws, but are stripped of the recipient's PII.
- Analytics Event Trails (S3/Athena Data Lake): To avoid complex Data Lake partition rewriting, the platform utilizes PII Tokenization. The S3 Data Lake only stores anonymous internal UUIDs for engagement metrics. By deleting the UUID mapping in RDS (Operational Data), the Data Lake metrics are instantly and irreversibly anonymized.

### Phase 1: Foundation, Workspaces, & The Immutable Ledger (Months 1-2)
- Provision VPCs, Cognito, API Gateway, and PostgreSQL (RDS).
- Build Workspace switching architecture, Lambda Authorizers, and the Support Impersonation Audit Logs.
- Implement the Double-Entry Accounting schema in RDS and DynamoDB idempotency tables.

### Phase 2: Data Pipeline & Email Core (Month 3)
- Build Step Functions for CSV ingestion and the core Consent Ledger schema.
- Integrate Amazon SES, leveraging SES Managed Dedicated IPs and VDM. Build feedback loops.
- Deploy CloudFront for image asset hosting and GrapesJS template builder.

### Phase 3: SMS, Telephony Compliance, & Idempotent Billing (Month 4)
- Integrate AWS End User Messaging for phone numbers and 10DLC.
- Build the Waterfall Timezone Resolution Engine (with third-party API integration) and FTC SAN 31-day scrubbing logic.
- Implement the SNS -> SQS fan-out architecture for asynchronous billing capture.

### Phase 4: Voice & Amazon Connect (Month 5)
- Provision the pooled Amazon Connect instance and configure dynamic Contact Flows for IVR.
- Explicitly share/associate End User Messaging numbers to Connect.
- Integrate Connect Outbound Campaigns for dialing and AMD.
- Implement STIR/SHAKEN and third-party analytics registry for spam label mitigation.

### Phase 5: Analytics, Compliance Deletion & Beta Launch (Month 6)
- Complete Athena/QuickSight integration utilizing PII Tokenization and workspace_id filtering.
- Build the automated "Right to be Forgotten" orchestrator based on the Data Retention Matrix.
- Security audits, WAF tuning, and private beta rollout.

