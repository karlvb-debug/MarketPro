// ============================================
// Contacts CRUD Lambda
// GET /contacts — list (paginated, searchable)
// POST /contacts — create
// PUT /contacts/{id} — update
// DELETE /contacts/{id} — delete
// ============================================

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { eq, and, or, ilike, sql, inArray } from 'drizzle-orm';
import { getDb, respond, getWorkspaceId, getUserId } from '../lib/db';
import { contacts } from '../../drizzle/schema';

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const method = event.httpMethod;
  const userId = getUserId(event);
  if (!userId) return respond(401, { message: 'Unauthorized' });

  const workspaceId = getWorkspaceId(event);
  if (!workspaceId) return respond(400, { message: 'Missing X-Workspace-Id header' });

  const db = await getDb();
  const pathId = event.pathParameters?.id;

  try {
    // GET /contacts
    if (method === 'GET' && !pathId) {
      const params = event.queryStringParameters || {};
      const page = Math.max(1, parseInt(params.page || '1', 10));
      const pageSize = Math.min(100, parseInt(params.pageSize || '50', 10));
      const search = params.search?.trim();
      const status = params.status;

      let query = db
        .select()
        .from(contacts)
        .where(eq(contacts.workspaceId, workspaceId))
        .limit(pageSize)
        .offset((page - 1) * pageSize)
        .orderBy(contacts.createdAt);

      // Add search filter
      if (search) {
        query = db
          .select()
          .from(contacts)
          .where(
            and(
              eq(contacts.workspaceId, workspaceId),
              or(
                ilike(contacts.email, `%${search}%`),
                ilike(contacts.firstName, `%${search}%`),
                ilike(contacts.lastName, `%${search}%`),
                ilike(contacts.company, `%${search}%`),
              ),
            ),
          )
          .limit(pageSize)
          .offset((page - 1) * pageSize)
          .orderBy(contacts.createdAt);
      }

      const rows = await query;

      // Get total count
      const [countResult] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(contacts)
        .where(eq(contacts.workspaceId, workspaceId));

      return respond(200, {
        data: rows,
        meta: { total: countResult?.count || 0, page, pageSize },
      });
    }

    // GET /contacts/{id}
    if (method === 'GET' && pathId) {
      const [row] = await db
        .select()
        .from(contacts)
        .where(and(eq(contacts.contactId, pathId), eq(contacts.workspaceId, workspaceId)));

      if (!row) return respond(404, { message: 'Contact not found' });
      return respond(200, row);
    }

    // POST /contacts/import — bulk upsert (up to 1,000 per request)
    if (method === 'POST' && event.path?.endsWith('/import')) {
      const body = JSON.parse(event.body || '{}');
      const rows: unknown[] = Array.isArray(body.contacts) ? body.contacts.slice(0, 1000) : [];
      if (rows.length === 0) return respond(400, { message: 'No contacts provided' });

      const values = rows.map((c: any) => ({
        workspaceId,
        email: c.email || null,
        phone: c.phone || null,
        firstName: c.first_name || c.firstName || null,
        lastName: c.last_name || c.lastName || null,
        company: c.company || null,
        timezone: c.timezone || null,
        state: c.state || null,
        status: 'active' as const,
        source: c.source || 'csv_import',
        consentSource: c.consent_source || c.consentSource || null,
        customFields: c.custom_fields || c.customFields || {},
      }));

      // Single INSERT ... ON CONFLICT DO UPDATE for all contacts
      const result = await db
        .insert(contacts)
        .values(values)
        .onConflictDoUpdate({
          target: [contacts.workspaceId, contacts.email],
          set: {
            firstName: sql`COALESCE(EXCLUDED.first_name, contacts.first_name)`,
            lastName: sql`COALESCE(EXCLUDED.last_name, contacts.last_name)`,
            phone: sql`COALESCE(EXCLUDED.phone, contacts.phone)`,
            company: sql`COALESCE(EXCLUDED.company, contacts.company)`,
            timezone: sql`COALESCE(EXCLUDED.timezone, contacts.timezone)`,
            state: sql`COALESCE(EXCLUDED.state, contacts.state)`,
            consentSource: sql`COALESCE(EXCLUDED.consent_source, contacts.consent_source)`,
            updatedAt: new Date(),
          },
        })
        .returning({ contactId: contacts.contactId });

      return respond(200, { imported: result.length });
    }

    // POST /contacts — single upsert
    if (method === 'POST') {
      const body = JSON.parse(event.body || '{}');

      const values = {
        workspaceId,
        email: body.email || null,
        phone: body.phone || null,
        firstName: body.first_name || body.firstName || null,
        lastName: body.last_name || body.lastName || null,
        company: body.company || null,
        timezone: body.timezone || null,
        state: body.state || null,
        status: (body.status || 'active') as 'active' | 'unsubscribed' | 'bounced' | 'complained',
        source: body.source || 'manual',
        consentSource: body.consent_source || body.consentSource || null,
        customFields: body.custom_fields || body.customFields || {},
      };

      // Upsert: if email already exists in this workspace, merge non-empty fields
      const [row] = await db
        .insert(contacts)
        .values(values)
        .onConflictDoUpdate({
          target: [contacts.workspaceId, contacts.email],
          set: {
            firstName: sql`COALESCE(EXCLUDED.first_name, contacts.first_name)`,
            lastName: sql`COALESCE(EXCLUDED.last_name, contacts.last_name)`,
            phone: sql`COALESCE(EXCLUDED.phone, contacts.phone)`,
            company: sql`COALESCE(EXCLUDED.company, contacts.company)`,
            timezone: sql`COALESCE(EXCLUDED.timezone, contacts.timezone)`,
            state: sql`COALESCE(EXCLUDED.state, contacts.state)`,
            consentSource: sql`COALESCE(EXCLUDED.consent_source, contacts.consent_source)`,
            updatedAt: new Date(),
          },
        })
        .returning();

      return respond(row ? 200 : 201, row);
    }

    // PUT /contacts/{id}
    if (method === 'PUT' && pathId) {
      const body = JSON.parse(event.body || '{}');
      const updates: Record<string, any> = { updatedAt: new Date() };

      if (body.email !== undefined) updates.email = body.email;
      if (body.phone !== undefined) updates.phone = body.phone;
      if (body.first_name ?? body.firstName) updates.firstName = body.first_name || body.firstName;
      if (body.last_name ?? body.lastName) updates.lastName = body.last_name || body.lastName;
      if (body.company !== undefined) updates.company = body.company;
      if (body.timezone !== undefined) updates.timezone = body.timezone;
      if (body.status !== undefined) updates.status = body.status;
      if (body.custom_fields ?? body.customFields) updates.customFields = body.custom_fields || body.customFields;

      await db.update(contacts).set(updates).where(
        and(eq(contacts.contactId, pathId), eq(contacts.workspaceId, workspaceId))
      );

      return respond(200, { message: 'Updated' });
    }

    // DELETE /contacts/{id} — single delete
    if (method === 'DELETE' && pathId) {
      await db.delete(contacts).where(
        and(eq(contacts.contactId, pathId), eq(contacts.workspaceId, workspaceId))
      );
      return respond(204, null);
    }

    // DELETE /contacts (no id) — bulk delete, body: { ids: string[] }
    if (method === 'DELETE' && !pathId) {
      const body = JSON.parse(event.body || '{}');
      const ids: string[] = Array.isArray(body.ids) ? body.ids.slice(0, 500) : [];
      if (ids.length === 0) return respond(400, { message: 'No ids provided' });

      const deleted = await db.delete(contacts).where(
        and(
          eq(contacts.workspaceId, workspaceId),
          inArray(contacts.contactId, ids)
        )
      ).returning({ contactId: contacts.contactId });

      return respond(200, { deleted: deleted.length });
    }

    return respond(405, { message: 'Method not allowed' });
  } catch (err) {
    console.error('Contacts error:', err);
    return respond(500, { message: 'Internal server error' });
  }
};
