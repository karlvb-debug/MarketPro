#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AuthStack } from '../lib/auth-stack';
import { DatabaseStack } from '../lib/database-stack';
import { ApiStack } from '../lib/api-stack';
import { BillingStack } from '../lib/billing-stack';
import { ContactIngestionStack } from '../lib/contact-ingestion-stack';
import { EmailStack } from '../lib/email-stack';
import { SmsStack } from '../lib/sms-stack';
import { VoiceStack } from '../lib/voice-stack';
import { AnalyticsStack } from '../lib/analytics-stack';

const app = new cdk.App();

// Define a common environment if necessary
const env = { 
  account: process.env.CDK_DEFAULT_ACCOUNT, 
  region: process.env.CDK_DEFAULT_REGION || 'us-east-1' 
};

// 1. Provision the Database Stack (RDS, RDS Proxy, DynamoDB, VPC)
const databaseStack = new DatabaseStack(app, 'MarketingSaaSDatabaseStack', { env });

// 2. Provision the Auth Stack (Cognito User & Identity Pools)
const authStack = new AuthStack(app, 'MarketingSaaSAuthStack', { env });

// 3. Provision the Email Stack (SES Identities & IP Pools + Dispatch Engine)
const emailStack = new EmailStack(app, 'MarketingSaaSEmailStack', {
  env,
  vpc: databaseStack.vpc,
  lambdaSecurityGroup: databaseStack.lambdaSecurityGroup,
  database: databaseStack.database,
  dbSecret: databaseStack.dbSecret,
});
emailStack.addDependency(databaseStack);

// 4. Provision the SMS Stack (AWS End User Messaging, TCPA Compliance)
const smsStack = new SmsStack(app, 'MarketingSaaSSmsStack', {
  env,
  vpc: databaseStack.vpc,
  lambdaSecurityGroup: databaseStack.lambdaSecurityGroup,
  database: databaseStack.database,
  dbSecret: databaseStack.dbSecret,
});
smsStack.addDependency(databaseStack);

// 5. Provision the Voice Stack (Amazon Connect Pooled Dialer, AMD flows)
const voiceStack = new VoiceStack(app, 'MarketingSaaSVoiceStack', {
  env,
  vpc: databaseStack.vpc,
  lambdaSecurityGroup: databaseStack.lambdaSecurityGroup,
  database: databaseStack.database,
  dbSecret: databaseStack.dbSecret,
});
voiceStack.addDependency(databaseStack);

// 6. Provision the Contact Ingestion Stack (S3, Step Functions)
const contactIngestionStack = new ContactIngestionStack(app, 'MarketingSaaSContactIngestionStack', {
  env,
  vpc: databaseStack.vpc,
  lambdaSecurityGroup: databaseStack.lambdaSecurityGroup,
  database: databaseStack.database,
  dbSecret: databaseStack.dbSecret,
});

contactIngestionStack.addDependency(databaseStack);

// 7. Provision the API Stack (API Gateway, Authorizers)
// Now receives all cross-stack dependencies it needs to function
const apiStack = new ApiStack(app, 'MarketingSaaSApiStack', {
  env,
  vpc: databaseStack.vpc,
  lambdaSecurityGroup: databaseStack.lambdaSecurityGroup,
  database: databaseStack.database,
  dbSecret: databaseStack.dbSecret,
  userPool: authStack.userPool,
  userPoolClient: authStack.userPoolClient,
  emailDispatchQueue: emailStack.emailDispatchQueue,
  smsDispatchQueue: smsStack.smsDispatchQueue,
  voiceDispatchQueue: voiceStack.voiceDispatchQueue,
  uploadBucket: contactIngestionStack.uploadBucket,
  // frontendUrl: 'https://app.yourdomain.com', // Set this for production
});

apiStack.addDependency(authStack);
apiStack.addDependency(databaseStack);
apiStack.addDependency(emailStack);
apiStack.addDependency(smsStack);
apiStack.addDependency(voiceStack);
apiStack.addDependency(contactIngestionStack);

// 8. Provision the Billing Stack (SNS Canonical, SQS, Stripe Webhooks, Idempotency)
const billingStack = new BillingStack(app, 'MarketingSaaSBillingStack', {
  env,
  vpc: databaseStack.vpc,
  lambdaSecurityGroup: databaseStack.lambdaSecurityGroup,
  database: databaseStack.database,
  dbSecret: databaseStack.dbSecret,
  idempotencyTable: databaseStack.idempotencyTable,
});

billingStack.addDependency(databaseStack);

// 9. Provision the Analytics Stack (Athena Data Lake & Right to be Forgotten)
const analyticsStack = new AnalyticsStack(app, 'MarketingSaaSAnalyticsStack', {
  env,
  vpc: databaseStack.vpc,
  lambdaSecurityGroup: databaseStack.lambdaSecurityGroup,
  database: databaseStack.database,
  dbSecret: databaseStack.dbSecret,
});

analyticsStack.addDependency(databaseStack);

