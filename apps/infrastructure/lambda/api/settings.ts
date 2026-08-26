// ============================================
// GET /settings — workspace settings
// PUT /settings — upsert (admin)
// Thin adapter; the logic lives in @repo/core/api/settings.
// ============================================

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getSettings, updateSettings } from '@repo/core/api/settings';
import { methodNotAllowed } from '@repo/core/api/result';
import { adapt, bodyOf } from '../lib/adapt';

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> =>
  adapt(event, async (ctx) => {
    switch (event.httpMethod) {
      case 'GET': return getSettings(ctx);
      case 'PUT': return updateSettings(ctx, bodyOf(event));
      default: return methodNotAllowed();
    }
  });
