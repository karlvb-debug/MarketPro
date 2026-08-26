// ============================================
// Templates CRUD — email, sms, voice
// GET    /templates/{type}      — list
// GET    /templates/{type}/{id} — read
// POST   /templates/{type}      — create (editor)
// PUT    /templates/{type}/{id} — update (editor)
// DELETE /templates/{type}/{id} — delete (admin)
//
// The three template kinds live in different tables with different columns, so
// each operation switches on the type rather than casting a shared table
// handle — the Lambda version leaned on `as any` for this.
// ============================================

import { and, eq } from 'drizzle-orm';
import { getDb } from '../db';
import { callScripts, emailTemplates, smsTemplates } from '../schema';
import type { RequestContext } from './context';
import {
  type ApiResult,
  badRequest,
  created,
  noContent,
  notFound,
  ok,
  requireRole,
  requireWorkspace,
} from './result';
import { bool, has, type JsonBody, num, raw, str } from './input';

export const TEMPLATE_TYPES = ['email', 'sms', 'voice'] as const;
export type TemplateType = typeof TEMPLATE_TYPES[number];

export function isTemplateType(v: string): v is TemplateType {
  return (TEMPLATE_TYPES as readonly string[]).includes(v);
}

function unknownType(type: string): ApiResult {
  return badRequest(`Unknown template type: "${type}". Use email, sms, or voice.`);
}

export async function listTemplates(ctx: RequestContext, type: string): Promise<ApiResult> {
  const missing = requireWorkspace(ctx);
  if (missing) return missing;
  if (!isTemplateType(type)) return unknownType(type);

  const db = await getDb();
  const ws = ctx.workspaceId;

  const rows =
    type === 'email'
      ? await db.select().from(emailTemplates).where(eq(emailTemplates.workspaceId, ws)).orderBy(emailTemplates.sortOrder)
      : type === 'sms'
        ? await db.select().from(smsTemplates).where(eq(smsTemplates.workspaceId, ws)).orderBy(smsTemplates.sortOrder)
        : await db.select().from(callScripts).where(eq(callScripts.workspaceId, ws)).orderBy(callScripts.sortOrder);

  return ok({ data: rows });
}

export async function getTemplate(
  ctx: RequestContext,
  type: string,
  templateId: string,
): Promise<ApiResult> {
  const missing = requireWorkspace(ctx);
  if (missing) return missing;
  if (!isTemplateType(type)) return unknownType(type);

  const db = await getDb();
  const ws = ctx.workspaceId;

  const [row] =
    type === 'email'
      ? await db.select().from(emailTemplates).where(and(eq(emailTemplates.templateId, templateId), eq(emailTemplates.workspaceId, ws)))
      : type === 'sms'
        ? await db.select().from(smsTemplates).where(and(eq(smsTemplates.templateId, templateId), eq(smsTemplates.workspaceId, ws)))
        : await db.select().from(callScripts).where(and(eq(callScripts.scriptId, templateId), eq(callScripts.workspaceId, ws)));

  if (!row) return notFound('Template not found');
  return ok(row);
}

export async function createTemplate(
  ctx: RequestContext,
  type: string,
  body: JsonBody,
): Promise<ApiResult> {
  const missing = requireWorkspace(ctx);
  if (missing) return missing;
  if (!isTemplateType(type)) return unknownType(type);
  const denied = requireRole(ctx, 'editor');
  if (denied) return denied;

  const db = await getDb();
  const workspaceId = ctx.workspaceId;
  const folderId = str(body, 'folder_id', 'folderId') ?? null;
  const sortOrder = num(body, 'sort_order', 'sortOrder') ?? 0;

  if (type === 'email') {
    const [row] = await db.insert(emailTemplates).values({
      workspaceId,
      name: str(body, 'name') || 'Untitled Email',
      subjectLine: str(body, 'subject_line', 'subjectLine') ?? null,
      fromName: str(body, 'from_name', 'fromName') ?? null,
      replyTo: str(body, 'reply_to', 'replyTo') ?? null,
      htmlContent: str(body, 'html_content', 'htmlContent') ?? null,
      editorJson: raw(body, 'editor_json', 'editorJson') ?? null,
      thumbnailUrl: str(body, 'thumbnail_url', 'thumbnailUrl') ?? null,
      folderId,
      sortOrder,
    }).returning();
    return created(row);
  }

  if (type === 'sms') {
    const [row] = await db.insert(smsTemplates).values({
      workspaceId,
      name: str(body, 'name') || 'Untitled SMS',
      body: str(body, 'body') || '',
      isUnicode: bool(body, 'is_unicode', 'isUnicode') ?? false,
      estimatedSegments: num(body, 'estimated_segments', 'estimatedSegments') ?? 1,
      folderId,
      sortOrder,
    }).returning();
    return created(row);
  }

  const [row] = await db.insert(callScripts).values({
    workspaceId,
    name: str(body, 'name') || 'Untitled Script',
    ssmlContent: str(body, 'ssml_content', 'ssmlContent') ?? null,
    voicemailSsml: str(body, 'voicemail_ssml', 'voicemailSsml') ?? null,
    voiceId: str(body, 'voice_id', 'voiceId') ?? 'Joanna',
    connectFlowJson: raw(body, 'connect_flow_json', 'connectFlowJson') ?? null,
    folderId,
    sortOrder,
  }).returning();
  return created(row);
}

export async function updateTemplate(
  ctx: RequestContext,
  type: string,
  templateId: string,
  body: JsonBody,
): Promise<ApiResult> {
  const missing = requireWorkspace(ctx);
  if (missing) return missing;
  if (!isTemplateType(type)) return unknownType(type);
  const denied = requireRole(ctx, 'editor');
  if (denied) return denied;

  const db = await getDb();
  const ws = ctx.workspaceId;

  // Fields common to all three tables. Only keys actually present are written,
  // so a partial update never clobbers an untouched column.
  const common: Record<string, unknown> = { updatedAt: new Date() };
  if (has(body, 'name')) common.name = str(body, 'name');
  if (has(body, 'folder_id', 'folderId')) common.folderId = str(body, 'folder_id', 'folderId') ?? null;
  if (has(body, 'sort_order', 'sortOrder')) common.sortOrder = num(body, 'sort_order', 'sortOrder');

  if (type === 'email') {
    const updates = { ...common };
    if (has(body, 'subject_line', 'subjectLine')) updates.subjectLine = str(body, 'subject_line', 'subjectLine') ?? null;
    if (has(body, 'from_name', 'fromName')) updates.fromName = str(body, 'from_name', 'fromName') ?? null;
    if (has(body, 'reply_to', 'replyTo')) updates.replyTo = str(body, 'reply_to', 'replyTo') ?? null;
    if (has(body, 'html_content', 'htmlContent')) updates.htmlContent = str(body, 'html_content', 'htmlContent') ?? null;
    if (has(body, 'editor_json', 'editorJson')) updates.editorJson = raw(body, 'editor_json', 'editorJson') ?? null;
    if (has(body, 'thumbnail_url', 'thumbnailUrl')) updates.thumbnailUrl = str(body, 'thumbnail_url', 'thumbnailUrl') ?? null;
    await db.update(emailTemplates).set(updates)
      .where(and(eq(emailTemplates.templateId, templateId), eq(emailTemplates.workspaceId, ws)));
    return ok({ message: 'Updated' });
  }

  if (type === 'sms') {
    const updates = { ...common };
    if (has(body, 'body')) updates.body = str(body, 'body');
    if (has(body, 'is_unicode', 'isUnicode')) updates.isUnicode = bool(body, 'is_unicode', 'isUnicode');
    if (has(body, 'estimated_segments', 'estimatedSegments')) updates.estimatedSegments = num(body, 'estimated_segments', 'estimatedSegments');
    await db.update(smsTemplates).set(updates)
      .where(and(eq(smsTemplates.templateId, templateId), eq(smsTemplates.workspaceId, ws)));
    return ok({ message: 'Updated' });
  }

  const updates = { ...common };
  if (has(body, 'ssml_content', 'ssmlContent')) updates.ssmlContent = str(body, 'ssml_content', 'ssmlContent') ?? null;
  if (has(body, 'voicemail_ssml', 'voicemailSsml')) updates.voicemailSsml = str(body, 'voicemail_ssml', 'voicemailSsml') ?? null;
  if (has(body, 'voice_id', 'voiceId')) updates.voiceId = str(body, 'voice_id', 'voiceId');
  if (has(body, 'connect_flow_json', 'connectFlowJson')) updates.connectFlowJson = raw(body, 'connect_flow_json', 'connectFlowJson') ?? null;
  await db.update(callScripts).set(updates)
    .where(and(eq(callScripts.scriptId, templateId), eq(callScripts.workspaceId, ws)));
  return ok({ message: 'Updated' });
}

export async function deleteTemplate(
  ctx: RequestContext,
  type: string,
  templateId: string,
): Promise<ApiResult> {
  const missing = requireWorkspace(ctx);
  if (missing) return missing;
  if (!isTemplateType(type)) return unknownType(type);
  const denied = requireRole(ctx, 'admin');
  if (denied) return denied;

  const db = await getDb();
  const ws = ctx.workspaceId;

  if (type === 'email') {
    await db.delete(emailTemplates).where(and(eq(emailTemplates.templateId, templateId), eq(emailTemplates.workspaceId, ws)));
  } else if (type === 'sms') {
    await db.delete(smsTemplates).where(and(eq(smsTemplates.templateId, templateId), eq(smsTemplates.workspaceId, ws)));
  } else {
    await db.delete(callScripts).where(and(eq(callScripts.scriptId, templateId), eq(callScripts.workspaceId, ws)));
  }
  return noContent();
}
