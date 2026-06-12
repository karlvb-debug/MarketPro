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
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as path from 'path';
import { addDispatchAlarms } from './monitoring';

export interface BillingStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  lambdaSecurityGroup: ec2.SecurityGroup;
  database: rds.DatabaseInstance;
  dbSecret: secretsmanager.ISecret;
  idempotencyTable: dynamodb.TableV2;
  opsAlertsTopic: sns.ITopic;
  /** Deployment stage: 'dev' (default) | 'staging' | 'prod'. */
  stage?: string;
}

export class BillingStack extends cdk.Stack {
  public readonly canonicalEventBus: sns.Topic;
  public readonly billingQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props: BillingStackProps) {
    super(scope, id, props);

    const stage = props.stage ?? 'dev';
    // 'dev' keeps legacy physical names; other stages suffix to coexist.
    const named = (base: string) => (stage === 'dev' ? base : `${base}-${stage}`);

    // 1. The Canonical Event Bus (SNS)
    // All events (SES deliver, SMS reply, Connect trace) hit here.
    this.canonicalEventBus = new sns.Topic(this, 'CanonicalEventBus', {
      topicName: named('marketing-saas-canonical-events'),
      displayName: 'Canonical Router for all outbound events',
    });

    // 2. The Billing SQS Dead Letter Queue (DLQ)
    // Using Standard (not FIFO) because Standard SNS Topics cannot subscribe to FIFO queues.
    // Deduplication is handled by the DynamoDB idempotency store in the billing Lambda.
    const billingDlq = new sqs.Queue(this, 'BillingDLQ', {
      queueName: named('marketing-saas-billing-dlq'),
      retentionPeriod: cdk.Duration.days(14),
    });

    // 3. The Billing SQS Queue (Standard — idempotency store handles dedup)
    this.billingQueue = new sqs.Queue(this, 'BillingQueue', {
      queueName: named('marketing-saas-billing-queue'),
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
        DATABASE_SECRET_ARN: props.dbSecret.secretArn,
        DATABASE_HOST: props.database.instanceEndpoint.hostname,
      },
    });

    // Grant Lambda access to DynamoDB idempotency table and RDS Proxy
    props.idempotencyTable.grantReadWriteData(billingCaptureLambda);
    props.dbSecret.grantRead(billingCaptureLambda);


    // Attach SQS as Event Source to Lambda — partial batch failures so one
    // bad event doesn't force redelivery of the other nine.
    billingCaptureLambda.addEventSource(new lambdaEventSources.SqsEventSource(this.billingQueue, {
      batchSize: 10,
      reportBatchItemFailures: true,
    }));

    // Billing capture observability: DLQ depth + Lambda errors
    addDispatchAlarms(this, {
      prefix: 'Billing',
      dlq: billingDlq,
      fn: billingCaptureLambda,
      alarmTopic: props.opsAlertsTopic,
    });

    // 5b. Nightly reconciliation — release stale (>72h) authorization holds
    const reconcileLambda = new lambdaNodejs.NodejsFunction(this, 'ReconcileBillingFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../lambda/reconcile-billing.ts'),
      handler: 'handler',
      memorySize: 256,
      timeout: cdk.Duration.minutes(5),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.lambdaSecurityGroup],
      environment: {
        DATABASE_SECRET_ARN: props.dbSecret.secretArn,
        DATABASE_HOST: props.database.instanceEndpoint.hostname,
      },
    });
    props.dbSecret.grantRead(reconcileLambda);

    new events.Rule(this, 'NightlyReconciliationRule', {
      description: 'Sweep stale campaign authorization holds back to available credits',
      schedule: events.Schedule.cron({ minute: '0', hour: '3' }), // 03:00 UTC daily
      targets: [new eventsTargets.LambdaFunction(reconcileLambda, { retryAttempts: 2 })],
    });

    const reconcileErrorAlarm = new cloudwatch.Alarm(this, 'ReconcileErrorsAlarm', {
      alarmDescription: 'Nightly billing reconciliation failed — stale holds are not being released.',
      metric: reconcileLambda.metricErrors({ period: cdk.Duration.hours(24), statistic: 'Sum' }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    reconcileErrorAlarm.addAlarmAction(new cloudwatchActions.SnsAction(props.opsAlertsTopic));

    // 6. Deploy Stripe Webhook Lambda
    // Stripe secrets live in Secrets Manager (created out-of-band, referenced by name).
    // The Lambda receives the ARNs and resolves the values at runtime.
    const stripeSecret = secretsmanager.Secret.fromSecretNameV2(
      this, 'StripeSecret', named('marketing-saas/stripe-secret'));
    const stripeWebhookSecret = secretsmanager.Secret.fromSecretNameV2(
      this, 'StripeWebhookSecret', named('marketing-saas/stripe-webhook-secret'));

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
        STRIPE_SECRET_ARN: stripeSecret.secretArn,
        STRIPE_WEBHOOK_SECRET_ARN: stripeWebhookSecret.secretArn,
        DATABASE_SECRET_ARN: props.dbSecret.secretArn,
        DATABASE_HOST: props.database.instanceEndpoint.hostname,
      },
    });

    // Grant Stripe Lambda access to its secrets and RDS credentials
    stripeSecret.grantRead(stripeWebhookLambda);
    stripeWebhookSecret.grantRead(stripeWebhookLambda);
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
