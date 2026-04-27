// ============================================
// Settings CRUD Lambda
// GET /settings — get workspace settings
// PUT /settings — upsert workspace settings
// ============================================

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { eq } from 'drizzle-orm';
import { getDb, respond, getWorkspaceId, getUserId } from '../lib/db';
import { workspaceSettings } from '../../drizzle/schema';

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const method = event.httpMethod;
  const userId = getUserId(event);
  if (!userId) return respond(401, { message: 'Unauthorized' });

  const workspaceId = getWorkspaceId(event);
  if (!workspaceId) return respond(400, { message: 'Missing X-Workspace-Id header' });

  const db = await getDb();

  try {
    // GET /settings
    if (method === 'GET') {
      const [row] = await db
        .select()
        .from(workspaceSettings)
        .where(eq(workspaceSettings.workspaceId, workspaceId));

      return respond(200, row || {});
    }

    // PUT /settings — upsert
    if (method === 'PUT') {
      const body = JSON.parse(event.body || '{}');

      // Try update first
      const result = await db.update(workspaceSettings).set({
        smsSenderId: body.sms_sender_id ?? body.smsSenderId,
        smsPhoneNumber: body.sms_phone_number ?? body.smsPhoneNumber,
        voicePhoneNumber: body.voice_phone_number ?? body.voicePhoneNumber,
        emailFromName: body.email_from_name ?? body.emailFromName,
        emailFromAddress: body.email_from_address ?? body.emailFromAddress,
        emailReplyTo: body.email_reply_to ?? body.emailReplyTo,
        timezone: body.timezone,
        businessName: body.business_name ?? body.businessName,
        businessAddress: body.business_address ?? body.businessAddress,
        businessCity: body.business_city ?? body.businessCity,
        businessState: body.business_state ?? body.businessState,
        businessZip: body.business_zip ?? body.businessZip,
        businessCountry: body.business_country ?? body.businessCountry,
        sanNumber: body.san_number ?? body.sanNumber,
        updatedAt: new Date(),
      }).where(eq(workspaceSettings.workspaceId, workspaceId));

      // If no rows updated, insert
      if ((result as any).rowCount === 0) {
        await db.insert(workspaceSettings).values({
          workspaceId,
          emailFromName: body.email_from_name ?? body.emailFromName,
          emailFromAddress: body.email_from_address ?? body.emailFromAddress,
          timezone: body.timezone || 'America/New_York',
          businessName: body.business_name ?? body.businessName,
          businessCountry: body.business_country ?? body.businessCountry ?? 'US',
        });
      }

      return respond(200, { message: 'Settings saved' });
    }

    return respond(405, { message: 'Method not allowed' });
  } catch (err) {
    console.error('Settings error:', err);
    return respond(500, { message: 'Internal server error' });
  }
};
