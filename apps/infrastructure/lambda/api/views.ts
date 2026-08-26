// ============================================
// GET    /views      — own + shared views
// POST   /views      — create
// PUT    /views/{id} — update (owner, or admin for shared)
// DELETE /views/{id} — delete (owner, or admin)
// Thin adapter; the logic lives in @repo/core/api/views.
// ============================================

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { createView, deleteView, listViews, updateView } from '@repo/core/api/views';
import { methodNotAllowed } from '@repo/core/api/result';
import { adapt, bodyOf } from '../lib/adapt';

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> =>
  adapt(event, async (ctx) => {
    const pathId = event.pathParameters?.id;

    if (event.httpMethod === 'GET') return listViews(ctx);
    if (event.httpMethod === 'POST' && !pathId) return createView(ctx, bodyOf(event));
    if (event.httpMethod === 'PUT' && pathId) return updateView(ctx, pathId, bodyOf(event));
    if (event.httpMethod === 'DELETE' && pathId) return deleteView(ctx, pathId);
    return methodNotAllowed();
  });
