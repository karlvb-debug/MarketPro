// ============================================
// Identity verification for API routes.
//
// The only vendor-specific step: turn whatever credential the request carries
// into a VerifiedIdentity. Role resolution and workspace scoping happen in
// @repo/core and are provider-independent.
// ============================================

import { createClient } from '@supabase/supabase-js';
import type { VerifiedIdentity } from '@repo/core/api/context';

/**
 * Claim that marks a user as a platform super admin. Set it in Supabase as an
 * app_metadata field so users cannot grant it to themselves (user_metadata is
 * self-writable; app_metadata is not).
 */
const SUPER_ADMIN_CLAIM = 'is_super_admin';

export interface AuthProvider {
  /** Returns the caller's identity, or null when the credential is absent/invalid. */
  verify(req: Request): Promise<VerifiedIdentity | null>;
}

function bearerToken(req: Request): string | null {
  const header = req.headers.get('authorization') ?? req.headers.get('Authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Verifies a Supabase Auth access token. Requires NEXT_PUBLIC_SUPABASE_URL and
 * SUPABASE_SERVICE_ROLE_KEY; the service role key is server-only and must
 * never be exposed to the browser.
 */
export function supabaseAuth(): AuthProvider {
  return {
    async verify(req) {
      const token = bearerToken(req);
      if (!token) return null;

      const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!url || !serviceKey) {
        throw new Error('Supabase auth is not configured (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
      }

      const client = createClient(url, serviceKey, { auth: { persistSession: false } });
      const { data, error } = await client.auth.getUser(token);
      if (error || !data.user) return null;

      const appMeta = (data.user.app_metadata ?? {}) as Record<string, unknown>;
      return {
        userId: data.user.id,
        isSuperAdmin: appMeta[SUPER_ADMIN_CLAIM] === true,
      };
    },
  };
}

/** The provider used by route handlers. Swap here, not at each call site. */
export const authProvider: AuthProvider = supabaseAuth();
