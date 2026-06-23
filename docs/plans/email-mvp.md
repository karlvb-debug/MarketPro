# Email MVP — Create / Build / Manage / Send

> Status: E1 ✅ · E2 ✅ · E3 ✅ · E4 ✅ DONE (June 23, 2026) · E5 planned · Created June 16, 2026
> Goal: a customer can design an email, save it, build a campaign from it,
> preview and test-send it, and trust that the audience receives exactly
> what they built — with the deliverability guardrails to do it safely.
> Email is the MVP channel (no 10DLC/carrier lead time; needs only SES
> production access).

---

## 1. The decisive finding: the builder is disconnected from the send path

The backend is **ready**: `email_templates` has `html_content` + `editor_json`
columns; the templates API persists both on create and update; `dispatch-email`
sends `template.htmlContent`.

The frontend is the broken link:

| Piece | State |
|---|---|
| Email builder (`email-builder/page.tsx`, `EmailBlockEditor.tsx`, 10 block types, MJML compile) | Real and capable — but saves the block design to **localStorage only** (`clq-email-design`) |
| `addEmailTemplate` (store) | POSTs only `{ name, subject_line }` — **never the compiled HTML or editor JSON** |
| Frontend `EmailTemplate` type | Carries no body (`htmlContent`/`editorJson`) at all |
| Result | Build an email → "save" → create a campaign → **dispatch sends a blank email** because `html_content` was never persisted |

So the #1 item is not new features — it's **connecting the builder to the
server template the dispatcher actually reads.** Almost all of this MVP is
frontend wiring + authoring essentials; the backend needs only a test-send
endpoint and (optionally) thumbnail support.

---

## 2. Phases

### E1 — Connect the builder to server templates (the critical fix) (~3 days) — ✅ DONE

*Without this, nothing else matters: campaigns send blank emails.*

- Extend the frontend `EmailTemplate` type + `mapApiEmailTemplate` to carry
  `subjectLine`, `previewText`, `htmlContent`, `editorJson`, `thumbnailUrl`.
- On **save** in the builder: compile the design to HTML (`compileToHtml`,
  already exists) and persist `{ name, subject_line, html_content,
  editor_json, preview_text }` via `api.templates.email.create/update`.
  `editor_json` is the source of truth for re-editing; `html_content` is what
  dispatch sends.
- On **edit**: load `editor_json` from the server template back into the
  builder (replacing the localStorage-first load). Keep localStorage only as
  a per-session **draft autosave** (unsaved-changes recovery), not the
  system of record.
- `updateEmailTemplate` in the store must send the body fields (today it only
  renames).
- Verify end to end against the running app: build → save → create campaign →
  the `campaign_messages`/SES path carries the real HTML. (Use the `verify`
  skill or a manual run.)
- Migration of existing localStorage designs: on first load, if a local draft
  exists and the server template has no `editor_json`, offer "import your
  local draft" once; otherwise drop the key cleanly (mirror the C5 views
  migration decision).

### E2 — Authoring essentials (~4 days) — ✅ DONE

*The things a sender needs before trusting a blast.*

- **Test send** — "Send a test to…" an arbitrary address. New backend
  `POST /templates/email/{id}/test-send { to }`: renders the template,
  applies sample/merge-tag-preview values, sends one email via SES, **bypasses
  segments, billing holds, and suppression** (it's an internal test), rate-
  limited per workspace. Frontend button in the builder + template list.
- **Live merge-tag preview** — toggle that resolves `{{first_name}}` etc.
  against a sample contact (or the first real contact in a chosen segment),
  so the user sees the personalized result. The merge-tag engine already
  exists in dispatch; mirror its replacement client-side for preview.
- **Subject + preheader/preview text** as first-class fields in the builder
  header (preview text drives inbox snippet; currently absent).
- **Desktop / mobile preview** toggle and a plain-text/raw-HTML peek.
- **Pre-send compliance surfacing** — `validateEmailCompliance` already
  exists; surface its results (missing unsubscribe, missing physical address,
  image-heavy/spam-trigger warnings) as a checklist in the builder and block
  save/send on hard failures (e.g. no unsubscribe — RFC 8058 is wired in
  dispatch, but CAN-SPAM physical address must be present).

### E3 — Template management (~3 days) — ✅ DONE (with one carve-out)

*Browse, reuse, organize.*

> **Done:** duplicate (server copy), rendered email preview in the templates
> drawer (iframe of `html_content` — the plan's degrade-to-iframe path,
> chosen over generating image thumbnails for the MVP), inline rename
> (server-backed). Delete/rename already hit the server.
> **Carved out → E3b (folder persistence):** template **folders are
> client-only** — `addTemplateFolder` mints a local UUID, `load.ts` never
> loads folders, and `moveTemplateToFolder` updates local state without an
> API call (no template-folders API exists). Making folders server-backed
> (folders API + load + name↔folder_id mapping on templates) is its own
> self-contained task; deferred rather than half-built.

- Email templates list on the templates page: thumbnail/preview card, last-
  edited, subject; "Edit in builder" round-trip; duplicate, rename, delete,
  move-to-folder (folder infra exists). Confirm these call the server, not
  local state.
- **Starter gallery** — a handful of built-in starter designs (welcome,
  newsletter, announcement, plain-text) seeded as `editor_json` the user can
  clone. Pure frontend (static design JSON).
- **Thumbnails** — generate a lightweight preview image on save (client-side
  canvas/`html-to-image`, upload to the existing S3 bucket via a presigned
  PUT, store `thumbnail_url`). Optional; degrade to a rendered-HTML
  `<iframe>` preview if skipped.

### E4 — Campaign-from-template + send confidence (~3 days) — ✅ DONE

*Turn a template into a trustworthy send.*

> **Done:** the campaign wizard now renders a live `srcDoc` preview of the
> actual template HTML (with sample merge-tag values) plus the audience count
> and estimated cost in the Details step; a **pre-send checklist** in the
> Review step grades subject / preview text / unsubscribe-&-footer compliance
> (`validateEmailCompliance` on the saved `editor_json`) / from-address /
> audience, with ✕ items hard-blocking the send and ! items warning; the
> launcher's **402** response surfaces as a "not enough credits" panel showing
> required / available / shortfall + eligible-recipient count instead of a
> generic error; and a success panel confirms the launch and points to the
> per-recipient delivery progress shown in the campaigns list.
> **Backend reality folded in:** the campaigns API launches any non-future
> campaign immediately (the old "Save as Draft" label actually sent), so the
> wizard now offers honest **Send Now** vs **Schedule for later** options. A
> true draft-without-send path needs a backend change (skip `launchCampaign`
> for explicit drafts) and is out of E4's frontend-only scope.
> **Carried forward:** a dedicated campaign **detail page** (per-recipient
> `campaign_messages` rows + C3 rollups) doesn't exist yet — E4 links to the
> list's progress bar; a full detail view is its own task.

- Campaign creation: when an email template is chosen, show a **preview** of
  the actual rendered email, the **audience count** (reuse
  `countEligibleRecipients` / segment count), and the **estimated cost**
  (reuse the authorization-hold estimate — the API already returns
  required/available on 402).
- **Pre-send checklist** modal: subject set, preview text set, from-address
  verified (SES identity), unsubscribe present, audience > 0, sufficient
  credits. Block send on hard failures, warn on soft ones.
- Surface the **402 insufficient-credits** response (from the launcher) as a
  clear "add credits" prompt rather than a generic error.
- After send: link to the campaign's per-recipient progress (the
  `campaign_messages` rows + engagement rollups from C3 already exist).

### E5 — Deliverability readiness (the email-specific M6 slice) (~4 days)

*Make a real beta send safe. Partly backend.*

- **SES domain auth UI** — surface DKIM/SPF/DMARC status and the records to
  add (the SES identity exists in `email-stack`); block production sends from
  unverified domains. Note the **SES sandbox exit** as the external gate
  (like 10DLC is for SMS, but far lighter).
- **Bounce/complaint guardrails** — the architecture plan's thresholds (warn
  2% / pause 4% bounce; warn 0.08% / pause 0.4% complaint). The event
  pipeline already records bounces/complaints (C3 + billing-capture); add a
  rolling per-workspace rate check that auto-pauses dispatch (a global kill
  switch per workspace) and surfaces the rates in the UI.
- **From-address / reply-to management** in settings, validated against SES
  verified identities.

---

## 3. What's backend vs frontend

- **Frontend-only**: E1 (all), E2 (merge preview, subject/preheader,
  previews, compliance surfacing), E3 (all), E4 (all).
- **Small backend**: E2 test-send endpoint; E3 thumbnail presign (reuses the
  bucket); E5 bounce/complaint rate monitor + auto-pause + SES status
  read-API.
- **External (not code)**: SES production access request.

## 4. Sequencing & the critical path

```
E1 (connect builder ↔ server)  ←★ blocks everything; do first
     │
     ├─► E2 (authoring essentials: test-send, preview, compliance)
     │
     ├─► E3 (template management) — parallelizable with E2
     │
     └─► E4 (campaign-from-template + send confidence)
                │
                └─► E5 (deliverability readiness) ──► email beta
```

~2.5–3 weeks. **E1 is the hard gate** — until the builder persists the body to
the server, the product silently sends blank emails, so it ships first and
gets an end-to-end verification before anything builds on it. E2 and E3 run in
parallel. E5 is the bridge to a real beta send and pairs with the SES
sandbox-exit request (start that paperwork when E1 lands, since it's external).

## 5. Tests

- E1: an integration test that a saved template's `html_content` round-trips
  and is non-empty after build→save (the dispatch path already has engine
  tests that send `htmlContent`); a frontend check that edit loads
  `editor_json`.
- E2: test-send endpoint integration test (renders + sends via a faked SES
  client; bypasses segments/billing/suppression; rate-limited). Merge-tag
  preview unit test mirroring the dispatch replacement.
- E3/E4: Playwright smoke — build → save → appears in list → create campaign
  → preview renders → checklist gates.
- E5: rate-threshold unit tests (warn/pause boundaries) + auto-pause
  integration test.

## 6. Explicitly out of scope (later)

- A/B split testing (M6) — needs this send flow solid first.
- Drag-to-reorder polish beyond what `EmailBlockEditor` already does.
- Gmail engagement sunsetting (M6 deliverability; uses C3 rollups).
- AMP email / dynamic content blocks.
