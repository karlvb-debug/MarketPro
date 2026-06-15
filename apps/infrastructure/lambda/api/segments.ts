// ============================================
// Segments CRUD Lambda
// GET    /segments                    — list (with live-ish cached counts)
// POST   /segments                    — create (static or dynamic)
// PUT    /segments/{id}               — update (name/desc/color/rules)
// GET    /segments/{id}/contacts      — paginated membership preview
// POST   /segments/{id}/contacts      — add contacts (static only)
// DELETE /segments/{id}/contacts      — remove contacts (static only)
// POST   /segments/preview-count      — live count for unsaved rules
// DELETE /segments/{id}               — delete
// ============================================

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { eq, and, inArray } from 'drizzle-orm';
import { getDb, getPool, respond, getWorkspaceId, getUserId, requireRole } from '../lib/db';
import { segments, contactSegment } from '../../drizzle/schema';
import {
  loadSegment,
  buildMembershipClause,
  countSegmentMembers,
  countRulePreview,
  RuleValidationError,
} from '../lib/segment-query';
import { parseRules, compileRules } from '../lib/rules';
import { loadFieldDefinitions } from '../lib/custom-fields';

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

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const method = event.httpMethod;
  const userId = getUserId(event);
  if (!userId) return respond(401, { message: 'Unauthorized' });

  const workspaceId = getWorkspaceId(event);
  if (!workspaceId) return respond(400, { message: 'Missing X-Workspace-Id header' });

  const db = await getDb();
  const pathId = event.pathParameters?.id;

  try {
    // GET /segments
    if (method === 'GET' && !pathId) {
      const rows = await db
        .select()
        .from(segments)
        .where(eq(segments.workspaceId, workspaceId))
        .orderBy(segments.sortOrder);

      return respond(200, { data: rows });
    }

    // GET /segments/{id}/contacts — paginated membership preview (static + dynamic)
    if (method === 'GET' && pathId && event.path?.endsWith('/contacts')) {
      const segment = await loadSegment(await getPool(), workspaceId, pathId);
      if (!segment) return respond(404, { message: 'Segment not found' });

      const params = event.queryStringParameters || {};
      const pageSize = Math.min(100, parseInt(params.pageSize || '50', 10) || 50);
      const cursor = params.cursor?.trim() || null;

      const pool = await getPool();
      const clause = await buildMembershipClause(pool, segment, 2);
      const rows = await pool.query(
        `SELECT c.* FROM contacts c
          WHERE c.workspace_id = $1
            AND ($2::uuid IS NULL OR c.contact_id > $2)
            AND ${clause.text}
          ORDER BY c.contact_id
          LIMIT ${pageSize + 1}`,
        [workspaceId, cursor, ...clause.params],
      );
      const hasMore = rows.rows.length > pageSize;
      const data = hasMore ? rows.rows.slice(0, pageSize) : rows.rows;
      const nextCursor = hasMore ? data[data.length - 1]?.contact_id : null;
      const total = await countSegmentMembers(pool, workspaceId, pathId);

      return respond(200, { data, meta: { total, pageSize, nextCursor, hasMore } });
    }

    // POST /segments/preview-count — live count for an unsaved rule tree
    if (method === 'POST' && event.path?.endsWith('/preview-count')) {
      const body = JSON.parse(event.body || '{}');
      try {
        const total = await countRulePreview(await getPool(), workspaceId, body.rules);
        return respond(200, { total });
      } catch (err) {
        if (err instanceof RuleValidationError) return respond(400, { message: `Invalid rules: ${err.message}` });
        throw err;
      }
    }

    // POST /segments/{id}/contacts — add contacts (static segments only)
    if (method === 'POST' && pathId && event.path?.endsWith('/contacts')) {
      const writeDenied = requireRole(event, 'editor');
      if (writeDenied) return writeDenied;

      const [seg] = await db.select().from(segments).where(
        and(eq(segments.segmentId, pathId), eq(segments.workspaceId, workspaceId))
      );
      if (!seg) return respond(404, { message: 'Segment not found' });
      if (seg.kind === 'dynamic') {
        return respond(409, { message: 'Cannot add contacts to a dynamic segment; membership is rule-based' });
      }

      const body = JSON.parse(event.body || '{}');
      const contactIds: string[] = body.contactIds;
      if (!Array.isArray(contactIds) || contactIds.length === 0) {
        return respond(400, { message: 'contactIds array required' });
      }

      const rows = contactIds.map(cid => ({ contactId: cid, segmentId: pathId }));
      await db.insert(contactSegment).values(rows).onConflictDoNothing();
      return respond(200, { added: contactIds.length });
    }

    // POST /segments — create (static or dynamic)
    if (method === 'POST') {
      const writeDenied = requireRole(event, 'editor');
      if (writeDenied) return writeDenied;
      const body = JSON.parse(event.body || '{}');
      const kind = body.kind === 'dynamic' ? 'dynamic' : 'static';

      if (kind === 'dynamic') {
        if (!body.rules) return respond(400, { message: 'Dynamic segments require rules' });
        const ruleError = await validateRules(workspaceId, body.rules);
        if (ruleError) return respond(400, { message: `Invalid rules: ${ruleError}` });
      }

      const [row] = await db.insert(segments).values({
        workspaceId,
        name: body.name || 'New Segment',
        description: body.description || null,
        color: body.color || null,
        kind,
        rules: kind === 'dynamic' ? body.rules : null,
      }).returning();

      // Compute the initial cached count for dynamic segments
      let result = row;
      if (kind === 'dynamic') {
        const total = await countSegmentMembers(await getPool(), workspaceId, row.segmentId);
        await db.update(segments)
          .set({ cachedCount: total, countRefreshedAt: new Date() })
          .where(eq(segments.segmentId, row.segmentId));
        result = { ...row, cachedCount: total, countRefreshedAt: new Date() };
      }

      return respond(201, result);
    }

    // PUT /segments/{id}
    if (method === 'PUT' && pathId) {
      const writeDenied = requireRole(event, 'editor');
      if (writeDenied) return writeDenied;
      const body = JSON.parse(event.body || '{}');

      const [existing] = await db.select().from(segments).where(
        and(eq(segments.segmentId, pathId), eq(segments.workspaceId, workspaceId))
      );
      if (!existing) return respond(404, { message: 'Segment not found' });

      const updates: Record<string, unknown> = {};
      if (body.name !== undefined) updates.name = body.name;
      if (body.description !== undefined) updates.description = body.description;
      if (body.color !== undefined) updates.color = body.color;
      if (body.sort_order !== undefined) updates.sortOrder = body.sort_order;

      // Rule edits apply only to dynamic segments; recompute the cached count.
      if (body.rules !== undefined && existing.kind === 'dynamic') {
        const ruleError = await validateRules(workspaceId, body.rules);
        if (ruleError) return respond(400, { message: `Invalid rules: ${ruleError}` });
        updates.rules = body.rules;
      }

      await db.update(segments).set(updates).where(
        and(eq(segments.segmentId, pathId), eq(segments.workspaceId, workspaceId))
      );

      if (updates.rules !== undefined) {
        const total = await countSegmentMembers(await getPool(), workspaceId, pathId);
        await db.update(segments)
          .set({ cachedCount: total, countRefreshedAt: new Date() })
          .where(eq(segments.segmentId, pathId));
      }

      return respond(200, { message: 'Updated' });
    }

    // DELETE /segments/{id}/contacts — remove contacts (static segments)
    if (method === 'DELETE' && pathId && event.path?.endsWith('/contacts')) {
      const writeDenied = requireRole(event, 'editor');
      if (writeDenied) return writeDenied;

      const [seg] = await db.select().from(segments).where(
        and(eq(segments.segmentId, pathId), eq(segments.workspaceId, workspaceId))
      );
      if (!seg) return respond(404, { message: 'Segment not found' });

      const body = JSON.parse(event.body || '{}');
      const contactIds: string[] = body.contactIds;
      if (!Array.isArray(contactIds) || contactIds.length === 0) {
        return respond(400, { message: 'contactIds array required' });
      }

      await db.delete(contactSegment).where(
        and(
          eq(contactSegment.segmentId, pathId),
          inArray(contactSegment.contactId, contactIds)
        )
      );
      return respond(200, { removed: contactIds.length });
    }

    // DELETE /segments/{id} — requires admin
    if (method === 'DELETE' && pathId) {
      const deleteDenied = requireRole(event, 'admin');
      if (deleteDenied) return deleteDenied;
      await db.delete(segments).where(
        and(eq(segments.segmentId, pathId), eq(segments.workspaceId, workspaceId))
      );
      return respond(204, null);
    }

    return respond(405, { message: 'Method not allowed' });
  } catch (err) {
    console.error('Segments error:', err);
    return respond(500, { message: 'Internal server error' });
  }
};
