// ============================================
// GET    /workspaces      — list the caller's workspaces
// POST   /workspaces      — create
// PUT    /workspaces/{id} — rename (admin)
// DELETE /workspaces/{id} — delete (owner)
// Thin adapter; the logic lives in @repo/core/api/workspaces.
// ============================================

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  createWorkspace,
  deleteWorkspace,
  listWorkspaces,
  renameWorkspace,
} from '@repo/core/api/workspaces';
import { methodNotAllowed } from '@repo/core/api/result';
import { adapt, bodyOf } from '../lib/adapt';

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> =>
  adapt(event, async (ctx) => {
    const pathId = event.pathParameters?.id;

    if (event.httpMethod === 'GET' && !pathId) return listWorkspaces(ctx);
    if (event.httpMethod === 'POST') return createWorkspace(ctx, bodyOf(event));
    if (event.httpMethod === 'PUT' && pathId) return renameWorkspace(ctx, pathId, bodyOf(event));
    if (event.httpMethod === 'DELETE' && pathId) return deleteWorkspace(ctx, pathId);
    return methodNotAllowed();
  });
