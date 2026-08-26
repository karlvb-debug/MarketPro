// Migration 0007 — deny-all RLS gate for PostgREST-exposed schemas.
//
// Supabase publishes the `public` schema over PostgREST, and the publishable
// (anon) key is public by design — it ships in the browser bundle. On RDS the
// database sat in a VPC and the API was the only route to it, so app-level
// workspace scoping was sufficient; on Supabase it is not, because PostgREST
// is a second, unguarded route to the same tables.
//
// This enables RLS with NO policies, so `anon` and `authenticated` can reach
// nothing over REST. It is deliberately NOT the tenant-isolation mechanism:
// `service_role` holds BYPASSRLS, so the API route handlers keep running the
// same workspace-scoped queries the integration suite already covers. The
// decision in docs/plans/aws-exit.md section 3 — do not port tenant isolation
// to RLS in v1 — therefore still stands; this only closes the public door.
//
// Idempotent: ENABLE ROW LEVEL SECURITY on an already-enabled table is a no-op.

export const id = '0007-enable-rls';

export const sql = `
DO $rls$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END
$rls$;
`;
