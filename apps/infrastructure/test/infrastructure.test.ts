import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { DatabaseStack } from '../lib/database-stack';
import { EmailStack } from '../lib/email-stack';
import { BillingStack } from '../lib/billing-stack';
import { AuthStack } from '../lib/auth-stack';
import { ApiStack } from '../lib/api-stack';

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

  test('exposes the public RFC 8058 unsubscribe endpoint', () => {
    template.hasResourceProperties('AWS::ApiGateway::Resource', {
      PathPart: 'unsubscribe',
    });
    // Both GET (footer link) and POST (one-click) — and NO authorizer
    const methods = template.findResources('AWS::ApiGateway::Method');
    const unsubMethods = Object.values(methods).filter((m) =>
      ['GET', 'POST'].includes(m.Properties?.HttpMethod) && m.Properties?.AuthorizationType === 'NONE',
    );
    expect(unsubMethods.length).toBeGreaterThanOrEqual(2);
  });

  test('dispatch Lambda knows the unsubscribe URL for List-Unsubscribe headers', () => {
    const lambdas = template.findResources('AWS::Lambda::Function');
    const dispatch = Object.values(lambdas).find((fn) =>
      JSON.stringify(fn.Properties?.Environment ?? {}).includes('UNSUBSCRIBE_BASE_URL'),
    );
    expect(dispatch).toBeDefined();
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
      opsAlertsTopic: db.opsAlertsTopic,
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

  test('schedules the nightly reconciliation sweep', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'cron(0 3 * * ? *)',
      State: 'ENABLED',
    });
  });

  test('billing queue reports partial batch failures', () => {
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      FunctionResponseTypes: ['ReportBatchItemFailures'],
    });
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

describe('DatabaseStack (prod stage)', () => {
  let template: Template;

  beforeAll(() => {
    const app = makeApp();
    const stack = new DatabaseStack(app, 'ProdDatabaseStack', { stage: 'prod' });
    template = Template.fromStack(stack);
  });

  test('production RDS is Multi-AZ, encrypted, protected, with 14-day backups', () => {
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      MultiAZ: true,
      StorageEncrypted: true,
      DeletionProtection: true,
      BackupRetentionPeriod: 14,
    });
    template.hasResource('AWS::RDS::DBInstance', {
      DeletionPolicy: 'Retain',
    });
  });

  test('stage-suffixed physical names avoid collisions with dev', () => {
    template.hasResourceProperties('AWS::SNS::Topic', {
      TopicName: 'marketing-saas-ops-alerts-prod',
    });
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'marketing-saas/rds-credentials-prod',
    });
  });
});

describe('ApiStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = makeApp();
    const db = new DatabaseStack(app, 'TestDatabaseStack');
    const auth = new AuthStack(app, 'TestAuthStack');
    const stack = new ApiStack(app, 'TestApiStack', {
      vpc: db.vpc,
      lambdaSecurityGroup: db.lambdaSecurityGroup,
      database: db.database,
      dbSecret: db.dbSecret,
      userPool: auth.userPool,
      userPoolClient: auth.userPoolClient,
      opsAlertsTopic: db.opsAlertsTopic,
      idempotencyTable: db.idempotencyTable,
    });
    template = Template.fromStack(stack);
  });

  test('exposes the email test-send endpoint backed by an SES-sending Lambda', () => {
    template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: 'test-send' });
    const lambdas = template.findResources('AWS::Lambda::Function');
    const sender = Object.values(lambdas).find((fn) =>
      JSON.stringify(fn.Properties?.Environment ?? {}).includes('IDEMPOTENCY_TABLE'),
    );
    expect(sender).toBeDefined();
  });

  test('WAF web ACL with rate limit + managed rules is associated with the API stage', () => {
    template.resourceCountIs('AWS::WAFv2::WebACL', 1);
    template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Rules: Match.arrayWith([
        Match.objectLike({ Name: 'RateLimitPerIp' }),
        Match.objectLike({ Name: 'AWSManagedCommonRuleSet' }),
      ]),
    });
  });

  test('migrations run automatically on deploy via Trigger', () => {
    template.resourceCountIs('Custom::Trigger', 1);
  });

  test('scheduled dispatch poller fires every 5 minutes and is alarmed', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(5 minutes)',
      State: 'ENABLED',
    });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'Errors',
      Namespace: 'AWS/Lambda',
    });
  });
});
