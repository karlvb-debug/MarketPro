// ============================================
// GET /batch — all workspace data in one call.
// Collapses what used to be 7 separate cold-start Lambda invocations.
// ============================================

import { eq, sql } from 'drizzle-orm';
import { getDb } from '../db';
import {
  segments,
  campaigns,
  emailTemplates,
  smsTemplates,
  callScripts,
  workspaceSettings,
} from '../schema';
import type { RequestContext } from './context';
import { type ApiResult, ok, requireWorkspace } from './result';

export async function loadBatch(ctx: RequestContext): Promise<ApiResult> {
  const missing = requireWorkspace(ctx);
  if (missing) return missing;

  const db = await getDb();
  const { workspaceId } = ctx;

  // Run all queries in parallel — one invocation, one DB connection.
  const [
    segmentRows,
    campaignRows,
    emailTplRows,
    smsTplRows,
    voiceRows,
    settingsRows,
  ] = await Promise.all([
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
    db.select().from(campaigns).where(eq(campaigns.workspaceId, workspaceId)).orderBy(campaigns.createdAt),
    db.select().from(emailTemplates).where(eq(emailTemplates.workspaceId, workspaceId)).orderBy(emailTemplates.sortOrder),
    db.select().from(smsTemplates).where(eq(smsTemplates.workspaceId, workspaceId)).orderBy(smsTemplates.sortOrder),
    db.select().from(callScripts).where(eq(callScripts.workspaceId, workspaceId)).orderBy(callScripts.sortOrder),
    db.select().from(workspaceSettings).where(eq(workspaceSettings.workspaceId, workspaceId)),
  ]);

  return ok({
    segments: segmentRows,
    campaigns: campaignRows,
    templates: {
      email: emailTplRows,
      sms: smsTplRows,
      voice: voiceRows,
    },
    settings: settingsRows[0] || null,
  });
}
