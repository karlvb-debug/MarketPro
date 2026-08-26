// ============================================
// Contacts API — the largest surface in the app.
//
// GET    /contacts                  — list (paginated, searchable, filtered)
// POST   /contacts                  — single upsert
// GET    /contacts/{id}             — read
// PUT    /contacts/{id}             — update
// DELETE /contacts/{id}             — delete (admin)
// DELETE /contacts                  — bulk delete (admin)
// POST   /contacts/search           — rule-tree filtering
// POST   /contacts/import           — bulk upsert (<=1,000/request)
// GET    /contacts/import-url       — presigned CSV upload target
// GET    /contacts/duplicates       — email/phone collision clusters
// POST   /contacts/merge            — fold duplicates (admin)
// POST   /contacts/bulk             — selection-aware bulk action
// POST   /contacts/export           — start an async CSV export
// GET    /contacts/export/{id}      — export job status + download URL
// GET    /contacts/{id}/timeline    — unified activity history
// GET    /contacts/{id}/consent     — per-channel consent + evidence
//
// Every filtered query goes through the rule engine; object storage and the
// export worker are injected so nothing here names a cloud provider.
// ============================================

import * as crypto from 'crypto';
import { and, eq, ilike, inArray, ne, or, sql } from 'drizzle-orm';
import { getDb, getPool } from '../db';
import {
  adminAuditLog,
  contacts,
  contactSegment,
  consentSourceEnum,
  contactStatusEnum,
  segments,
  suppressionList,
} from '../schema';
import { normalizeContactRow } from '../contact-validate';
import { findUniqueViolations, loadFieldDefinitions, validateCustomFields } from '../custom-fields';
import { compileRules, parseRules, RuleValidationError } from '../rules';
import { buildContactTimeline, getConsentState } from '../timeline';
import { findDuplicateClusters } from '../duplicates';
import { mergeContacts } from '../merge';
import { applyBulkAction, buildSelectionClause, type BulkAction, type Selection } from '../bulk';
import type { RequestContext } from './context';
import {
  type ApiResult,
  accepted,
  badRequest,
  conflict,
  created,
  noContent,
  notFound,
  ok,
  requireRole,
  requireWorkspace,
  serverError,
} from './result';
import { has, type JsonBody, num, obj, str, strArray } from './input';

const MAX_PAGE_SIZE = 100;
const MAX_IMPORT_ROWS = 1000;
const MAX_BULK_DELETE = 500;
const SUPPRESSED_STATUSES = ['unsubscribed', 'bounced', 'complained'];

type ContactStatus = typeof contactStatusEnum.enumValues[number];

function isContactStatus(v: string | undefined): v is ContactStatus {
  return v !== undefined && (contactStatusEnum.enumValues as readonly string[]).includes(v);
}

type ConsentSource = typeof consentSourceEnum.enumValues[number];

/**
 * consent_source is an enum column. The Lambda wrote the raw body value
 * straight through, so an unrecognised string became a 500 from Postgres;
 * an invalid value is simply not set.
 */
function consentSourceOf(body: JsonBody): ConsentSource | null {
  const v = str(body, 'consent_source', 'consentSource');
  return v !== undefined && (consentSourceEnum.enumValues as readonly string[]).includes(v)
    ? (v as ConsentSource)
    : null;
}

export interface QueryParams {
  pageSize?: string | null;
  cursor?: string | null;
  status?: string | null;
  search?: string | null;
  segmentId?: string | null;
  limit?: string | null;
}

/**
 * Injected side-effects. Object storage and the async worker differ per
 * platform (S3 + Lambda yesterday, Supabase Storage + a queue after M6); an
 * undefined dependency means the deployment cannot do that yet, which is the
 * same behaviour a missing bucket/function env var produced before.
 */
export interface ContactsDeps {
  presignUpload?: (key: string) => Promise<string>;
  presignDownload?: (key: string) => Promise<string>;
  startExport?: (jobId: string, workspaceId: string) => Promise<void>;
}

/** Audit metadata for super-admin impersonation logging. */
export interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
  path?: string;
}

function pageSizeOf(raw: string | null | undefined, fallback: number): number {
  return Math.min(MAX_PAGE_SIZE, parseInt(raw || String(fallback), 10) || fallback);
}

const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

/**
 * Mirror a suppressed contact into the suppression list so future sends skip
 * them even if the contact row is later anonymized.
 */
async function syncSuppression(
  workspaceId: string,
  email: string | null,
  phone: string | null,
  status: string,
): Promise<void> {
  if (!SUPPRESSED_STATUSES.includes(status)) return;

  const db = await getDb();
  const reason = status === 'unsubscribed' ? 'unsubscribe' : status === 'bounced' ? 'bounce' : 'complaint';

  if (email) {
    const emailHash = sha256(email.toLowerCase().trim());
    const [existing] = await db.select().from(suppressionList).where(
      and(eq(suppressionList.workspaceId, workspaceId), eq(suppressionList.emailHash, emailHash)),
    );
    if (!existing) {
      await db.insert(suppressionList).values({ workspaceId, emailHash, reason });
    }
  }
  if (phone) {
    const phoneHash = sha256(phone.replace(/\D/g, ''));
    const [existing] = await db.select().from(suppressionList).where(
      and(eq(suppressionList.workspaceId, workspaceId), eq(suppressionList.phoneHash, phoneHash)),
    );
    if (!existing) {
      await db.insert(suppressionList).values({ workspaceId, phoneHash, reason });
    }
  }
}

// ============================================
// Read
// ============================================

export async function listContacts(ctx: RequestContext, params: QueryParams = {}): Promise<ApiResult> {
  const missing = requireWorkspace(ctx);
  if (missing) return missing;
  const denied = requireRole(ctx, 'viewer');
  if (denied) return denied;

  const db = await getDb();
  const pageSize = pageSizeOf(params.pageSize, 50);
  const cursor = params.cursor;
  const status = params.status?.trim();
  const search = params.search?.trim();
  const segmentId = params.segmentId?.trim();

  // Filters shared by the page query and the count query.
  const filters = () => {
    const conditions = [eq(contacts.workspaceId, ctx.workspaceId)];
    if (isContactStatus(status)) {
      conditions.push(eq(contacts.status, status));
    }
    if (segmentId) {
      conditions.push(
        sql`${contacts.contactId} IN (
          SELECT contact_id FROM contact_segment
          WHERE segment_id = ${segmentId}
        )`,
      );
    }
    if (search) {
      conditions.push(
        or(
          ilike(contacts.email, `%${search}%`),
          ilike(contacts.firstName, `%${search}%`),
          ilike(contacts.lastName, `%${search}%`),
          ilike(contacts.company, `%${search}%`),
        )!,
      );
    }
    return conditions;
  };

  const pageConditions = filters();
  // Cursor-based keyset pagination: fetch rows after the cursor
  if (cursor) {
    pageConditions.push(sql`${contacts.contactId} > ${cursor}`);
  }

  const rows = await db
    .select()
    .from(contacts)
    .where(and(...pageConditions))
    .orderBy(contacts.contactId)
    .limit(pageSize + 1); // one extra to detect a next page

  const hasMore = rows.length > pageSize;
  const data = hasMore ? rows.slice(0, pageSize) : rows;
  const nextCursor = hasMore ? data[data.length - 1]?.contactId : null;

  // Attach segment names for just this page
  const contactIds = data.map((c) => c.contactId);
  const segmentMap = new Map<string, string[]>();
  if (contactIds.length > 0) {
    const memberships = await db
      .select({ contactId: contactSegment.contactId, segmentName: segments.name })
      .from(contactSegment)
      .innerJoin(segments, eq(contactSegment.segmentId, segments.segmentId))
      .where(inArray(contactSegment.contactId, contactIds));

    for (const cs of memberships) {
      if (cs.contactId && cs.segmentName) {
        const existing = segmentMap.get(cs.contactId) || [];
        existing.push(cs.segmentName);
        segmentMap.set(cs.contactId, existing);
      }
    }
  }
  const dataWithSegments = data.map((c) => ({ ...c, segments: segmentMap.get(c.contactId) || [] }));

  const [countResult] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(contacts)
    .where(and(...filters()));

  return ok({
    data: dataWithSegments,
    meta: { total: countResult?.count || 0, pageSize, nextCursor, hasMore },
  });
}

export async function getContact(ctx: RequestContext, contactId: string): Promise<ApiResult> {
  const missing = requireWorkspace(ctx);
  if (missing) return missing;
  const denied = requireRole(ctx, 'viewer');
  if (denied) return denied;

  const db = await getDb();
  const [row] = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.contactId, contactId), eq(contacts.workspaceId, ctx.workspaceId)));

  if (!row) return notFound('Contact not found');
  return ok(row);
}

export async function searchContacts(ctx: RequestContext, body: JsonBody): Promise<ApiResult> {
  const missing = requireWorkspace(ctx);
  if (missing) return missing;
  const denied = requireRole(ctx, 'viewer');
  if (denied) return denied;

  const pageSize = Math.min(MAX_PAGE_SIZE, num(body, 'pageSize') ?? 50);
  const cursor = str(body, 'cursor') ?? null;

  const pool = await getPool();
  let ruleSql = '';
  let ruleParams: unknown[] = [];
  if (body.rules) {
    try {
      const defs = (await loadFieldDefinitions(pool, ctx.workspaceId)).filter((d) => !d.archived);
      // $1 = workspaceId, $2 = cursor; rule params start at $3
      const compiled = compileRules(parseRules(body.rules), defs, 2);
      ruleSql = ` AND ${compiled.text}`;
      ruleParams = compiled.params;
    } catch (err) {
      if (err instanceof RuleValidationError) return badRequest(`Invalid rules: ${err.message}`);
      throw err;
    }
  }

  const rows = await pool.query(
    `SELECT c.* FROM contacts c
      WHERE c.workspace_id = $1
        AND ($2::uuid IS NULL OR c.contact_id > $2)${ruleSql}
      ORDER BY c.contact_id
      LIMIT ${pageSize + 1}`,
    [ctx.workspaceId, cursor, ...ruleParams],
  );

  const hasMore = rows.rows.length > pageSize;
  const data = hasMore ? rows.rows.slice(0, pageSize) : rows.rows;
  const nextCursor = hasMore ? data[data.length - 1]?.contact_id : null;

  const count = await pool.query(
    `SELECT COUNT(*)::int AS total FROM contacts c
      WHERE c.workspace_id = $1 AND ($2::uuid IS NULL OR TRUE)${ruleSql}`,
    [ctx.workspaceId, null, ...ruleParams],
  );

  return ok({ data, meta: { total: count.rows[0].total, pageSize, nextCursor, hasMore } });
}

export async function listDuplicates(ctx: RequestContext, params: QueryParams = {}): Promise<ApiResult> {
  const missing = requireWorkspace(ctx);
  if (missing) return missing;
  const denied = requireRole(ctx, 'viewer');
  if (denied) return denied;

  const limit = parseInt(params.limit || '200', 10) || 200;
  const clusters = await findDuplicateClusters(await getPool(), ctx.workspaceId, limit);
  return ok({ data: clusters });
}

export async function getContactTimeline(
  ctx: RequestContext,
  contactId: string,
  params: QueryParams = {},
): Promise<ApiResult> {
  const missing = requireWorkspace(ctx);
  if (missing) return missing;
  const denied = requireRole(ctx, 'viewer');
  if (denied) return denied;

  const limit = pageSizeOf(params.pageSize, 30);
  const cursor = params.cursor?.trim() || null;
  const page = await buildContactTimeline(await getPool(), ctx.workspaceId, contactId, cursor, limit);
  return ok({ data: page.events, meta: { nextCursor: page.nextCursor, hasMore: page.hasMore } });
}

export async function getContactConsent(ctx: RequestContext, contactId: string): Promise<ApiResult> {
  const missing = requireWorkspace(ctx);
  if (missing) return missing;
  const denied = requireRole(ctx, 'viewer');
  if (denied) return denied;

  const state = await getConsentState(await getPool(), ctx.workspaceId, contactId);
  return ok(state);
}

// ============================================
// Write
// ============================================

export async function createContact(ctx: RequestContext, body: JsonBody): Promise<ApiResult> {
  const missing = requireWorkspace(ctx);
  if (missing) return missing;
  const denied = requireRole(ctx, 'editor');
  if (denied) return denied;

  const db = await getDb();
  const statusInput = str(body, 'status');
  const values = {
    workspaceId: ctx.workspaceId,
    email: str(body, 'email') || null,
    phone: str(body, 'phone') || null,
    firstName: str(body, 'first_name', 'firstName') || null,
    lastName: str(body, 'last_name', 'lastName') || null,
    company: str(body, 'company') || null,
    timezone: str(body, 'timezone') || null,
    state: str(body, 'state') || null,
    status: isContactStatus(statusInput) ? statusInput : ('active' as ContactStatus),
    source: str(body, 'source') || 'manual',
    consentSource: consentSourceOf(body),
    customFields: obj(body, 'custom_fields', 'customFields') ?? {},
  };

  // Typed custom-field validation (strict: API callers get a 400)
  const pool = await getPool();
  const defs = await loadFieldDefinitions(pool, ctx.workspaceId);
  const validation = validateCustomFields(defs, values.customFields, { forCreate: true });
  if (Object.keys(validation.errors).length > 0 || validation.missingRequired.length > 0) {
    return badRequest('Custom field validation failed', {
      fieldErrors: validation.errors,
      missingRequired: validation.missingRequired,
    });
  }
  const violations = await findUniqueViolations(pool, ctx.workspaceId, defs, validation.values);
  if (violations.length > 0) {
    return conflict('Unique custom field values already in use', { fields: violations });
  }
  values.customFields = validation.values;

  // Upsert on email, then phone
  let existing = null;
  if (values.email) {
    const [match] = await db.select().from(contacts).where(
      and(eq(contacts.workspaceId, ctx.workspaceId), eq(contacts.email, values.email)),
    );
    if (match) existing = match;
  }
  if (!existing && values.phone) {
    const [match] = await db.select().from(contacts).where(
      and(eq(contacts.workspaceId, ctx.workspaceId), eq(contacts.phone, values.phone)),
    );
    if (match) existing = match;
  }

  if (existing) {
    // Merge: keep the existing value when the incoming one is empty.
    const [updated] = await db
      .update(contacts)
      .set({
        firstName: values.firstName || existing.firstName,
        lastName: values.lastName || existing.lastName,
        email: values.email || existing.email,
        phone: values.phone || existing.phone,
        company: values.company || existing.company,
        timezone: values.timezone || existing.timezone,
        state: values.state || existing.state,
        // A suppressed contact never silently returns to 'active'.
        status: SUPPRESSED_STATUSES.includes(existing.status)
          ? existing.status
          : (values.status || existing.status),
        consentSource: values.consentSource || existing.consentSource,
        customFields: { ...(existing.customFields as object), ...values.customFields },
        updatedAt: new Date(),
      })
      .where(eq(contacts.contactId, existing.contactId))
      .returning();

    await syncSuppression(ctx.workspaceId, updated!.email, updated!.phone, updated!.status);
    return ok(updated);
  }

  const [inserted] = await db.insert(contacts).values(values).returning();
  await syncSuppression(ctx.workspaceId, inserted!.email, inserted!.phone, inserted!.status);
  return created(inserted);
}

export async function updateContact(
  ctx: RequestContext,
  contactId: string,
  body: JsonBody,
): Promise<ApiResult> {
  const missing = requireWorkspace(ctx);
  if (missing) return missing;
  const denied = requireRole(ctx, 'editor');
  if (denied) return denied;

  const db = await getDb();
  const updates: Record<string, unknown> = { updatedAt: new Date() };

  if (has(body, 'email')) updates.email = str(body, 'email') ?? null;
  if (has(body, 'phone')) updates.phone = str(body, 'phone') ?? null;
  if (has(body, 'first_name', 'firstName')) updates.firstName = str(body, 'first_name', 'firstName') ?? null;
  if (has(body, 'last_name', 'lastName')) updates.lastName = str(body, 'last_name', 'lastName') ?? null;
  if (has(body, 'company')) updates.company = str(body, 'company') ?? null;
  if (has(body, 'timezone')) updates.timezone = str(body, 'timezone') ?? null;
  if (has(body, 'state')) updates.state = str(body, 'state') ?? null;
  if (has(body, 'consent_source', 'consentSource')) updates.consentSource = consentSourceOf(body);
  if (has(body, 'custom_fields', 'customFields')) updates.customFields = obj(body, 'custom_fields', 'customFields') ?? {};

  if (has(body, 'status')) {
    const statusInput = str(body, 'status');
    if (!isContactStatus(statusInput)) {
      return badRequest(`status must be one of ${contactStatusEnum.enumValues.join(', ')}`);
    }
    updates.status = statusInput;
  }

  // Reject duplicates before writing
  const email = updates.email;
  if (typeof email === 'string' && email) {
    const [dupe] = await db.select().from(contacts).where(
      and(eq(contacts.workspaceId, ctx.workspaceId), eq(contacts.email, email), ne(contacts.contactId, contactId)),
    );
    if (dupe) return badRequest(`A contact with email "${email}" already exists.`);
  }
  const phone = updates.phone;
  if (typeof phone === 'string' && phone) {
    const [dupe] = await db.select().from(contacts).where(
      and(eq(contacts.workspaceId, ctx.workspaceId), eq(contacts.phone, phone), ne(contacts.contactId, contactId)),
    );
    if (dupe) return badRequest(`A contact with phone "${phone}" already exists.`);
  }

  const [row] = await db.update(contacts).set(updates).where(
    and(eq(contacts.contactId, contactId), eq(contacts.workspaceId, ctx.workspaceId)),
  ).returning();

  if (!row) return notFound('Contact not found');

  await syncSuppression(ctx.workspaceId, row.email, row.phone, row.status);
  return ok(row);
}

export async function deleteContact(
  ctx: RequestContext,
  contactId: string,
  meta: RequestMeta = {},
): Promise<ApiResult> {
  const missing = requireWorkspace(ctx);
  if (missing) return missing;
  const denied = requireRole(ctx, 'admin');
  if (denied) return denied;

  const db = await getDb();

  // Log super-admin impersonation
  if (ctx.isSuperAdmin) {
    await db.insert(adminAuditLog).values({
      adminUserId: ctx.userId,
      impersonatedWorkspaceId: ctx.workspaceId,
      action: 'DELETE',
      resource: 'contacts',
      resourceId: contactId,
      method: 'DELETE',
      path: meta.path || '',
      ipAddress: meta.ip || null,
      userAgent: meta.userAgent || null,
    });
  }

  await db.delete(contacts).where(
    and(eq(contacts.contactId, contactId), eq(contacts.workspaceId, ctx.workspaceId)),
  );
  return noContent();
}

export async function bulkDeleteContacts(ctx: RequestContext, body: JsonBody): Promise<ApiResult> {
  const missing = requireWorkspace(ctx);
  if (missing) return missing;
  const denied = requireRole(ctx, 'admin');
  if (denied) return denied;

  const ids = (strArray(body, 'ids') ?? []).slice(0, MAX_BULK_DELETE);
  if (ids.length === 0) return badRequest('No ids provided');

  const db = await getDb();
  const deleted = await db.delete(contacts).where(
    and(eq(contacts.workspaceId, ctx.workspaceId), inArray(contacts.contactId, ids)),
  ).returning({ contactId: contacts.contactId });

  return ok({ deleted: deleted.length });
}

export async function importContacts(ctx: RequestContext, body: JsonBody): Promise<ApiResult> {
  const missing = requireWorkspace(ctx);
  if (missing) return missing;
  const denied = requireRole(ctx, 'editor');
  if (denied) return denied;

  const rawRows: unknown[] = Array.isArray(body.contacts) ? body.contacts.slice(0, MAX_IMPORT_ROWS) : [];
  const segmentId = str(body, 'segmentId', 'segment_id')?.trim();
  if (rawRows.length === 0) return badRequest('No contacts provided');

  const db = await getDb();
  const pool = await getPool();

  // Normalize + validate every row (shared with the CSV pipeline): emails
  // lowercased/syntax-checked, phones canonicalized to E.164, names
  // control-char-stripped, custom fields sanitized. Rows with neither a valid
  // email nor a valid phone are rejected.
  const toValues = (c: unknown) => {
    // Rows arrive from untrusted JSON; anything that is not a plain object
    // cannot be a contact.
    if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
    const row = c as JsonBody;
    const n = normalizeContactRow(row);
    if (!n) return null;
    return {
      workspaceId: ctx.workspaceId,
      ...n,
      status: 'active' as const,
      source: str(row, 'source') || 'csv_import',
      consentSource: consentSourceOf(row),
    };
  };

  // Lenient typed validation for bulk import: invalid custom-field values are
  // dropped (the row still imports); strict 400s would make large CSV imports
  // unusable.
  const fieldDefs = await loadFieldDefinitions(pool, ctx.workspaceId);
  let droppedFieldValues = 0;
  const normalized = rawRows
    .map(toValues)
    .filter((c): c is NonNullable<ReturnType<typeof toValues>> => c !== null)
    .map((c) => {
      const validation = validateCustomFields(fieldDefs, c.customFields, { forCreate: false });
      droppedFieldValues += Object.keys(validation.errors).length;
      return { ...c, customFields: validation.values };
    });

  const withEmail = normalized.filter((c) => c.email);
  const phoneOnly = normalized.filter((c) => !c.email && c.phone);
  const rejected = rawRows.length - withEmail.length - phoneOnly.length;

  // All three passes commit or roll back together: a failure in the phone-only
  // pass or the segment association must not leave orphaned half-imports.
  const imported = await db.transaction(async (tx) => {
    let importedCount = 0;
    const contactIds: string[] = [];

    // Pass 1: contacts WITH email (dedupe on workspace + email)
    if (withEmail.length > 0) {
      const result = await tx
        .insert(contacts)
        .values(withEmail)
        .onConflictDoUpdate({
          target: [contacts.workspaceId, contacts.email],
          set: {
            firstName: sql`COALESCE(EXCLUDED."first_name", ${contacts.firstName})`,
            lastName: sql`COALESCE(EXCLUDED."last_name", ${contacts.lastName})`,
            phone: sql`COALESCE(EXCLUDED."phone", ${contacts.phone})`,
            company: sql`COALESCE(EXCLUDED."company", ${contacts.company})`,
            timezone: sql`COALESCE(EXCLUDED."timezone", ${contacts.timezone})`,
            state: sql`COALESCE(EXCLUDED."state", ${contacts.state})`,
            consentSource: sql`COALESCE(EXCLUDED."consent_source", ${contacts.consentSource})`,
            updatedAt: new Date(),
          },
        })
        .returning({ contactId: contacts.contactId });
      importedCount += result.length;
      contactIds.push(...result.map((r) => r.contactId));
    }

    // Pass 2: phone-only contacts (dedupe on workspace + phone)
    if (phoneOnly.length > 0) {
      const result = await tx
        .insert(contacts)
        .values(phoneOnly)
        .onConflictDoUpdate({
          target: [contacts.workspaceId, contacts.phone],
          set: {
            firstName: sql`COALESCE(EXCLUDED."first_name", ${contacts.firstName})`,
            lastName: sql`COALESCE(EXCLUDED."last_name", ${contacts.lastName})`,
            company: sql`COALESCE(EXCLUDED."company", ${contacts.company})`,
            timezone: sql`COALESCE(EXCLUDED."timezone", ${contacts.timezone})`,
            state: sql`COALESCE(EXCLUDED."state", ${contacts.state})`,
            consentSource: sql`COALESCE(EXCLUDED."consent_source", ${contacts.consentSource})`,
            updatedAt: new Date(),
          },
        })
        .returning({ contactId: contacts.contactId });
      importedCount += result.length;
      contactIds.push(...result.map((r) => r.contactId));
    }

    // Pass 3: segment association, only for a segment in this workspace
    if (segmentId && contactIds.length > 0) {
      const [seg] = await tx
        .select()
        .from(segments)
        .where(and(eq(segments.segmentId, segmentId), eq(segments.workspaceId, ctx.workspaceId)));
      if (seg) {
        await tx.insert(contactSegment)
          .values(contactIds.map((cid) => ({ contactId: cid, segmentId })))
          .onConflictDoNothing();
      }
    }

    return importedCount;
  });

  return ok({ imported, rejected, droppedFieldValues });
}

export async function mergeDuplicates(ctx: RequestContext, body: JsonBody): Promise<ApiResult> {
  const missing = requireWorkspace(ctx);
  if (missing) return missing;
  const denied = requireRole(ctx, 'admin');
  if (denied) return denied;

  const survivorId = str(body, 'survivorId', 'survivor_id');
  const duplicateIds = strArray(body, 'duplicateIds', 'duplicate_ids') ?? [];
  if (!survivorId || duplicateIds.length === 0) {
    return badRequest('survivorId and a non-empty duplicateIds array are required');
  }

  const result = await mergeContacts(await getPool(), ctx.workspaceId, survivorId, duplicateIds, ctx.userId);
  if ('ok' in result && !result.ok) {
    const extra = 'missing' in result ? { missing: result.missing } : {};
    return result.reason === 'survivor_in_duplicates'
      ? badRequest(result.reason, extra)
      : notFound(result.reason);
  }
  return ok(result);
}

export async function bulkContactAction(ctx: RequestContext, body: JsonBody): Promise<ApiResult> {
  const missing = requireWorkspace(ctx);
  if (missing) return missing;
  const denied = requireRole(ctx, 'editor');
  if (denied) return denied;

  const action = body.action as BulkAction | undefined;
  const selection = body.selection as Selection | undefined;
  if (!action?.type || !selection) {
    return badRequest('action and selection are required');
  }
  if (action.type === 'delete') {
    const adminDenied = requireRole(ctx, 'admin');
    if (adminDenied) return adminDenied;
  }

  try {
    const result = await applyBulkAction(await getPool(), ctx.workspaceId, selection, action, ctx.userId);
    return ok(result);
  } catch (err) {
    if (err instanceof RuleValidationError) return badRequest(err.message);
    throw err;
  }
}

// ============================================
// CSV upload / export (injected storage)
// ============================================

export async function createImportUrl(
  ctx: RequestContext,
  params: QueryParams,
  deps: ContactsDeps = {},
): Promise<ApiResult> {
  const missing = requireWorkspace(ctx);
  if (missing) return missing;
  const denied = requireRole(ctx, 'editor');
  if (denied) return denied;

  if (!deps.presignUpload) return serverError('Upload bucket not configured');

  const segmentId = params.segmentId?.trim();
  // Key is prefixed by workspace so uploads stay isolated per tenant.
  const fileId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  const key = segmentId
    ? `${ctx.workspaceId}/import-${fileId}-seg-${segmentId}.csv`
    : `${ctx.workspaceId}/import-${fileId}.csv`;

  return ok({ url: await deps.presignUpload(key), key });
}

export async function startContactExport(
  ctx: RequestContext,
  body: JsonBody,
  deps: ContactsDeps = {},
): Promise<ApiResult> {
  const missing = requireWorkspace(ctx);
  if (missing) return missing;
  const denied = requireRole(ctx, 'viewer');
  if (denied) return denied;

  const selection = (body.selection ?? { all: true }) as Selection;
  const columns = strArray(body, 'columns') ?? null;

  const pool = await getPool();
  // Validate the selection compiles before enqueuing (fail fast with 400).
  try {
    await buildSelectionClause(pool, ctx.workspaceId, selection);
  } catch (err) {
    if (err instanceof RuleValidationError) return badRequest(`Invalid selection: ${err.message}`);
    throw err;
  }

  const job = await pool.query(
    `INSERT INTO export_jobs (workspace_id, requested_by, status, selection, columns)
     VALUES ($1, $2, 'pending', $3, $4) RETURNING job_id`,
    [ctx.workspaceId, ctx.userId, JSON.stringify(selection), columns ? JSON.stringify(columns) : null],
  );
  const jobId = job.rows[0].job_id;

  // Fire the worker asynchronously; return immediately.
  if (deps.startExport) {
    await deps.startExport(jobId, ctx.workspaceId);
  }
  return accepted({ jobId, status: 'pending' });
}

export async function getExportStatus(
  ctx: RequestContext,
  jobId: string,
  deps: ContactsDeps = {},
): Promise<ApiResult> {
  const missing = requireWorkspace(ctx);
  if (missing) return missing;
  const denied = requireRole(ctx, 'viewer');
  if (denied) return denied;

  const pool = await getPool();
  const job = await pool.query(
    `SELECT status::text AS status, row_count, s3_key, error FROM export_jobs
      WHERE job_id = $1 AND workspace_id = $2`,
    [jobId, ctx.workspaceId],
  );
  if (job.rows.length === 0) return notFound('Export job not found');

  const row = job.rows[0];
  let downloadUrl: string | null = null;
  if (row.status === 'complete' && row.s3_key && deps.presignDownload) {
    downloadUrl = await deps.presignDownload(row.s3_key);
  }
  return ok({ status: row.status, rowCount: row.row_count, error: row.error, downloadUrl });
}
