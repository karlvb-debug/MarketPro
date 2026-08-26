// ============================================
// Environment Configuration
// ============================================

export const config = {
  /**
   * Base path for API calls. The API now ships with the frontend as Next route
   * handlers, so the default is same-origin and relative. NEXT_PUBLIC_API_URL
   * remains an override for pointing a deployment at an external API during
   * the migration.
   */
  apiUrl: process.env.NEXT_PUBLIC_API_URL || '/api',

  /** Supabase project URL (auth). */
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL || '',

  /** Supabase publishable (anon) key — safe for the browser. */
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '',

  /** Cognito User Pool ID (legacy auth — replaced by Supabase, see M3). */
  cognitoUserPoolId: process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID || '',

  /** Cognito App Client ID (legacy auth). */
  cognitoClientId: process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID || '',

  /** Cognito Region (legacy auth). */
  cognitoRegion: process.env.NEXT_PUBLIC_COGNITO_REGION || 'us-east-1',

  /**
   * Whether a real backend is available. The API itself is always present now
   * (it is same-origin), so this turns on whether an auth provider is
   * configured — without one there is no session to authorize calls with, and
   * the UI stays in local/offline mode.
   */
  get isAuthConfigured(): boolean {
    return Boolean(
      (this.supabaseUrl && this.supabaseAnonKey) ||
      (this.cognitoUserPoolId && this.cognitoClientId),
    );
  },

  /** @deprecated Use isAuthConfigured — kept so call sites migrate in one step. */
  get isApiConfigured(): boolean {
    return this.isAuthConfigured;
  },
};
