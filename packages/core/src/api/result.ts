// ============================================
// Transport-neutral HTTP result.
//
// Handler logic returns an ApiResult; the caller (a Next route handler, a
// Lambda proxy shim) is responsible for turning it into that transport's
// response type. Nothing here knows about API Gateway or Next.
// ============================================

import { roleMeetsMin, type Role } from '../db';
import type { RequestContext } from './context';

export interface ApiResult {
  status: number;
  /** Undefined means "no content" — adapters should emit an empty body. */
  body?: unknown;
}

export const ok = (body: unknown): ApiResult => ({ status: 200, body });
export const created = (body: unknown): ApiResult => ({ status: 201, body });
export const accepted = (body: unknown): ApiResult => ({ status: 202, body });
export const noContent = (): ApiResult => ({ status: 204 });

export const badRequest = (message: string, extra?: Record<string, unknown>): ApiResult =>
  ({ status: 400, body: { message, ...extra } });
export const unauthorized = (message = 'Unauthorized'): ApiResult =>
  ({ status: 401, body: { message } });
export const paymentRequired = (message: string, extra?: Record<string, unknown>): ApiResult =>
  ({ status: 402, body: { message, ...extra } });
export const forbidden = (message: string, extra?: Record<string, unknown>): ApiResult =>
  ({ status: 403, body: { message, ...extra } });
export const notFound = (message = 'Not found'): ApiResult =>
  ({ status: 404, body: { message } });
export const methodNotAllowed = (): ApiResult =>
  ({ status: 405, body: { message: 'Method not allowed' } });
export const conflict = (message: string, extra?: Record<string, unknown>): ApiResult =>
  ({ status: 409, body: { message, ...extra } });
export const serverError = (message = 'Internal server error'): ApiResult =>
  ({ status: 500, body: { message } });

/**
 * Role guard. Returns a 403 ApiResult if the caller is below `minRole`,
 * or null when authorized.
 *
 * Usage: const denied = requireRole(ctx, 'editor'); if (denied) return denied;
 */
export function requireRole(ctx: RequestContext, minRole: Role): ApiResult | null {
  if (!roleMeetsMin(ctx.role, minRole)) {
    return forbidden(`Forbidden: requires '${minRole}' role or higher`, { yourRole: ctx.role });
  }
  return null;
}

/**
 * Workspace guard. Handlers that operate inside a workspace need a concrete
 * id; global context (`''`) is a client error, matching the old
 * "Missing X-Workspace-Id header" 400.
 */
export function requireWorkspace(ctx: RequestContext): ApiResult | null {
  if (!ctx.workspaceId) return badRequest('Missing workspace');
  return null;
}
