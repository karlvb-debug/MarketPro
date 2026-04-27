import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cognito from 'aws-cdk-lib/aws-cognito';

export class AuthStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create the Cognito User Pool
    this.userPool = new cognito.UserPool(this, 'MarketingSaaSUserPool', {
      userPoolName: 'marketing-saas-users',
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // For dev purposes only
    });

    // Create the User Pool Client for the Next.js Frontend
    this.userPoolClient = new cognito.UserPoolClient(this, 'MarketingSaaSWebClient', {
      userPool: this.userPool,
      generateSecret: false, // Must be false for web clients
      authFlows: {
        userSrp: true,
      },
    });

    // Create Super Admin Group
    new cognito.CfnUserPoolGroup(this, 'SuperAdminGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'SuperAdmins',
      description: 'Internal employees with global platform access.',
    });

    // Outputs for the frontend
    new cdk.CfnOutput(this, 'UserPoolId', {
      value: this.userPool.userPoolId,
      exportName: 'MarketingSaaSUserPoolId',
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: this.userPoolClient.userPoolClientId,
      exportName: 'MarketingSaaSUserPoolClientId',
    });
  }
}
