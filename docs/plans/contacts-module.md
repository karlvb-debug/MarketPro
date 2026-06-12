# Contacts Module — Deep Feature Plan

> Status: PLANNED · Created June 12, 2026
> Goal: make contact management the strongest part of the product — typed
> custom fields, rule-based dynamic segments, server-side filtering and
> views, per-contact send history and consent evidence, dedup/merge, and
> bulk operations — all tenant-isolated, billing-aware, and dispatch-ready.

---

## 1. Where we are today

| Capability | Current state |
|---|---|
| Contact CRUD | Solid: cursor pagination, trigram search, two-pass dedup import, transactional bulk import, normalization (M3) |
| Custom fields | `custom_fields` JSONB passes through untyped; `custom_field_definitions` table **exists in schema but has no API, no validation, no UI** |
| Segments | Static membership lists only (`contact_segment`); folders exist; counts tracked client-side |
| Filtering | Client-side only, over the currently loaded page — filters don't apply to unloaded contacts |
| Saved views | localStorage only — lost across devices/users |
| Send history | `campaign_messages` has per-recipient rows (status, timestamps, cost) but **no per-contact API or UI** |
| Compliance | Per-channel model exists in the frontend, but DB stores a single `status` enum; suppression + consent ledger are real (M3) |
| Dedup/merge | Detection at import only; no merge tool for existing duplicates |

The biggest structural gap: **filters, segments, and views all operate on
different layers** (client memory, join table, localStorage). The plan
unifies them around one server-side rule engine.

---

## 2. Core architectural decision: one rule engine for everything

A single **filter-rule AST → SQL compiler** powers ad-hoc filtering, dynamic
segments, saved views, and campaign audience estimation. Rules are a JSON
tree:

```jsonc
{
  "combinator": "and",
  "conditions": [
    { "field": "status", "op": "eq", "value": "active" },
    { "field": "custom.plan", "op": "in", "value": ["pro", "enterprise"] },
    { "combinator": "or", "conditions": [
      { "field": "engagement.last_opened_at", "op": "within_days", "value": 30 },
      { "field": "created_at", "op": "within_days", "value": 7 }
    ]}
  ]
}
```

- **Field registry** (server-side whitelist): core columns, typed custom
  fields (`custom.<key>`, cast per definition type), engagement rollups,
  consent state, segment membership (`in_segment` / `not_in_segment`),
  import source. Nothing outside the registry compiles — injection-proof by
  construction, always workspace-scoped, depth/size-capped.
- **Operators by type**: text (eq/neq/contains/starts/ends/is_set), number &
  date (eq/gt/lt/between/within_days), select (in/not_in), boolean.
- **Evaluate-on-read** (JIT) — consistent with the architecture plan's state
  minimization: dynamic segments are queries, not synced membership rows.
  Static segments keep `contact_segment`. Counts are cached with a
  staleness timestamp.
- Compiler is a pure function with exhaustive unit tests plus
  Postgres integration tests (including hostile input).

Everything else in this plan composes with that engine.

---

## 3. Phases

### C1 — Typed custom fields + server-side filtering (~1 week)

*The foundation: the field registry must know about custom fields before
the rule engine can use them.*

- **Custom field definitions API** (`/custom-fields` CRUD, editor+):
  name, key (immutable once created), type (text/number/date/email/phone/
  url/select), required, unique, select options, sort order, archived flag.
- **Validation on every write path** (create/update/import/CSV pipeline):
  type coercion + validation per definition, required enforcement on create,
  unique enforcement per workspace (partial index on `(workspace_id,
  (custom_fields->>key))` created per unique field), unknown keys preserved
  but flagged.
- **Server-side filtering**: `GET /contacts` accepts a `rules` parameter
  (compiled by the rule engine) replacing client-side-only filtering; works
  with existing keyset pagination and count endpoint.
- **GIN index** on `custom_fields` (jsonb_path_ops) + normalized-phone
  expression index for filter performance.
- Frontend: settings page section for managing field definitions; table
  column picker including custom fields; ImportWizard map step offers
  defined fields (and create-field-on-the-fly for admins).

### C2 — Dynamic segments + campaign integration (~2 weeks)

- **Segment types**: `static` (today's lists) and `dynamic` (stored rule
  AST + cached count + `count_refreshed_at`). Schema: `segments.kind`,
  `segments.rules JSONB`.
- **Rule builder UI**: nested group/condition editor with type-aware
  operator/value inputs, **live count preview** (debounced server count),
  save as dynamic segment. Reuses the same component for ad-hoc filtering —
  "Save filter as segment" becomes one click.
- **Dispatch integration**: the dispatch store's `fetchContactsPage` and the
  launcher's `countEligibleRecipients` evaluate dynamic rules at send time
  (JIT audience, exactly the architecture plan's intent). Estimation,
  authorization holds, claims, suppression, and quiet hours all work
  unchanged because they sit downstream of the page fetch.
- **Membership preview**: `GET /segments/{id}/contacts` paginates either
  kind; static segments keep add/remove endpoints.
- Count cache refresh: on segment save + hourly cron + on-demand from UI.
- Guardrails: rule depth ≤ 5, conditions ≤ 50, query timeout, EXPLAIN-based
  cost cap on preview for very large workspaces.

### C3 — Send history, engagement & the contact timeline (~1 week)

- **Engagement rollups** (new columns on `contacts`, denormalized):
  `total_sent`, `total_delivered`, `total_opened`, `total_clicked`,
  `last_sent_at`, `last_engaged_at`. Updated by the billing-capture/event
  pipeline (idempotent increments keyed off campaign_messages transitions).
  These feed segment rules ("opened in last 30 days") and, later, Gmail
  engagement sunsetting (M6 deliverability).
- **Per-contact history API**: `GET /contacts/{id}/timeline` — unified,
  paginated, composed from existing tables (no new event store yet):
  campaign sends (joined to campaign name/channel/status/cost), consent
  ledger entries, inbox messages, import/created provenance, GDPR-safe.
- **ContactCard upgrade**: tabs — Profile / Activity timeline / Engagement
  stats / Consent evidence (the TCPA ledger view: source, timestamp,
  channel, revocation chain — this is a selling point, surface it).
- Per-channel consent display driven by real data (suppression list +
  consent ledger) instead of the frontend-only compliance model — closes
  the model mismatch.

### C4 — Data quality: dedup, merge, bulk operations (~1.5 weeks)

- **Duplicate report**: `GET /contacts/duplicates` — clusters by normalized
  email/phone collision across the workspace (import-time dedup misses
  pre-existing and cross-key duplicates).
- **Merge API** (`POST /contacts/merge`, admin+, transactional): survivor +
  duplicates; field precedence (survivor wins, nulls filled from
  duplicates), custom fields deep-merged, segment memberships unioned,
  `campaign_messages`/`consent_ledger`/inbox FKs repointed, suppression
  union, duplicates hard-deleted. Audited (who merged what, when).
  Interplay with GDPR erasure covered by integration tests.
- **Bulk operations** (rule-selection aware — "all contacts matching this
  filter", not just checked rows): bulk edit fields, bulk add/remove
  segment, bulk consent change (writes ledger evidence per contact), bulk
  delete (existing) and bulk export.
- Merge UI: side-by-side compare with per-field pick.

### C5 — Views, search, export at scale (~1 week)

- **Server-side saved views**: `views` table (per user per workspace —
  rules + visible columns + sort), replacing localStorage; shared
  workspace views for admins.
- **Search upgrades**: normalized-phone search, custom-field search
  (specific keys opted into the trigram strategy), combined relevance
  ordering.
- **Async export**: filtered export → S3 → presigned download link
  (Step Function for >50k rows), honoring the same rule engine; CSV with
  selected columns including custom fields.
- Segment count freshness indicators in UI; contacts list virtualization
  if needed at 100k+ rows.

---

## 4. Schema changes (one migration per phase)

| Migration | Contents |
|---|---|
| `0002-custom-field-validation` | (none structural — partial unique indexes created dynamically per unique field definition; GIN index on custom_fields; phone expression index) |
| `0003-dynamic-segments` | `segments.kind` ('static'/'dynamic'), `segments.rules JSONB`, `segments.cached_count`, `segments.count_refreshed_at` |
| `0004-engagement-rollups` | engagement counters + timestamps on `contacts`; backfill from `campaign_messages` |
| `0005-views` | `views` table (workspace, user, name, rules, columns, sort) |
| `0006-merge-audit` | `contact_merge_log` (workspace, survivor, merged_ids, merged_by, snapshot JSONB) |

All additive; the M5 migration runner handles ordering and deploy-time
application.

## 5. Testing strategy

- **Rule compiler**: exhaustive unit tests per operator/type + hostile-input
  suite (injection attempts, unknown fields, depth bombs) + Postgres
  integration tests verifying compiled SQL semantics.
- **Custom field validation**: per-type matrices; unique/required
  enforcement integration tests.
- **Merge**: full-blast-radius integration tests (like the GDPR suite) —
  FK repointing, segment union, suppression union, audit row, erasure
  interplay.
- **Dispatch with dynamic segments**: engine tests with a rules-backed
  store; launch estimation parity test (estimate count == dispatched count
  on a fixed fixture).
- **E2E additions**: rule builder smoke (build filter → count preview →
  save as segment), ContactCard timeline tab render.

## 6. Sequencing & dependencies

```
C1 (fields + server filtering)  ──►  C2 (dynamic segments)  ──►  C3 (timeline/engagement)
                                                │
                                                └──►  C4 (dedup/merge/bulk)  ──►  C5 (views/search/export)
```

~6–7 weeks of focused work. C1→C2 is the critical path (the rule engine).
C3 can run parallel to C4. Each phase ships independently behind the
existing CI/CD gates and is useful on its own.

## 7. Explicitly out of scope (tracked elsewhere)

- FTC DNC scrubbing (needs customer SAN — M6 compliance)
- Third-party email validation at import (M6, external vendor choice)
- HLR/CNAM timezone lookups (M6 SMS)
- Real-time CRM webhook sync (architecture plan Module A — after this module)
