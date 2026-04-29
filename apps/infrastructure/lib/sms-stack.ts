import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as path from 'path';

export interface SmsStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  lambdaSecurityGroup: ec2.SecurityGroup;
  database: rds.DatabaseInstance;
  dbSecret: secretsmanager.ISecret;
}

export class SmsStack extends cdk.Stack {
  public readonly smsDispatchQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props: SmsStackProps) {
    super(scope, id, props);

    // 1. Deploy the Timezone Resolution Engine (Waterfall lookup)
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

    // 2. Dedicated SNS Topic for Inbound Two-Way messages
    const inboundSmsTopic = new sns.Topic(this, 'InboundSmsTopic', {
        topicName: 'marketing-saas-inbound-sms',
    });

    // 3. Create SQS Queue for SMS dispatch (with DLQ for production reliability)
    const smsDispatchDlq = new sqs.Queue(this, 'SmsDispatchDLQ', {
      retentionPeriod: cdk.Duration.days(14),
    });

    this.smsDispatchQueue = new sqs.Queue(this, 'SmsDispatchQueue', {
      visibilityTimeout: cdk.Duration.seconds(30),
      retentionPeriod: cdk.Duration.days(4),
      deadLetterQueue: {
        queue: smsDispatchDlq,
        maxReceiveCount: 3,
      },
    });

    // 4. Create Dispatch Lambda (uses AWS End User Messaging v2 API)
    const dispatchLambda = new lambdaNodejs.NodejsFunction(this, 'SmsDispatchFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../lambda/dispatch/dispatch-sms.ts'),
      handler: 'handler',
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
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

    // 5. Grant permissions
    props.dbSecret.grantRead(dispatchLambda);
    this.smsDispatchQueue.grantConsumeMessages(dispatchLambda);
    
    // Grant AWS End User Messaging SMS v2 sending permissions
    dispatchLambda.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
      actions: [
        'sms-voice:SendTextMessage',
        'sms-voice:DescribePhoneNumbers',
        'sms-voice:DescribeOptOutLists',
      ],
      resources: ['*'], // End User Messaging v2 resources are account-wide
    }));

    // 6. Add SQS as event source
    dispatchLambda.addEventSource(new lambdaEventSources.SqsEventSource(this.smsDispatchQueue, {
      batchSize: 10,
    }));

    // Outputs
    new cdk.CfnOutput(this, 'SmsDispatchQueueUrl', {
      value: this.smsDispatchQueue.queueUrl,
    });
    new cdk.CfnOutput(this, 'SmsDispatchDlqUrl', {
      value: smsDispatchDlq.queueUrl,
    });
  }
}
