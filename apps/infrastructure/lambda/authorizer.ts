import { APIGatewayTokenAuthorizerEvent, APIGatewayAuthorizerResult } from 'aws-lambda';
import { CognitoJwtVerifier } from 'aws-jwt-verify';

// 1. Initialize Cognito Verifier
// These environment variables will be injected by the AWS CDK api-stack.ts
const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.USER_POOL_ID || 'us-east-1_xxxxxxxxx',
  tokenUse: 'id',
  clientId: process.env.APP_CLIENT_ID || 'xxxxxxxxxxxxxx',
});

export const handler = async (event: APIGatewayTokenAuthorizerEvent): Promise<APIGatewayAuthorizerResult> => {
  console.log('Authorizer invoked.');
  
  try {
    const authHeader = event.authorizationToken;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new Error('Unauthorized'); 
    }

    const token = authHeader.split(' ')[1];
    
    // 2. Verify the Cognito JWT — this is cryptographic verification, no DB needed
    const payload = await verifier.verify(token!);
    const userId = payload.sub;

    console.log(`User ${userId} authenticated successfully.`);

    // 3. Allow all methods on this API for the authenticated user
    //    Use a wildcard ARN so the cached policy covers all routes
    const arnParts = event.methodArn.split(':');
    const apiGatewayArnParts = arnParts[5]!.split('/');
    const wildcardArn = arnParts.slice(0, 5).join(':') + ':' + apiGatewayArnParts[0] + '/' + apiGatewayArnParts[1] + '/*';

    return generatePolicy(userId!, 'Allow', wildcardArn, {
      'tenant_role': 'admin',
    });

  } catch (error) {
    console.error('Authorization failed:', error);
    // API Gateway requires literally throwing 'Unauthorized' to map to a 401 response
    throw new Error('Unauthorized');
  }
};

const generatePolicy = (
  principalId: string,
  effect: 'Allow' | 'Deny',
  resource: string,
  context?: Record<string, string>
): APIGatewayAuthorizerResult => {
  return {
    principalId,
    policyDocument: {
      Version: '2012-10-17',
      Statement: [
        {
          Action: 'execute-api:Invoke',
          Effect: effect,
          Resource: resource, 
        },
      ],
    },
    context,
  };
};
