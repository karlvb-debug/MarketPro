// ============================================
// Contacts CRUD Lambda
// GET /contacts — list (paginated, searchable)
// POST /contacts — create
// PUT /contacts/{id} — update
// DELETE /contacts/{id} — delete
// ============================================

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { eq, and, or, ilike, sql, inArray } from 'drizzle-orm';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getDb, respond, getWorkspaceId, getUserId, requireRole, isSuperAdmin, methodToAction } from '../lib/db';
import { contacts, adminAuditLog } from '../../drizzle/schema';

const s3Client = new S3Client({});

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const method = event.httpMethod;
  const userId = getUserId(event);
  if (!userId) return respond(401, { message: 'Unauthorized' });

  const workspaceId = getWorkspaceId(event);
  if (!workspaceId) return respond(400, { message: 'Missing X-Workspace-Id header' });

  const db = await getDb();
  const pathId = event.pathParameters?.id;

  try {
    // RBAC: All methods require at least viewer
    const viewDenied = requireRole(event, 'viewer');
    if (viewDenied) return viewDenied;

    // GET /contacts/import-url — generate presigned s3 upload URL
    if (method === 'GET' && event.path?.endsWith('/import-url')) {
      const writeDenied = requireRole(event, 'editor');
      if (writeDenied) return writeDenied;

      const uploadBucket = process.env.UPLOAD_BUCKET;
      if (!uploadBucket) return respond(500, { message: 'Upload bucket not configured' });

      // Create a unique key for the import file, ensuring it's isolated by workspace
      const fileId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const key = `${workspaceId}/import-${fileId}.csv`;

      const command = new PutObjectCommand({
        Bucket: uploadBucket,
        Key: key,
        ContentType: 'text/csv',
      });

      // URL valid for 15 minutes
      const presignedUrl = await getSignedUrl(s3Client, command, { expiresIn: 900 });

      return respond(200, { url: presignedUrl, key });
    }

    // GET /contacts
    if (method === 'GET' && !pathId) {
      const params = event.queryStringParameters || {};
      const pageSize = Math.min(100, parseInt(params.pageSize || '50', 10));
      const cursor = params.cursor;  // contactId of the last item from previous page
      const search = params.search?.trim();

      // Build WHERE conditions
      const conditions = [eq(contacts.workspaceId, workspaceId)];

      // Cursor-based keyset pagination: fetch rows after the cursor
      if (cursor) {
        conditions.push(sql`${contacts.contactId} > ${cursor}`);
      }

      // Search filter
      if (search) {
        conditions.push(
          or(
            ilike(contacts.email, `%${search}%`),
            ilike(contacts.firstName, `%${search}%`),
            ilike(contacts.lastName, `%${search}%`),
            ilike(contacts.company, `%${search}%`),
          )!
        );
      }

      const rows = await db
        .select()
        .from(contacts)
        .where(and(...conditions))
        .orderBy(contacts.contactId)
        .limit(pageSize + 1); // Fetch one extra to detect if there's a next page

      const hasMore = rows.length > pageSize;
      const data = hasMore ? rows.slice(0, pageSize) : rows;
      const nextCursor = hasMore ? data[data.length - 1]?.contactId : null;

      // Get total count (cached/estimated for large tables)
      const [countResult] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(contacts)
        .where(eq(contacts.workspaceId, workspaceId));

      return respond(200, {
        data,
        meta: {
          total: countResult?.count || 0,
          pageSize,
          nextCursor,
          hasMore,
        },
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
    // Requires editor role or higher
    // Two-pass strategy to handle both email-based and phone-only contacts
    if (method === 'POST' && event.path?.endsWith('/import')) {
      const writeDenied = requireRole(event, 'editor');
      if (writeDenied) return writeDenied;
      const body = JSON.parse(event.body || '{}');
      const rawRows: unknown[] = Array.isArray(body.contacts) ? body.contacts.slice(0, 1000) : [];
      if (rawRows.length === 0) return respond(400, { message: 'No contacts provided' });

      const toValues = (c: any) => ({
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
      });

      // Split into: contacts with email vs phone-only vs invalid
      const withEmail = rawRows.filter((c: any) => c.email?.trim());
      const phoneOnly = rawRows.filter((c: any) => !c.email?.trim() && c.phone?.trim());
      const rejected = rawRows.length - withEmail.length - phoneOnly.length;

      let imported = 0;

      // Pass 1: Upsert contacts WITH email (deduplicate on workspace + email)
      if (withEmail.length > 0) {
        const result = await db
          .insert(contacts)
          .values(withEmail.map(toValues))
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
        imported += result.length;
      }

      // Pass 2: Upsert phone-only contacts (deduplicate on workspace + phone)
      if (phoneOnly.length > 0) {
        const result = await db
          .insert(contacts)
          .values(phoneOnly.map(toValues))
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
        imported += result.length;
      }

      return respond(200, { imported, rejected });
    }

    // POST /contacts — single upsert
    // Requires editor role or higher
    if (method === 'POST') {
      const writeDenied = requireRole(event, 'editor');
      if (writeDenied) return writeDenied;
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
    // Requires editor role or higher
    if (method === 'PUT' && pathId) {
      const writeDenied = requireRole(event, 'editor');
      if (writeDenied) return writeDenied;
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
    // Requires admin role or higher
    if (method === 'DELETE' && pathId) {
      const deleteDenied = requireRole(event, 'admin');
      if (deleteDenied) return deleteDenied;

      // Log Super Admin impersonation
      if (isSuperAdmin(event)) {
        await db.insert(adminAuditLog).values({
          adminUserId: userId!,
          impersonatedWorkspaceId: workspaceId,
          action: 'DELETE',
          resource: 'contacts',
          resourceId: pathId,
          method: 'DELETE',
          path: event.path || '',
          ipAddress: event.requestContext?.identity?.sourceIp || null,
          userAgent: event.headers?.['User-Agent'] || event.headers?.['user-agent'] || null,
        });
      }
      await db.delete(contacts).where(
        and(eq(contacts.contactId, pathId), eq(contacts.workspaceId, workspaceId))
      );
      return respond(204, null);
    }

    // DELETE /contacts (no id) — bulk delete, body: { ids: string[] }
    // Requires admin role or higher
    if (method === 'DELETE' && !pathId) {
      const deleteDenied = requireRole(event, 'admin');
      if (deleteDenied) return deleteDenied;
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
