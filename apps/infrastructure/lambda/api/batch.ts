// ============================================
// Batch Data Lambda
// GET /batch — returns all workspace data in one call
// Eliminates 7 separate cold-start Lambda invocations
// ============================================

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { eq } from 'drizzle-orm';
import { getDb, respond, getWorkspaceId, getUserId } from '../lib/db';
import {
  contacts,
  segments,
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
      campaignRows,
      emailTplRows,
      smsTplRows,
      voiceRows,
      settingsRows,
    ] = await Promise.all([
      db.select().from(contacts).where(eq(contacts.workspaceId, workspaceId)).orderBy(contacts.createdAt),
      db.select().from(segments).where(eq(segments.workspaceId, workspaceId)).orderBy(segments.sortOrder),
      db.select().from(campaigns).where(eq(campaigns.workspaceId, workspaceId)).orderBy(campaigns.createdAt),
      db.select().from(emailTemplates).where(eq(emailTemplates.workspaceId, workspaceId)).orderBy(emailTemplates.sortOrder),
      db.select().from(smsTemplates).where(eq(smsTemplates.workspaceId, workspaceId)).orderBy(smsTemplates.sortOrder),
      db.select().from(callScripts).where(eq(callScripts.workspaceId, workspaceId)).orderBy(callScripts.sortOrder),
      db.select().from(workspaceSettings).where(eq(workspaceSettings.workspaceId, workspaceId)),
    ]);

    return respond(200, {
      contacts: contactRows,
      segments: segmentRows,
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
