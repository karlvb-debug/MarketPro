import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { DatabaseStack } from '../lib/database-stack';
import { EmailStack } from '../lib/email-stack';
import { BillingStack } from '../lib/billing-stack';

// Skip esbuild asset bundling during synth — these tests assert on the
// CloudFormation template, not on Lambda bundles.
function makeApp() {
  return new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
}

describe('DatabaseStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = makeApp();
    const stack = new DatabaseStack(app, 'TestDatabaseStack');
    template = Template.fromStack(stack);
  });

  test('creates a private PostgreSQL instance', () => {
    template.resourceCountIs('AWS::RDS::DBInstance', 1);
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      Engine: 'postgres',
      PubliclyAccessible: false,
      DBName: 'marketingsaas',
    });
  });

  test('creates the DynamoDB idempotency store with TTL', () => {
    template.resourceCountIs('AWS::DynamoDB::GlobalTable', 1);
    template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
      KeySchema: [{ AttributeName: 'Message_ID', KeyType: 'HASH' }],
    });
  });

  test('creates a VPC and restricts RDS ingress to the Lambda security group on 5432', () => {
    template.resourceCountIs('AWS::EC2::VPC', 1);
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      FromPort: 5432,
      ToPort: 5432,
      IpProtocol: 'tcp',
    });
  });

  test('generates DB credentials in Secrets Manager (no plaintext password)', () => {
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'marketing-saas/rds-credentials',
      GenerateSecretString: Match.objectLike({
        GenerateStringKey: 'password',
      }),
    });
  });
});

describe('EmailStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = makeApp();
    const db = new DatabaseStack(app, 'TestDatabaseStack');
    const stack = new EmailStack(app, 'TestEmailStack', {
      vpc: db.vpc,
      lambdaSecurityGroup: db.lambdaSecurityGroup,
      database: db.database,
      dbSecret: db.dbSecret,
      opsAlertsTopic: db.opsAlertsTopic,
    });
    template = Template.fromStack(stack);
  });

  test('creates the dispatch queue with a dead-letter queue', () => {
    template.resourceCountIs('AWS::SQS::Queue', 2);
    template.hasResourceProperties('AWS::SQS::Queue', {
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 3 }),
      VisibilityTimeout: 1800,
    });
  });

  test('processes one campaign per invocation with partial batch failures', () => {
    template.resourceCountIs('AWS::Lambda::EventSourceMapping', 1);
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 1,
      FunctionResponseTypes: ['ReportBatchItemFailures'],
    });
  });

  test('alarms on DLQ depth and Lambda errors, wired to the ops topic', () => {
    template.resourceCountIs('AWS::CloudWatch::Alarm', 2);
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'ApproximateNumberOfMessagesVisible',
      Threshold: 1,
      AlarmActions: Match.anyValue(),
    });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'Errors',
      Namespace: 'AWS/Lambda',
      Threshold: 1,
    });
  });

  test('dispatch Lambda reads DB credentials from Secrets Manager', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          DATABASE_SECRET_ARN: Match.anyValue(),
          DATABASE_HOST: Match.anyValue(),
        }),
      },
    });
  });
});

describe('BillingStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = makeApp();
    const db = new DatabaseStack(app, 'TestDatabaseStack');
    const stack = new BillingStack(app, 'TestBillingStack', {
      vpc: db.vpc,
      lambdaSecurityGroup: db.lambdaSecurityGroup,
      database: db.database,
      dbSecret: db.dbSecret,
      idempotencyTable: db.idempotencyTable,
    });
    template = Template.fromStack(stack);
  });

  test('creates the canonical event bus fanned out to the billing queue', () => {
    template.resourceCountIs('AWS::SNS::Topic', 1);
    template.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'sqs',
      RawMessageDelivery: true,
    });
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'marketing-saas-billing-queue',
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 5 }),
    });
  });

  test('Stripe webhook Lambda receives secret ARNs, never plaintext keys', () => {
    const lambdas = template.findResources('AWS::Lambda::Function');
    const stripeLambda = Object.values(lambdas).find((fn) =>
      JSON.stringify(fn.Properties?.Environment ?? {}).includes('STRIPE_SECRET_ARN'),
    );
    expect(stripeLambda).toBeDefined();

    const vars = stripeLambda!.Properties.Environment.Variables;
    expect(vars.STRIPE_SECRET_ARN).toBeDefined();
    expect(vars.STRIPE_WEBHOOK_SECRET_ARN).toBeDefined();
    expect(vars.DATABASE_SECRET_ARN).toBeDefined();
    // Regression guard: no plaintext secret material in env vars
    expect(vars.STRIPE_SECRET_KEY).toBeUndefined();
    expect(vars.STRIPE_WEBHOOK_SECRET).toBeUndefined();
    expect(vars.DATABASE_URL).toBeUndefined();
  });

  test('exposes the Stripe webhook endpoint on API Gateway', () => {
    template.hasResourceProperties('AWS::ApiGateway::Resource', {
      PathPart: 'stripe-webhook',
    });
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'POST',
    });
  });
});
