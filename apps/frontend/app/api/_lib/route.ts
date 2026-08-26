// ============================================
// Route-handler plumbing.
//
// Turns a Next Request into a @repo/core RequestContext, invokes the
// transport-neutral handler, and renders its ApiResult as a Response. All the
// interesting logic lives in @repo/core/api/*; this file is the adapter, the
// direct counterpart of the old API Gateway proxy shim.
// ============================================

import { resolveRequestContext, type RequestContext } from '@repo/core/api/context';
import type { ApiResult } from '@repo/core/api/result';
import { parseBody, type JsonBody } from '@repo/core/api/input';
import { authProvider } from './auth';

/** Render an ApiResult as an HTTP response. */
export function toResponse(result: ApiResult): Response {
  if (result.status === 204 || result.body === undefined) {
    return new Response(null, { status: result.status });
  }
  return Response.json(result.body, { status: result.status });
}

/**
 * Read and parse a JSON body. Never throws — a malformed body reads as `{}`,
 * matching how the Lambda handlers treated `JSON.parse(event.body || '{}')`.
 */
export async function readBody(req: Request): Promise<JsonBody> {
  try {
    return parseBody(await req.text());
  } catch {
    return {};
  }
}

/**
 * Authenticate, resolve the workspace role, and hand a RequestContext to the
 * handler. 401 when the credential is missing/invalid, 403 when the caller has
 * no role in the requested workspace.
 */
export async function withContext(
  req: Request,
  handler: (ctx: RequestContext) => Promise<ApiResult>,
): Promise<Response> {
  let identity;
  try {
    identity = await authProvider.verify(req);
  } catch (err) {
    console.error('Auth provider error:', err);
    return toResponse({ status: 500, body: { message: 'Internal server error' } });
  }

  if (!identity) {
    return toResponse({ status: 401, body: { message: 'Unauthorized' } });
  }

  const requestedWorkspace =
    req.headers.get('x-workspace-id') ?? req.headers.get('X-Workspace-Id');

  const ctx = await resolveRequestContext(identity, requestedWorkspace);
  if (!ctx) {
    return toResponse({ status: 403, body: { message: 'Access denied to this workspace.' } });
  }

  try {
    return toResponse(await handler(ctx));
  } catch (err) {
    // Never leak internals to the client; the server log keeps the detail.
    console.error('Unhandled route error:', err);
    return toResponse({ status: 500, body: { message: 'Internal server error' } });
  }
}

/** Next passes dynamic route params as a Promise. */
export type RouteParams<T> = { params: Promise<T> };
