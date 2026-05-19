// ============================================
// Batch Data Lambda
// GET /batch — returns all workspace data in one call
// Eliminates 7 separate cold-start Lambda invocations
// ============================================

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { eq, sql } from 'drizzle-orm';
import { getDb, respond, getWorkspaceId, getUserId } from '../lib/db';
import {
  contacts,
  segments,
  contactSegment,
  campaigns,
  emailTemplates,
  smsTemplates,
  callScripts,
  workspaceSettings,
} from '../../drizzle/schema';

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const userId = getUserId(event);
  if (!userId) return respond(401, { message: 'Unauthorized' });

  const workspaceId = getWorkspaceId(event);
  if (!workspaceId) return respond(400, { message: 'Missing X-Workspace-Id header' });

  const db = await getDb();

  try {
    // Run all queries in parallel — single Lambda, single DB connection
    const [
      contactRows,
      segmentRows,
      contactSegmentRows,
      campaignRows,
      emailTplRows,
      smsTplRows,
      voiceRows,
      settingsRows,
    ] = await Promise.all([
      db.select().from(contacts).where(eq(contacts.workspaceId, workspaceId)).orderBy(contacts.createdAt),
      // Segments with contact counts via subquery
      db.select({
        segmentId: segments.segmentId,
        workspaceId: segments.workspaceId,
        name: segments.name,
        description: segments.description,
        folderId: segments.folderId,
        sortOrder: segments.sortOrder,
        color: segments.color,
        createdAt: segments.createdAt,
        contactCount: sql<number>`(
          SELECT count(*)::int FROM contact_segment cs
          WHERE cs.segment_id = ${segments.segmentId}
        )`,
      }).from(segments).where(eq(segments.workspaceId, workspaceId)).orderBy(segments.sortOrder),
      // Contact-segment membership for this workspace's contacts
      db.select({
        contactId: contactSegment.contactId,
        segmentId: contactSegment.segmentId,
      }).from(contactSegment)
        .innerJoin(contacts, eq(contactSegment.contactId, contacts.contactId))
        .where(eq(contacts.workspaceId, workspaceId)),
      db.select().from(campaigns).where(eq(campaigns.workspaceId, workspaceId)).orderBy(campaigns.createdAt),
      db.select().from(emailTemplates).where(eq(emailTemplates.workspaceId, workspaceId)).orderBy(emailTemplates.sortOrder),
      db.select().from(smsTemplates).where(eq(smsTemplates.workspaceId, workspaceId)).orderBy(smsTemplates.sortOrder),
      db.select().from(callScripts).where(eq(callScripts.workspaceId, workspaceId)).orderBy(callScripts.sortOrder),
      db.select().from(workspaceSettings).where(eq(workspaceSettings.workspaceId, workspaceId)),
    ]);

    return respond(200, {
      contacts: contactRows,
      segments: segmentRows,
      contactSegments: contactSegmentRows,
      campaigns: campaignRows,
      templates: {
        email: emailTplRows,
        sms: smsTplRows,
        voice: voiceRows,
      },
      settings: settingsRows[0] || null,
    });
  } catch (err) {
    console.error('Batch load error:', err);
    return respond(500, { message: 'Internal server error' });
  }
};
