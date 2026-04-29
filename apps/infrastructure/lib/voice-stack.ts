import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as connect from 'aws-cdk-lib/aws-connect';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as path from 'path';

export interface VoiceStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  lambdaSecurityGroup: ec2.SecurityGroup;
  database: rds.DatabaseInstance;
  dbSecret: secretsmanager.ISecret;
}

export class VoiceStack extends cdk.Stack {
  public readonly voiceDispatchQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props: VoiceStackProps) {
    super(scope, id, props);

    // 1. Provision the Pooled (Shared) Amazon Connect Instance
    const pooledConnectInstance = new connect.CfnInstance(this, 'MarketingSaaSConnectInstance', {
      attributes: {
        inboundCalls: false, 
        outboundCalls: true,
        contactflowLogs: true,
        autoResolveBestVoices: true,
      },
      identityManagementType: 'CONNECT_MANAGED',
      instanceAlias: 'marketing-saas-pooled-dialer',
    });

    // 2. Mock Contact Flow JSON for Outbound Campaign
    const outboundAmdFlowContent = JSON.stringify({
      Version: "2019-10-30",
      StartAction: "1234abcd",
      Actions: [
        {
          Identifier: "1234abcd",
          Type: "MessageParticipant",
          Parameters: {
            Text: "Hello, this is a dynamic text to speech message for <workspace_id>.",
          },
          Transitions: {
            NextAction: "disconnect-action",
            Errors: [],
          },
        },
        {
          Identifier: "disconnect-action",
          Type: "DisconnectParticipant",
          Parameters: {},
          Transitions: {},
        }
      ]
    });

    // 3. Deploy the baseline Contact Flow
    const outboundFlow = new connect.CfnContactFlow(this, 'OutboundAmdContactFlow', {
      instanceArn: pooledConnectInstance.attrArn,
      name: 'Dynamic-Outbound-AMD-Flow',
      type: 'CONTACT_FLOW',
      content: outboundAmdFlowContent,
      description: 'Handles outbound campaign dialing, executes AMD, and plays poly voicemails.',
    });

    // 4. Create SQS Queue for Voice dispatch
    this.voiceDispatchQueue = new sqs.Queue(this, 'VoiceDispatchQueue', {
      visibilityTimeout: cdk.Duration.seconds(30),
      retentionPeriod: cdk.Duration.days(4),
    });

    // 5. Create Dispatch Lambda
    const dispatchLambda = new lambdaNodejs.NodejsFunction(this, 'VoiceDispatchFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../lambda/dispatch/dispatch-voice.ts'),
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
        CONNECT_INSTANCE_ID: pooledConnectInstance.ref,
        CONTACT_FLOW_ID: outboundFlow.ref,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
      },
    });

    // 6. Grant permissions
    props.dbSecret.grantRead(dispatchLambda);
    this.voiceDispatchQueue.grantConsumeMessages(dispatchLambda);
    
    // Grant Connect sending permissions
    dispatchLambda.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
      actions: ['connect:StartOutboundVoiceContact'],
      resources: [`arn:aws:connect:${this.region}:${this.account}:instance/${pooledConnectInstance.ref}/*`],
    }));

    // 7. Add SQS as event source
    dispatchLambda.addEventSource(new lambdaEventSources.SqsEventSource(this.voiceDispatchQueue, {
      batchSize: 10,
    }));

    // Outputs
    new cdk.CfnOutput(this, 'AmazonConnectInstanceAlias', {
      value: pooledConnectInstance.instanceAlias || 'Pending',
    });
  }
}
