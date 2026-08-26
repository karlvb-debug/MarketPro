// ============================================
// Segments CRUD
// GET    /segments               — list (with cached counts)
// POST   /segments               — create (static or dynamic)
// PUT    /segments/{id}          — update (name/desc/color/sort/rules)
// DELETE /segments/{id}          — delete (admin)
// GET    /segments/{id}/contacts — paginated membership preview
// POST   /segments/{id}/contacts — add contacts (static only)
// DELETE /segments/{id}/contacts — remove contacts (static only)
// POST   /segments/preview-count — live count for an unsaved rule tree
//
// All membership queries go through the rule engine; nothing here builds SQL
// from user input.
// ============================================

import { and, eq, inArray } from 'drizzle-orm';
import { getDb, getPool } from '../db';
import { contactSegment, segments } from '../schema';
import {
  buildMembershipClause,
  countRulePreview,
  countSegmentMembers,
  loadSegment,
  RuleValidationError,
} from '../segment-query';
import { compileRules, parseRules } from '../rules';
import { loadFieldDefinitions } from '../custom-fields';
import type { RequestContext } from './context';
import {
  type ApiResult,
  badRequest,
  conflict,
  created,
  noContent,
  notFound,
  ok,
  requireRole,
  requireWorkspace,
} from './result';
import { has, type JsonBody, num, str, strArray } from './input';

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 50;

export interface PageParams {
  pageSize?: string | null;
  cursor?: string | null;
}

function pagination(params: PageParams) {
  const pageSize = Math.min(MAX_PAGE_SIZE, parseInt(params.pageSize || String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE);
  return { pageSize, cursor: params.cursor?.trim() || null };
}

/** Validate raw rules compile against the workspace field registry. */
async function validateRules(workspaceId: string, rawRules: unknown): Promise<string | null> {
  try {
    const pool = await getPool();
    const defs = (await loadFieldDefinitions(pool, workspaceId)).filter((d) => !d.archived);
    compileRules(parseRules(rawRules), defs, 0);
    return null;
  } catch (err) {
    if (err instanceof RuleValidationError) return err.message;
    throw err;
  }
}

export async function listSegments(ctx: RequestContext): Promise<ApiResult> {
  const missing = requireWorkspace(ctx);
  if (missing) return missing;

  const db = await getDb();
  const rows = await db
    .select()
    .from(segments)
    .where(eq(segments.workspaceId, ctx.workspaceId))
    .orderBy(segments.sortOrder);

  return ok({ data: rows });
}

export async function listSegmentContacts(
  ctx: RequestContext,
  segmentId: string,
  params: PageParams = {},
): Promise<ApiResult> {
  const missing = requireWorkspace(ctx);
  if (missing) return missing;

  const pool = await getPool();
  const segment = await loadSegment(pool, ctx.workspaceId, segmentId);
  if (!segment) return notFound('Segment not found');

  const { pageSize, cursor } = pagination(params);
  const clause = await buildMembershipClause(pool, segment, 2);
  const rows = await pool.query(
    `SELECT c.* FROM contacts c
      WHERE c.workspace_id = $1
        AND ($2::uuid IS NULL OR c.contact_id > $2)
        AND ${clause.text}
      ORDER BY c.contact_id
      LIMIT ${pageSize + 1}`,
    [ctx.workspaceId, cursor, ...clause.params],
  );
  const hasMore = rows.rows.length > pageSize;
  const data = hasMore ? rows.rows.slice(0, pageSize) : rows.rows;
  const nextCursor = hasMore ? data[data.length - 1]?.contact_id : null;
  const total = await countSegmentMembers(pool, ctx.workspaceId, segmentId);

  return ok({ data, meta: { total, pageSize, nextCursor, hasMore } });
}

export async function previewSegmentCount(ctx: RequestContext, body: JsonBody): Promise<ApiResult> {
  const missing = requireWorkspace(ctx);
  if (missing) return missing;

  try {
    const total = await countRulePreview(await getPool(), ctx.workspaceId, body.rules);
    return ok({ total });
  } catch (err) {
    if (err instanceof RuleValidationError) return badRequest(`Invalid rules: ${err.message}`);
    throw err;
  }
}

export async function createSegment(ctx: RequestContext, body: JsonBody): Promise<ApiResult> {
  const missing = requireWorkspace(ctx);
  if (missing) return missing;
  const denied = requireRole(ctx, 'editor');
  if (denied) return denied;

  const kind = str(body, 'kind') === 'dynamic' ? 'dynamic' : 'static';

  if (kind === 'dynamic') {
    if (!body.rules) return badRequest('Dynamic segments require rules');
    const ruleError = await validateRules(ctx.workspaceId, body.rules);
    if (ruleError) return badRequest(`Invalid rules: ${ruleError}`);
  }

  const db = await getDb();
  const [row] = await db.insert(segments).values({
    workspaceId: ctx.workspaceId,
    name: str(body, 'name') || 'New Segment',
    description: str(body, 'description') || null,
    color: str(body, 'color') || null,
    kind,
    rules: kind === 'dynamic' ? body.rules : null,
  }).returning();

  // Compute the initial cached count for dynamic segments
  if (kind === 'dynamic') {
    const total = await countSegmentMembers(await getPool(), ctx.workspaceId, row!.segmentId);
    const countRefreshedAt = new Date();
    await db.update(segments)
      .set({ cachedCount: total, countRefreshedAt })
      .where(eq(segments.segmentId, row!.segmentId));
    return created({ ...row, cachedCount: total, countRefreshedAt });
  }

  return created(row);
}

export async function updateSegment(
  ctx: RequestContext,
  segmentId: string,
  body: JsonBody,
): Promise<ApiResult> {
  const missing = requireWorkspace(ctx);
  if (missing) return missing;
  const denied = requireRole(ctx, 'editor');
  if (denied) return denied;

  const db = await getDb();
  const [existing] = await db.select().from(segments).where(
    and(eq(segments.segmentId, segmentId), eq(segments.workspaceId, ctx.workspaceId)),
  );
  if (!existing) return notFound('Segment not found');

  const updates: Record<string, unknown> = {};
  if (has(body, 'name')) updates.name = str(body, 'name');
  if (has(body, 'description')) updates.description = str(body, 'description') ?? null;
  if (has(body, 'color')) updates.color = str(body, 'color') ?? null;
  if (has(body, 'sort_order', 'sortOrder')) updates.sortOrder = num(body, 'sort_order', 'sortOrder');

  // Rule edits apply only to dynamic segments; recompute the cached count.
  const editingRules = body.rules !== undefined && existing.kind === 'dynamic';
  if (editingRules) {
    const ruleError = await validateRules(ctx.workspaceId, body.rules);
    if (ruleError) return badRequest(`Invalid rules: ${ruleError}`);
    updates.rules = body.rules;
  }

  await db.update(segments).set(updates).where(
    and(eq(segments.segmentId, segmentId), eq(segments.workspaceId, ctx.workspaceId)),
  );

  if (editingRules) {
    const total = await countSegmentMembers(await getPool(), ctx.workspaceId, segmentId);
    await db.update(segments)
      .set({ cachedCount: total, countRefreshedAt: new Date() })
      .where(eq(segments.segmentId, segmentId));
  }

  return ok({ message: 'Updated' });
}

export async function addSegmentContacts(
  ctx: RequestContext,
  segmentId: string,
  body: JsonBody,
): Promise<ApiResult> {
  const missing = requireWorkspace(ctx);
  if (missing) return missing;
  const denied = requireRole(ctx, 'editor');
  if (denied) return denied;

  const db = await getDb();
  const [seg] = await db.select().from(segments).where(
    and(eq(segments.segmentId, segmentId), eq(segments.workspaceId, ctx.workspaceId)),
  );
  if (!seg) return notFound('Segment not found');
  if (seg.kind === 'dynamic') {
    return conflict('Cannot add contacts to a dynamic segment; membership is rule-based');
  }

  const contactIds = strArray(body, 'contactIds');
  if (!contactIds || contactIds.length === 0) {
    return badRequest('contactIds array required');
  }

  await db.insert(contactSegment)
    .values(contactIds.map((cid) => ({ contactId: cid, segmentId })))
    .onConflictDoNothing();
  return ok({ added: contactIds.length });
}

export async function removeSegmentContacts(
  ctx: RequestContext,
  segmentId: string,
  body: JsonBody,
): Promise<ApiResult> {
  const missing = requireWorkspace(ctx);
  if (missing) return missing;
  const denied = requireRole(ctx, 'editor');
  if (denied) return denied;

  const db = await getDb();
  const [seg] = await db.select().from(segments).where(
    and(eq(segments.segmentId, segmentId), eq(segments.workspaceId, ctx.workspaceId)),
  );
  if (!seg) return notFound('Segment not found');

  const contactIds = strArray(body, 'contactIds');
  if (!contactIds || contactIds.length === 0) {
    return badRequest('contactIds array required');
  }

  await db.delete(contactSegment).where(
    and(eq(contactSegment.segmentId, segmentId), inArray(contactSegment.contactId, contactIds)),
  );
  return ok({ removed: contactIds.length });
}

export async function deleteSegment(ctx: RequestContext, segmentId: string): Promise<ApiResult> {
  const missing = requireWorkspace(ctx);
  if (missing) return missing;
  const denied = requireRole(ctx, 'admin');
  if (denied) return denied;

  const db = await getDb();
  await db.delete(segments).where(
    and(eq(segments.segmentId, segmentId), eq(segments.workspaceId, ctx.workspaceId)),
  );
  return noContent();
}
