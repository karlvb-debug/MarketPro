// ============================================
// AWS adapter for the shared DB/auth surface.
//
// The connection pool and the role hierarchy live in @repo/core; what remains
// here is the API Gateway shaping — reading identity off the authorizer
// context and formatting Lambda proxy responses. M3 replaces this file with
// Next route-handler equivalents; nothing below is portable.
// ============================================

import { roleMeetsMin, type Role } from '@repo/core/db';

export { getPool, getDb, closePool, methodToAction } from '@repo/core/db';
export type { Role } from '@repo/core/db';

/**
 * Standard API Gateway response helper
 */
export function respond(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Workspace-Id',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    },
    body: JSON.stringify(body),
  };
}

/**
 * Extract workspace ID from the authorizer context or headers
 */
export function getWorkspaceId(event: any): string | null {
  // From custom header (passed through by API Gateway)
  return event.headers?.['X-Workspace-Id']
    || event.headers?.['x-workspace-id']
    || null;
}

/**
 * Extract user ID from the authorizer context
 */
export function getUserId(event: any): string | null {
  return event.requestContext?.authorizer?.principalId || null;
}

/**
 * Extract the tenant role from the authorizer context.
 * Returns the role string injected by the authorizer Lambda.
 */
export function getTenantRole(event: any): string {
  return event.requestContext?.authorizer?.tenant_role || 'none';
}

/**
 * Check if the caller is a Super Admin (global platform access).
 */
export function isSuperAdmin(event: any): boolean {
  return getTenantRole(event) === 'super_admin';
}

/**
 * Check if the caller's role meets the minimum required role.
 * Returns true if authorized, false if denied.
 *
 * Hierarchy: viewer < editor < admin < owner < super_admin
 */
export function hasMinRole(event: any, minRole: Role): boolean {
  return roleMeetsMin(getTenantRole(event), minRole);
}

/**
 * Guard that returns a 403 response if the caller lacks the minimum role.
 * Usage: const denied = requireRole(event, 'editor'); if (denied) return denied;
 */
export function requireRole(event: any, minRole: Role) {
  if (!hasMinRole(event, minRole)) {
    return respond(403, {
      message: `Forbidden: requires '${minRole}' role or higher`,
      yourRole: getTenantRole(event),
    });
  }
  return null; // Authorized
}
