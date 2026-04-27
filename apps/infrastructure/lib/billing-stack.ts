import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as path from 'path';

export interface BillingStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  lambdaSecurityGroup: ec2.SecurityGroup;
  database: rds.DatabaseInstance;
  dbSecret: secretsmanager.ISecret;
  idempotencyTable: dynamodb.TableV2;
}

export class BillingStack extends cdk.Stack {
  public readonly canonicalEventBus: sns.Topic;
  public readonly billingQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props: BillingStackProps) {
    super(scope, id, props);

    // 1. The Canonical Event Bus (SNS)
    // All events (SES deliver, SMS reply, Connect trace) hit here.
    this.canonicalEventBus = new sns.Topic(this, 'CanonicalEventBus', {
      topicName: 'marketing-saas-canonical-events',
      displayName: 'Canonical Router for all outbound events',
    });

    // 2. The Billing SQS Dead Letter Queue (DLQ)
    // Using Standard (not FIFO) because Standard SNS Topics cannot subscribe to FIFO queues.
    // Deduplication is handled by the DynamoDB idempotency store in the billing Lambda.
    const billingDlq = new sqs.Queue(this, 'BillingDLQ', {
      queueName: 'marketing-saas-billing-dlq',
      retentionPeriod: cdk.Duration.days(14),
    });

    // 3. The Billing SQS Queue (Standard — idempotency store handles dedup)
    this.billingQueue = new sqs.Queue(this, 'BillingQueue', {
      queueName: 'marketing-saas-billing-queue',
      visibilityTimeout: cdk.Duration.seconds(30),
      deadLetterQueue: {
        queue: billingDlq,
        maxReceiveCount: 5, // Retry 5 times before moving to DLQ
      },
    });

    // 4. Connect SNS Topic to SQS Queue
    this.canonicalEventBus.addSubscription(new snsSubscriptions.SqsSubscription(this.billingQueue, {
      rawMessageDelivery: true,
    }));

    // 5. Deploy Idempotent Billing Capture Lambda
    const billingCaptureLambda = new lambdaNodejs.NodejsFunction(this, 'IdempotentBillingCaptureFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../lambda/idempotent-billing-capture.ts'),
      handler: 'handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(20),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.lambdaSecurityGroup],
      environment: {
        IDEMPOTENCY_TABLE: props.idempotencyTable.tableName,
        DATABASE_URL: `postgresql://${props.database.instanceEndpoint.hostname}:5432/marketingsaas`,
      },
    });

    // Grant Lambda access to DynamoDB idempotency table and RDS Proxy
    props.idempotencyTable.grantReadWriteData(billingCaptureLambda);
    props.dbSecret.grantRead(billingCaptureLambda);


    // Attach SQS as Event Source to Lambda
    billingCaptureLambda.addEventSource(new lambdaEventSources.SqsEventSource(this.billingQueue, {
      batchSize: 10,
    }));

    // 6. Deploy Stripe Webhook Lambda
    const stripeWebhookLambda = new lambdaNodejs.NodejsFunction(this, 'StripeWebhookFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../lambda/stripe-webhook.ts'),
      handler: 'handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.lambdaSecurityGroup],
      environment: {
        // Stripe secrets are read at runtime from Secrets Manager, not plaintext env vars.
        // The Lambda reads these ARNs and fetches the actual secrets securely.
        STRIPE_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:ACCOUNT:secret:marketing-saas/stripe-secret',
        STRIPE_WEBHOOK_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:ACCOUNT:secret:marketing-saas/stripe-webhook-secret',
        DATABASE_URL: `postgresql://${props.database.instanceEndpoint.hostname}:5432/marketingsaas`,
      },
    });

    // Grant Stripe Lambda access to RDS
    props.dbSecret.grantRead(stripeWebhookLambda);


    // 7. Mini API Gateway for Webhooks (Or link to the central ApiStack)
    const webhookApi = new apigateway.RestApi(this, 'MarketingSaaSWebhookApi', {
      restApiName: 'Marketing SaaS Webhook API',
    });

    const stripeResource = webhookApi.root.addResource('stripe-webhook');
    stripeResource.addMethod('POST', new apigateway.LambdaIntegration(stripeWebhookLambda));

    // Outputs
    new cdk.CfnOutput(this, 'StripeWebhookUrl', {
      value: webhookApi.url + 'stripe-webhook',
    });
  }
}
