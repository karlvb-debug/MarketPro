// ============================================
// Contacts CRUD Lambda
// GET /contacts — list (paginated, searchable)
// POST /contacts — create
// PUT /contacts/{id} — update
// DELETE /contacts/{id} — delete
// ============================================

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { eq, ne, and, or, ilike, sql, inArray } from 'drizzle-orm';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { normalizeContactRow } from '../lib/contact-validate';
import { loadFieldDefinitions, validateCustomFields, findUniqueViolations } from '../lib/custom-fields';
import { parseRules, compileRules, RuleValidationError } from '../lib/rules';
import { getDb, getPool, respond, getWorkspaceId, getUserId, requireRole, isSuperAdmin, methodToAction } from '../lib/db';
import { contacts, adminAuditLog, segments, contactSegment, suppressionList } from '../../drizzle/schema';
import * as crypto from 'crypto';

const s3Client = new S3Client({});

const syncSuppression = async (db: any, workspaceId: string, email: string | null, phone: string | null, status: string) => {
  if (['unsubscribed', 'bounced', 'complained'].includes(status)) {
    const reason = status === 'unsubscribed' ? 'unsubscribe' : status === 'bounced' ? 'bounce' : 'complaint';
    
    if (email) {
      const emailHash = crypto.createHash('sha256').update(email.toLowerCase().trim()).digest('hex');
      const [existing] = await db.select().from(suppressionList).where(
        and(eq(suppressionList.workspaceId, workspaceId), eq(suppressionList.emailHash, emailHash))
      );
      if (!existing) {
        await db.insert(suppressionList).values({
          workspaceId,
          emailHash,
          reason,
        });
      }
    }
    if (phone) {
      const phoneNorm = phone.replace(/\D/g, '');
      const phoneHash = crypto.createHash('sha256').update(phoneNorm).digest('hex');
      const [existing] = await db.select().from(suppressionList).where(
        and(eq(suppressionList.workspaceId, workspaceId), eq(suppressionList.phoneHash, phoneHash))
      );
      if (!existing) {
        await db.insert(suppressionList).values({
          workspaceId,
          phoneHash,
          reason,
        });
      }
    }
  }
};

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
      const params = event.queryStringParameters || {};
      const segmentId = params.segmentId?.trim();

      // Create a unique key for the import file, ensuring it's isolated by workspace
      const fileId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const key = segmentId
        ? `${workspaceId}/import-${fileId}-seg-${segmentId}.csv`
        : `${workspaceId}/import-${fileId}.csv`;
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
      const status = params.status?.trim();
      const search = params.search?.trim();
      const segmentId = params.segmentId?.trim();

      // Build WHERE conditions
      const conditions = [eq(contacts.workspaceId, workspaceId)];

      if (status) {
        conditions.push(eq(contacts.status, status as any));
      }

      if (segmentId) {
        conditions.push(
          sql`${contacts.contactId} IN (
            SELECT contact_id FROM contact_segment 
            WHERE segment_id = ${segmentId}
          )`
        );
      }

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

      // Fetch segment names for the paginated page of contacts
      let dataWithSegments = data.map((c: any) => ({ ...c, segments: [] }));
      const contactIds = data.map((c: any) => c.contactId);

      if (contactIds.length > 0) {
        const contactSegmentsList = await db
          .select({
            contactId: contactSegment.contactId,
            segmentName: segments.name,
          })
          .from(contactSegment)
          .innerJoin(segments, eq(contactSegment.segmentId, segments.segmentId))
          .where(inArray(contactSegment.contactId, contactIds));

        const segmentMap = new Map<string, string[]>();
        for (const cs of contactSegmentsList) {
          if (cs.contactId && cs.segmentName) {
            const existing = segmentMap.get(cs.contactId) || [];
            existing.push(cs.segmentName);
            segmentMap.set(cs.contactId, existing);
          }
        }

        dataWithSegments = data.map((c: any) => ({
          ...c,
          segments: segmentMap.get(c.contactId) || [],
        }));
      }

      // Build count conditions (excluding cursor check)
      const countConditions = [eq(contacts.workspaceId, workspaceId)];
      if (status) {
        countConditions.push(eq(contacts.status, status as any));
      }
      if (segmentId) {
        countConditions.push(
          sql`${contacts.contactId} IN (
            SELECT contact_id FROM contact_segment 
            WHERE segment_id = ${segmentId}
          )`
        );
      }
      if (search) {
        countConditions.push(
          or(
            ilike(contacts.email, `%${search}%`),
            ilike(contacts.firstName, `%${search}%`),
            ilike(contacts.lastName, `%${search}%`),
            ilike(contacts.company, `%${search}%`),
          )!
        );
      }

      // Get total count matching current filters
      const [countResult] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(contacts)
        .where(and(...countConditions));

      return respond(200, {
        data: dataWithSegments,
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

    // POST /contacts/search — server-side rule filtering (same shape as
    // GET /contacts, but rules can be arbitrarily large JSON). Compiled by
    // the whitelisting rule engine — see lambda/lib/rules.ts.
    if (method === 'POST' && event.path?.endsWith('/search')) {
      const body = JSON.parse(event.body || '{}');
      const pageSize = Math.min(100, parseInt(String(body.pageSize || '50'), 10) || 50);
      const cursor = typeof body.cursor === 'string' ? body.cursor : null;

      const pool = await getPool();
      let ruleSql = '';
      let ruleParams: unknown[] = [];
      if (body.rules) {
        try {
          const defs = (await loadFieldDefinitions(pool, workspaceId)).filter((d) => !d.archived);
          // $1 = workspaceId, $2 = cursor placeholder budget handled below
          const compiled = compileRules(parseRules(body.rules), defs, 2);
          ruleSql = ` AND ${compiled.text}`;
          ruleParams = compiled.params;
        } catch (err) {
          if (err instanceof RuleValidationError) {
            return respond(400, { message: `Invalid rules: ${err.message}` });
          }
          throw err;
        }
      }

      const rows = await pool.query(
        `SELECT c.* FROM contacts c
          WHERE c.workspace_id = $1
            AND ($2::uuid IS NULL OR c.contact_id > $2)${ruleSql}
          ORDER BY c.contact_id
          LIMIT ${pageSize + 1}`,
        [workspaceId, cursor, ...ruleParams],
      );

      const hasMore = rows.rows.length > pageSize;
      const data = hasMore ? rows.rows.slice(0, pageSize) : rows.rows;
      const nextCursor = hasMore ? data[data.length - 1]?.contact_id : null;

      const count = await pool.query(
        `SELECT COUNT(*)::int AS total FROM contacts c
          WHERE c.workspace_id = $1 AND ($2::uuid IS NULL OR TRUE)${ruleSql}`,
        [workspaceId, null, ...ruleParams],
      );

      return respond(200, {
        data,
        meta: { total: count.rows[0].total, pageSize, nextCursor, hasMore },
      });
    }

    // POST /contacts/import — bulk upsert (up to 1,000 per request)
    // Requires editor role or higher
    // Two-pass strategy to handle both email-based and phone-only contacts
    if (method === 'POST' && event.path?.endsWith('/import')) {
      const writeDenied = requireRole(event, 'editor');
      if (writeDenied) return writeDenied;
      const body = JSON.parse(event.body || '{}');
      const rawRows: unknown[] = Array.isArray(body.contacts) ? body.contacts.slice(0, 1000) : [];
      const segmentId = body.segmentId?.trim();
      if (rawRows.length === 0) return respond(400, { message: 'No contacts provided' });

      // Normalize + validate every row (shared with the CSV pipeline):
      // emails lowercased/syntax-checked, phones canonicalized to E.164,
      // names control-char-stripped, custom fields sanitized to capped
      // scalars. Rows with neither valid email nor valid phone are rejected.
      const toValues = (c: any) => {
        const n = normalizeContactRow(c);
        if (!n) return null;
        return {
          workspaceId,
          ...n,
          status: 'active' as const,
          source: c.source || 'csv_import',
          consentSource: c.consent_source || c.consentSource || null,
        };
      };
      // Lenient typed validation for bulk import: invalid custom-field
      // values are dropped (the row still imports); strict 400s would make
      // large CSV imports unusable.
      const fieldDefs = await loadFieldDefinitions(await getPool(), workspaceId);
      let droppedFieldValues = 0;
      const normalized = rawRows
        .map((c) => toValues(c))
        .filter((c): c is NonNullable<ReturnType<typeof toValues>> => c !== null)
        .map((c) => {
          const validation = validateCustomFields(fieldDefs, c.customFields, { forCreate: false });
          droppedFieldValues += Object.keys(validation.errors).length;
          return { ...c, customFields: validation.values };
        });

      // Split into: contacts with email vs phone-only vs invalid
      const withEmail = normalized.filter((c) => c.email);
      const phoneOnly = normalized.filter((c) => !c.email && c.phone);
      const rejected = rawRows.length - withEmail.length - phoneOnly.length;

      // All three passes commit or roll back together: a failure in the
      // phone-only pass or the segment association must not leave orphaned
      // half-imported contacts.
      const imported = await db.transaction(async (tx) => {
      let importedCount = 0;
      const contactIds: string[] = [];

      // Pass 1: Upsert contacts WITH email (deduplicate on workspace + email)
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

      // Pass 2: Upsert phone-only contacts (deduplicate on workspace + phone)
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

      // Pass 3: Associate with segment if segmentId is provided and contactIds is not empty
      if (segmentId && contactIds.length > 0) {
        // Verify segment belongs to this workspace
        const [seg] = await tx
          .select()
          .from(segments)
          .where(and(eq(segments.segmentId, segmentId), eq(segments.workspaceId, workspaceId)));
        if (seg) {
          const csRows = contactIds.map((cid) => ({ contactId: cid, segmentId }));
          await tx.insert(contactSegment).values(csRows).onConflictDoNothing();
        }
      }

      return importedCount;
      });

      return respond(200, { imported, rejected, droppedFieldValues });
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

      // Typed custom-field validation (strict: API callers get a 400)
      {
        const pool = await getPool();
        const defs = await loadFieldDefinitions(pool, workspaceId);
        const validation = validateCustomFields(defs, values.customFields, { forCreate: true });
        if (Object.keys(validation.errors).length > 0 || validation.missingRequired.length > 0) {
          return respond(400, {
            message: 'Custom field validation failed',
            fieldErrors: validation.errors,
            missingRequired: validation.missingRequired,
          });
        }
        const violations = await findUniqueViolations(pool, workspaceId, defs, validation.values);
        if (violations.length > 0) {
          return respond(409, { message: 'Unique custom field values already in use', fields: violations });
        }
        values.customFields = validation.values;
      }

      // 1. Check if email or phone already exists in this workspace
      let existingContact: any = null;
      if (values.email) {
        const [match] = await db
          .select()
          .from(contacts)
          .where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.email, values.email)));
        if (match) existingContact = match;
      }
      if (!existingContact && values.phone) {
        const [match] = await db
          .select()
          .from(contacts)
          .where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.phone, values.phone)));
        if (match) existingContact = match;
      }

      let row: any;
      let statusCode = 201;
      if (existingContact) {
        // Merge values: keep existing if new is empty
        const merged = {
          firstName: values.firstName || existingContact.firstName,
          lastName: values.lastName || existingContact.lastName,
          email: values.email || existingContact.email,
          phone: values.phone || existingContact.phone,
          company: values.company || existingContact.company,
          timezone: values.timezone || existingContact.timezone,
          state: values.state || existingContact.state,
          // Unsubscribed/Bounced/Complained status retention:
          status: ['unsubscribed', 'bounced', 'complained'].includes(existingContact.status)
            ? existingContact.status
            : (values.status || existingContact.status),
          consentSource: values.consentSource || existingContact.consentSource,
          customFields: { ...existingContact.customFields, ...values.customFields },
          updatedAt: new Date(),
        };

        const [updated] = await db
          .update(contacts)
          .set(merged)
          .where(eq(contacts.contactId, existingContact.contactId))
          .returning();
        row = updated;
        statusCode = 200;
      } else {
        // Insert new contact
        const [inserted] = await db
          .insert(contacts)
          .values(values)
          .returning();
        row = inserted;
      }

      // Sync suppression list if the contact is suppressed
      await syncSuppression(db, workspaceId, row.email, row.phone, row.status);

      return respond(statusCode, row);
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
      if (body.state !== undefined) updates.state = body.state;
      if (body.status !== undefined) updates.status = body.status;
      if (body.consent_source ?? body.consentSource) updates.consentSource = body.consent_source || body.consentSource;
      if (body.custom_fields ?? body.customFields) updates.customFields = body.custom_fields || body.customFields;

      // Check conflicts before updating
      if (updates.email) {
        const [conflict] = await db
          .select()
          .from(contacts)
          .where(
            and(
              eq(contacts.workspaceId, workspaceId),
              eq(contacts.email, updates.email),
              ne(contacts.contactId, pathId)
            )
          );
        if (conflict) {
          return respond(400, { message: `A contact with email "${updates.email}" already exists.` });
        }
      }

      if (updates.phone) {
        const [conflict] = await db
          .select()
          .from(contacts)
          .where(
            and(
              eq(contacts.workspaceId, workspaceId),
              eq(contacts.phone, updates.phone),
              ne(contacts.contactId, pathId)
            )
          );
        if (conflict) {
          return respond(400, { message: `A contact with phone "${updates.phone}" already exists.` });
        }
      }

      const [row] = await db.update(contacts).set(updates).where(
        and(eq(contacts.contactId, pathId), eq(contacts.workspaceId, workspaceId))
      ).returning();

      if (!row) return respond(404, { message: 'Contact not found' });

      // Sync suppression list if the contact is suppressed
      await syncSuppression(db, workspaceId, row.email, row.phone, row.status);

      return respond(200, row);
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
