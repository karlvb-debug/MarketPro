// ============================================
// GET    /templates/{type}      — list
// GET    /templates/{type}/{id} — read
// POST   /templates/{type}      — create (editor)
// PUT    /templates/{type}/{id} — update (editor)
// DELETE /templates/{type}/{id} — delete (admin)
// Thin adapter; the logic lives in @repo/core/api/templates.
// ============================================

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  createTemplate,
  deleteTemplate,
  getTemplate,
  listTemplates,
  updateTemplate,
} from '@repo/core/api/templates';
import { methodNotAllowed } from '@repo/core/api/result';
import { adapt, bodyOf } from '../lib/adapt';

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> =>
  adapt(event, async (ctx) => {
    // Path is /templates/{type} or /templates/{type}/{id}, with an optional
    // stage prefix depending on the API Gateway config.
    const pathParts = (event.path || '').split('/').filter(Boolean);
    const typeIdx = pathParts.indexOf('templates') + 1;
    const type = pathParts[typeIdx] || event.pathParameters?.type || '';
    const templateId = event.pathParameters?.id || pathParts[typeIdx + 1] || null;

    if (event.httpMethod === 'GET' && !templateId) return listTemplates(ctx, type);
    if (event.httpMethod === 'GET' && templateId) return getTemplate(ctx, type, templateId);
    if (event.httpMethod === 'POST') return createTemplate(ctx, type, bodyOf(event));
    if (event.httpMethod === 'PUT' && templateId) return updateTemplate(ctx, type, templateId, bodyOf(event));
    if (event.httpMethod === 'DELETE' && templateId) return deleteTemplate(ctx, type, templateId);
    return methodNotAllowed();
  });
