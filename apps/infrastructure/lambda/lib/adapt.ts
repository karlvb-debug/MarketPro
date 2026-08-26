// ============================================
// API Gateway → @repo/core adapter.
//
// The handler logic lives in @repo/core/api; these helpers translate between
// a Lambda proxy event and the transport-neutral RequestContext/ApiResult that
// the core functions speak. M7 deletes this file along with the rest of the
// AWS layer.
// ============================================

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import type { RequestContext } from '@repo/core/api/context';
import type { ApiResult } from '@repo/core/api/result';
import type { RequestMeta } from '@repo/core/api/contacts';
import { parseBody, type JsonBody } from '@repo/core/api/input';
import { getWorkspaceId, getUserId, getTenantRole, isSuperAdmin, respond } from './db';

const GLOBAL_WORKSPACE_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Build the request context from the authorizer's output. The authorizer has
 * already verified the JWT and resolved the caller's role, so unlike the Next
 * adapter this does no database work — it just reshapes what API Gateway
 * handed us.
 */
export function contextFromEvent(event: APIGatewayProxyEvent): RequestContext | null {
  const userId = getUserId(event);
  if (!userId) return null;

  const requested = getWorkspaceId(event);
  const workspaceId = !requested || requested === GLOBAL_WORKSPACE_ID ? '' : requested;

  return {
    userId,
    workspaceId,
    role: getTenantRole(event),
    isSuperAdmin: isSuperAdmin(event),
  };
}

/** Render an ApiResult as a Lambda proxy response. */
export function toProxyResult(result: ApiResult): APIGatewayProxyResult {
  return respond(result.status, result.body ?? null);
}

/** Parse the event body the way every handler used to inline. */
export function bodyOf(event: APIGatewayProxyEvent): JsonBody {
  return parseBody(event.body);
}

/** Query-string params, never null. */
export function queryOf(event: APIGatewayProxyEvent): Record<string, string | undefined> {
  return event.queryStringParameters || {};
}

/** Audit metadata for super-admin impersonation logging. */
export function metaOf(event: APIGatewayProxyEvent): RequestMeta {
  return {
    ip: event.requestContext?.identity?.sourceIp || null,
    userAgent: event.headers?.['User-Agent'] || event.headers?.['user-agent'] || null,
    path: event.path || '',
  };
}

/**
 * Wrap a handler body: 401 without an identity, 500 on anything unhandled.
 * Mirrors the try/catch every Lambda handler carried.
 */
export async function adapt(
  event: APIGatewayProxyEvent,
  handler: (ctx: RequestContext) => Promise<ApiResult>,
): Promise<APIGatewayProxyResult> {
  const ctx = contextFromEvent(event);
  if (!ctx) return respond(401, { message: 'Unauthorized' });

  try {
    return toProxyResult(await handler(ctx));
  } catch (err) {
    console.error('Unhandled handler error:', err);
    return respond(500, { message: 'Internal server error' });
  }
}
