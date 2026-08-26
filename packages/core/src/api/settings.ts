// ============================================
// GET  /settings — workspace settings
// PUT  /settings — upsert workspace settings (admin)
// ============================================

import { eq } from 'drizzle-orm';
import { getDb } from '../db';
import { workspaceSettings } from '../schema';
import type { RequestContext } from './context';
import { type ApiResult, ok, requireRole, requireWorkspace } from './result';
import { type JsonBody, rowsAffected, str } from './input';

export async function getSettings(ctx: RequestContext): Promise<ApiResult> {
  const missing = requireWorkspace(ctx);
  if (missing) return missing;

  const db = await getDb();
  const [row] = await db
    .select()
    .from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, ctx.workspaceId));

  return ok(row || {});
}

export async function updateSettings(
  ctx: RequestContext,
  body: JsonBody,
): Promise<ApiResult> {
  const missing = requireWorkspace(ctx);
  if (missing) return missing;
  const denied = requireRole(ctx, 'admin');
  if (denied) return denied;

  const db = await getDb();

  // Try update first
  const result = await db.update(workspaceSettings).set({
    smsSenderId: str(body, 'sms_sender_id', 'smsSenderId'),
    smsPhoneNumber: str(body, 'sms_phone_number', 'smsPhoneNumber'),
    voicePhoneNumber: str(body, 'voice_phone_number', 'voicePhoneNumber'),
    emailFromName: str(body, 'email_from_name', 'emailFromName'),
    emailFromAddress: str(body, 'email_from_address', 'emailFromAddress'),
    emailReplyTo: str(body, 'email_reply_to', 'emailReplyTo'),
    timezone: str(body, 'timezone'),
    businessName: str(body, 'business_name', 'businessName'),
    businessAddress: str(body, 'business_address', 'businessAddress'),
    businessCity: str(body, 'business_city', 'businessCity'),
    businessState: str(body, 'business_state', 'businessState'),
    businessZip: str(body, 'business_zip', 'businessZip'),
    businessCountry: str(body, 'business_country', 'businessCountry'),
    sanNumber: str(body, 'san_number', 'sanNumber'),
    updatedAt: new Date(),
  }).where(eq(workspaceSettings.workspaceId, ctx.workspaceId));

  // If no rows updated, insert
  if (rowsAffected(result) === 0) {
    await db.insert(workspaceSettings).values({
      workspaceId: ctx.workspaceId,
      emailFromName: str(body, 'email_from_name', 'emailFromName'),
      emailFromAddress: str(body, 'email_from_address', 'emailFromAddress'),
      timezone: str(body, 'timezone') || 'America/New_York',
      businessName: str(body, 'business_name', 'businessName'),
      businessCountry: str(body, 'business_country', 'businessCountry') ?? 'US',
    });
  }

  return ok({ message: 'Settings saved' });
}
