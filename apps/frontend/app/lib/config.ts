// ============================================
// Environment Configuration
// Values populated from CDK stack outputs
// ============================================

export const config = {
  /** API Gateway base URL (e.g. https://xxxxx.execute-api.us-east-1.amazonaws.com/prod) */
  apiUrl: process.env.NEXT_PUBLIC_API_URL || '',

  /** Cognito User Pool ID */
  cognitoUserPoolId: process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID || '',

  /** Cognito App Client ID */
  cognitoClientId: process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID || '',

  /** Cognito Region */
  cognitoRegion: process.env.NEXT_PUBLIC_COGNITO_REGION || 'us-east-1',

  /** Whether the API is configured and available */
  get isApiConfigured(): boolean {
    return Boolean(this.apiUrl && this.cognitoUserPoolId && this.cognitoClientId);
  },
};
