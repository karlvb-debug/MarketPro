import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as path from 'path';

export interface EmailStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  lambdaSecurityGroup: ec2.SecurityGroup;
  database: rds.DatabaseInstance;
  dbSecret: secretsmanager.ISecret;
}

export class EmailStack extends cdk.Stack {
  public readonly emailDispatchQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props: EmailStackProps) {
    super(scope, id, props);

    // SES Email Identity — only created when a real domain is configured.
    // Set SES_DOMAIN env var (e.g., 'yourdomain.com') before deploying.
    const sesDomain = process.env.SES_DOMAIN;

    if (sesDomain) {
      new ses.EmailIdentity(this, 'MarketingSaaSEmailIdentity', {
        identity: ses.Identity.domain(sesDomain),
        mailFromDomain: `bounce.${sesDomain}`,
      });

      // Dedicated IP Pool for warming up IPs automatically via SES Managed IPs
      new ses.DedicatedIpPool(this, 'MarketingSaaSIpPool', {
        dedicatedIpPoolName: 'marketing-saas-production-pool',
        scalingMode: ses.ScalingMode.MANAGED,
      });
    }

    // 1. Create SQS Queue for email dispatch
    this.emailDispatchQueue = new sqs.Queue(this, 'EmailDispatchQueue', {
      visibilityTimeout: cdk.Duration.seconds(300),
      retentionPeriod: cdk.Duration.days(4),
    });

    // 2. Create Dispatch Lambda
    const dispatchLambda = new lambdaNodejs.NodejsFunction(this, 'EmailDispatchFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../lambda/dispatch/dispatch-email.ts'),
      handler: 'handler',
      memorySize: 512,
      timeout: cdk.Duration.seconds(300),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.lambdaSecurityGroup],
      environment: {
        DATABASE_SECRET_ARN: props.dbSecret.secretArn,
        DATABASE_HOST: props.database.instanceEndpoint.hostname,
        DATABASE_NAME: 'marketingsaas',
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
      },
    });

    // 3. Grant permissions
    props.dbSecret.grantRead(dispatchLambda);
    this.emailDispatchQueue.grantConsumeMessages(dispatchLambda);
    
    // Grant SES sending permissions
    dispatchLambda.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
      actions: ['ses:SendEmail', 'ses:SendRawEmail', 'ses:SendTemplatedEmail'],
      resources: ['*'],
    }));

    // 4. Add SQS as event source
    dispatchLambda.addEventSource(new lambdaEventSources.SqsEventSource(this.emailDispatchQueue, {
      batchSize: 10,
    }));
  }
}
