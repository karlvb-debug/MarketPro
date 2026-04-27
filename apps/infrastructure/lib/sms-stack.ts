import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as pinpoint from 'aws-cdk-lib/aws-pinpoint';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as path from 'path';

export class SmsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 1. Core AWS End User Messaging Application (Pinpoint)
    // Used to logically group numbers, opt-out lists, and usage limits.
    const messagingApp = new pinpoint.CfnApp(this, 'MarketingSaaSSmsApp', {
      name: 'marketing-saas-core-sms',
    });

    // 2. Enable SMS channel for the app
    new pinpoint.CfnSMSChannel(this, 'MarketingSaaSSmsChannel', {
      applicationId: messagingApp.ref,
      enabled: true,
      // For two-way messaging, inbound events would pipe to the Canonical Event Bus (SNS)
    });

    // 3. Deploy the Timezone Resolution Engine (Waterfall lookup)
    const timezoneEngineLambda = new lambdaNodejs.NodejsFunction(this, 'TimezoneResolutionFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../lambda/timezone-resolution.ts'),
      handler: 'handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(10), // HLR Lookups can take a few seconds
      environment: {
        // e.g., TELESIGN_API_KEY: process.env.TELESIGN_API_KEY ...
      }
    });

    // 4. Dedicated SNS Topic for Inbound Two-Way messages
    // (This feeds back into your SQS pipeline and revokes consent on STOP)
    const inboundSmsTopic = new sns.Topic(this, 'InboundSmsTopic', {
        topicName: 'marketing-saas-inbound-sms',
    });

    // Outputs
    new cdk.CfnOutput(this, 'MessagingAppId', {
      value: messagingApp.ref,
    });
  }
}
