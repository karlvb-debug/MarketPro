// ============================================
// Templates CRUD Lambda
// Handles all template types: email, sms, voice
// GET    /templates/:type          — list
// POST   /templates/:type          — create
// PUT    /templates/:type/:id      — update
// DELETE /templates/:type/:id      — delete
// ============================================

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { eq, and } from 'drizzle-orm';
import { getDb, respond, getWorkspaceId, getUserId, requireRole } from '../lib/db';
import { emailTemplates, smsTemplates, callScripts } from '../../drizzle/schema';

// Map URL type to Drizzle table + ID column name
function getTable(type: string) {
  switch (type) {
    case 'email': return { table: emailTemplates, idCol: emailTemplates.templateId };
    case 'sms': return { table: smsTemplates, idCol: smsTemplates.templateId };
    case 'voice': return { table: callScripts, idCol: callScripts.scriptId };
    default: return null;
  }
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const method = event.httpMethod;
  const userId = getUserId(event);
  if (!userId) return respond(401, { message: 'Unauthorized' });

  const workspaceId = getWorkspaceId(event);
  if (!workspaceId) return respond(400, { message: 'Missing X-Workspace-Id header' });

  const db = await getDb();

  // Parse path: /templates/{type} or /templates/{type}/{id}
  const pathParts = (event.path || '').split('/').filter(Boolean);
  // pathParts: ['prod', 'templates', 'email'] or ['prod', 'templates', 'email', '{id}']
  // Or could be: ['templates', 'email'] depending on API Gateway config
  const typeIdx = pathParts.indexOf('templates') + 1;
  const templateType = pathParts[typeIdx] || event.pathParameters?.type || '';
  const templateId = event.pathParameters?.id || pathParts[typeIdx + 1] || null;

  const resolved = getTable(templateType);
  if (!resolved) {
    return respond(400, { message: `Unknown template type: "${templateType}". Use email, sms, or voice.` });
  }

  const { table, idCol } = resolved;

  try {
    // GET /templates/{type} — list all templates for workspace
    if (method === 'GET' && !templateId) {
      const rows = await db
        .select()
        .from(table)
        .where(eq((table as any).workspaceId, workspaceId))
        .orderBy((table as any).sortOrder);

      return respond(200, { data: rows });
    }

    // GET /templates/{type}/{id} — single template
    if (method === 'GET' && templateId) {
      const [row] = await db
        .select()
        .from(table)
        .where(and(eq(idCol, templateId), eq((table as any).workspaceId, workspaceId)));

      if (!row) return respond(404, { message: 'Template not found' });
      return respond(200, row);
    }

    // POST /templates/{type} — create (requires editor)
    if (method === 'POST') {
      const writeDenied = requireRole(event, 'editor');
      if (writeDenied) return writeDenied;
      const body = JSON.parse(event.body || '{}');
      let row: any;

      if (templateType === 'email') {
        [row] = await db.insert(emailTemplates).values({
          workspaceId,
          name: body.name || 'Untitled Email',
          subjectLine: body.subject_line ?? body.subjectLine ?? null,
          fromName: body.from_name ?? body.fromName ?? null,
          replyTo: body.reply_to ?? body.replyTo ?? null,
          htmlContent: body.html_content ?? body.htmlContent ?? null,
          editorJson: body.editor_json ?? body.editorJson ?? null,
          thumbnailUrl: body.thumbnail_url ?? body.thumbnailUrl ?? null,
          folderId: body.folder_id ?? body.folderId ?? null,
          sortOrder: body.sort_order ?? body.sortOrder ?? 0,
        }).returning();
      } else if (templateType === 'sms') {
        [row] = await db.insert(smsTemplates).values({
          workspaceId,
          name: body.name || 'Untitled SMS',
          body: body.body || '',
          isUnicode: body.is_unicode ?? body.isUnicode ?? false,
          estimatedSegments: body.estimated_segments ?? body.estimatedSegments ?? 1,
          folderId: body.folder_id ?? body.folderId ?? null,
          sortOrder: body.sort_order ?? body.sortOrder ?? 0,
        }).returning();
      } else if (templateType === 'voice') {
        [row] = await db.insert(callScripts).values({
          workspaceId,
          name: body.name || 'Untitled Script',
          ssmlContent: body.ssml_content ?? body.ssmlContent ?? null,
          voicemailSsml: body.voicemail_ssml ?? body.voicemailSsml ?? null,
          voiceId: body.voice_id ?? body.voiceId ?? 'Joanna',
          connectFlowJson: body.connect_flow_json ?? body.connectFlowJson ?? null,
          folderId: body.folder_id ?? body.folderId ?? null,
          sortOrder: body.sort_order ?? body.sortOrder ?? 0,
        }).returning();
      }

      return respond(201, row);
    }

    // PUT /templates/{type}/{id} — update (requires editor)
    if (method === 'PUT' && templateId) {
      const writeDenied = requireRole(event, 'editor');
      if (writeDenied) return writeDenied;
      const body = JSON.parse(event.body || '{}');
      const updates: Record<string, any> = { updatedAt: new Date() };

      // Common fields
      if (body.name !== undefined) updates.name = body.name;
      if ((body.folder_id ?? body.folderId) !== undefined) updates.folderId = body.folder_id ?? body.folderId;
      if ((body.sort_order ?? body.sortOrder) !== undefined) updates.sortOrder = body.sort_order ?? body.sortOrder;

      // Type-specific fields
      if (templateType === 'email') {
        if ((body.subject_line ?? body.subjectLine) !== undefined) updates.subjectLine = body.subject_line ?? body.subjectLine;
        if ((body.from_name ?? body.fromName) !== undefined) updates.fromName = body.from_name ?? body.fromName;
        if ((body.reply_to ?? body.replyTo) !== undefined) updates.replyTo = body.reply_to ?? body.replyTo;
        if ((body.html_content ?? body.htmlContent) !== undefined) updates.htmlContent = body.html_content ?? body.htmlContent;
        if ((body.editor_json ?? body.editorJson) !== undefined) updates.editorJson = body.editor_json ?? body.editorJson;
        if ((body.thumbnail_url ?? body.thumbnailUrl) !== undefined) updates.thumbnailUrl = body.thumbnail_url ?? body.thumbnailUrl;
      } else if (templateType === 'sms') {
        if (body.body !== undefined) updates.body = body.body;
        if ((body.is_unicode ?? body.isUnicode) !== undefined) updates.isUnicode = body.is_unicode ?? body.isUnicode;
        if ((body.estimated_segments ?? body.estimatedSegments) !== undefined) updates.estimatedSegments = body.estimated_segments ?? body.estimatedSegments;
      } else if (templateType === 'voice') {
        if ((body.ssml_content ?? body.ssmlContent) !== undefined) updates.ssmlContent = body.ssml_content ?? body.ssmlContent;
        if ((body.voicemail_ssml ?? body.voicemailSsml) !== undefined) updates.voicemailSsml = body.voicemail_ssml ?? body.voicemailSsml;
        if ((body.voice_id ?? body.voiceId) !== undefined) updates.voiceId = body.voice_id ?? body.voiceId;
        if ((body.connect_flow_json ?? body.connectFlowJson) !== undefined) updates.connectFlowJson = body.connect_flow_json ?? body.connectFlowJson;
      }

      await db.update(table).set(updates).where(
        and(eq(idCol, templateId), eq((table as any).workspaceId, workspaceId))
      );

      return respond(200, { message: 'Updated' });
    }

    // DELETE /templates/{type}/{id} — requires admin
    if (method === 'DELETE' && templateId) {
      const deleteDenied = requireRole(event, 'admin');
      if (deleteDenied) return deleteDenied;
      await db.delete(table).where(
        and(eq(idCol, templateId), eq((table as any).workspaceId, workspaceId))
      );
      return respond(204, null);
    }

    return respond(405, { message: 'Method not allowed' });
  } catch (err) {
    console.error('Templates error:', err);
    return respond(500, { message: 'Internal server error' });
  }
};
