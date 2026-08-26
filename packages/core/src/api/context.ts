// ============================================
// Request context — who is calling, and in which workspace.
//
// This is what the old API Gateway authorizer injected into the Lambda event
// context, expressed as a plain value. Producing it is the vendor-specific
// part (Cognito yesterday, Supabase Auth tomorrow); *resolving the role* from
// it is ordinary DB work and lives here.
// ============================================

import { getPool } from '../db';

/** The sentinel workspace id the client sends when it has no active workspace. */
export const GLOBAL_WORKSPACE_ID = '00000000-0000-0000-0000-000000000000';

export interface RequestContext {
  userId: string;
  /** Empty string in global context (e.g. listing the user's workspaces). */
  workspaceId: string;
  /** 'super_admin' | 'owner' | 'admin' | 'editor' | 'viewer' | 'none' */
  role: string;
  isSuperAdmin: boolean;
}

/**
 * The identity an auth provider hands us after verifying its own token.
 * Deliberately minimal so any provider can produce it.
 */
export interface VerifiedIdentity {
  userId: string;
  isSuperAdmin: boolean;
}

/**
 * Resolve the caller's role in a workspace from users_workspaces.
 * Returns null when the user has no membership (deny).
 */
export async function resolveWorkspaceRole(
  userId: string,
  workspaceId: string,
): Promise<string | null> {
  const pool = await getPool();
  try {
    const result = await pool.query(
      'SELECT role FROM users_workspaces WHERE user_id = $1 AND workspace_id = $2 LIMIT 1',
      [userId, workspaceId],
    );
    return result.rows.length > 0 ? result.rows[0].role : null;
  } catch {
    // Graceful deny on malformed UUIDs etc. — never leak the DB error.
    return null;
  }
}

/**
 * Build the request context for a verified identity against a requested
 * workspace. Returns null when the caller has no access (the transport should
 * answer 403).
 *
 * Mirrors the old authorizer exactly:
 * - no/global workspace  → allowed, role 'super_admin' or 'none', empty id
 * - super admin          → allowed in any workspace (impersonation)
 * - otherwise            → role must exist in users_workspaces
 */
export async function resolveRequestContext(
  identity: VerifiedIdentity,
  requestedWorkspaceId: string | null | undefined,
): Promise<RequestContext | null> {
  const { userId, isSuperAdmin } = identity;

  if (!requestedWorkspaceId || requestedWorkspaceId === GLOBAL_WORKSPACE_ID) {
    return {
      userId,
      workspaceId: '',
      role: isSuperAdmin ? 'super_admin' : 'none',
      isSuperAdmin,
    };
  }

  if (isSuperAdmin) {
    return { userId, workspaceId: requestedWorkspaceId, role: 'super_admin', isSuperAdmin: true };
  }

  const role = await resolveWorkspaceRole(userId, requestedWorkspaceId);
  if (!role) return null;

  return { userId, workspaceId: requestedWorkspaceId, role, isSuperAdmin: false };
}
