// ============================================
// GET    /segments               — list
// POST   /segments               — create (static or dynamic)
// PUT    /segments/{id}          — update
// DELETE /segments/{id}          — delete (admin)
// GET    /segments/{id}/contacts — membership preview
// POST   /segments/{id}/contacts — add (static only)
// DELETE /segments/{id}/contacts — remove (static only)
// POST   /segments/preview-count — live count for unsaved rules
// Thin adapter; the logic lives in @repo/core/api/segments.
// ============================================

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  addSegmentContacts,
  createSegment,
  deleteSegment,
  listSegmentContacts,
  listSegments,
  previewSegmentCount,
  removeSegmentContacts,
  updateSegment,
} from '@repo/core/api/segments';
import { methodNotAllowed } from '@repo/core/api/result';
import { adapt, bodyOf, queryOf } from '../lib/adapt';

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> =>
  adapt(event, async (ctx) => {
    const method = event.httpMethod;
    const pathId = event.pathParameters?.id;
    const onContacts = event.path?.endsWith('/contacts');

    if (method === 'GET' && !pathId) return listSegments(ctx);
    if (method === 'GET' && pathId && onContacts) {
      const params = queryOf(event);
      return listSegmentContacts(ctx, pathId, { pageSize: params.pageSize, cursor: params.cursor });
    }
    if (method === 'POST' && event.path?.endsWith('/preview-count')) {
      return previewSegmentCount(ctx, bodyOf(event));
    }
    if (method === 'POST' && pathId && onContacts) return addSegmentContacts(ctx, pathId, bodyOf(event));
    if (method === 'POST') return createSegment(ctx, bodyOf(event));
    if (method === 'PUT' && pathId) return updateSegment(ctx, pathId, bodyOf(event));
    if (method === 'DELETE' && pathId && onContacts) return removeSegmentContacts(ctx, pathId, bodyOf(event));
    if (method === 'DELETE' && pathId) return deleteSegment(ctx, pathId);
    return methodNotAllowed();
  });
