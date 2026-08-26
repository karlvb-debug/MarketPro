// ============================================
// GET    /custom-fields      — list (viewer+)
// POST   /custom-fields      — create (admin+)
// PUT    /custom-fields/{id} — update (admin+)
// DELETE /custom-fields/{id} — archive (admin+; never destructive)
// Thin adapter; the logic lives in @repo/core/api/custom-fields.
// ============================================

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  archiveCustomField,
  createCustomField,
  listCustomFields,
  updateCustomField,
} from '@repo/core/api/custom-fields';
import { methodNotAllowed } from '@repo/core/api/result';
import { adapt, bodyOf } from '../lib/adapt';

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> =>
  adapt(event, async (ctx) => {
    const pathId = event.pathParameters?.id;

    if (event.httpMethod === 'GET') return listCustomFields(ctx);
    if (event.httpMethod === 'POST' && !pathId) return createCustomField(ctx, bodyOf(event));
    if (event.httpMethod === 'PUT' && pathId) return updateCustomField(ctx, pathId, bodyOf(event));
    if (event.httpMethod === 'DELETE' && pathId) return archiveCustomField(ctx, pathId);
    return methodNotAllowed();
  });
