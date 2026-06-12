import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as ses from "aws-cdk-lib/aws-ses";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as sns from "aws-cdk-lib/aws-sns";
import * as path from "path";
import { addDispatchAlarms } from "./monitoring";

export interface EmailStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  lambdaSecurityGroup: ec2.SecurityGroup;
  database: rds.DatabaseInstance;
  dbSecret: secretsmanager.ISecret;
  opsAlertsTopic: sns.ITopic;
}

export class EmailStack extends cdk.Stack {
  public readonly emailDispatchQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props: EmailStackProps) {
    super(scope, id, props);

    // SES Email Identity — only created when a real domain is configured.
    // Set SES_DOMAIN env var (e.g., 'yourdomain.com') before deploying.
    const sesDomain = process.env.SES_DOMAIN;

    if (sesDomain) {
      new ses.EmailIdentity(this, "MarketingSaaSEmailIdentity", {
        identity: ses.Identity.domain(sesDomain),
        mailFromDomain: `bounce.${sesDomain}`,
      });

      // Dedicated IP Pool for warming up IPs automatically via SES Managed IPs
      new ses.DedicatedIpPool(this, "MarketingSaaSIpPool", {
        dedicatedIpPoolName: "marketing-saas-production-pool",
        scalingMode: ses.ScalingMode.MANAGED,
      });
    }

    // 1. Create SQS Queue for email dispatch with DLQ
    const emailDispatchDlq = new sqs.Queue(this, "EmailDispatchDLQ", {
      retentionPeriod: cdk.Duration.days(14),
    });

    this.emailDispatchQueue = new sqs.Queue(this, "EmailDispatchQueue", {
      // 6x the Lambda timeout (AWS guidance) so an in-flight campaign is
      // never delivered to a second consumer while the first still runs.
      visibilityTimeout: cdk.Duration.seconds(1800),
      retentionPeriod: cdk.Duration.days(4),
      deadLetterQueue: {
        queue: emailDispatchDlq,
        maxReceiveCount: 3,
      },
    });

    // 1.5. Public unsubscribe endpoint (RFC 8058 one-click + footer links).
    // Lives here rather than the main API stack because the dispatch Lambda
    // needs its URL at deploy time (ApiStack depends on EmailStack).
    const unsubscribeLambda = new lambdaNodejs.NodejsFunction(this, "UnsubscribeFunction", {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, "../lambda/unsubscribe.ts"),
      handler: "handler",
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.lambdaSecurityGroup],
      environment: {
        DATABASE_SECRET_ARN: props.dbSecret.secretArn,
        DATABASE_HOST: props.database.instanceEndpoint.hostname,
        DATABASE_NAME: "marketingsaas",
      },
      bundling: {
        externalModules: ["@aws-sdk/*"],
      },
    });
    props.dbSecret.grantRead(unsubscribeLambda);

    const unsubscribeApi = new apigateway.RestApi(this, "UnsubscribeApi", {
      restApiName: "Marketing SaaS Unsubscribe API",
      description: "Public RFC 8058 one-click unsubscribe endpoint",
    });
    const unsubscribeResource = unsubscribeApi.root.addResource("unsubscribe");
    const unsubscribeIntegration = new apigateway.LambdaIntegration(unsubscribeLambda);
    unsubscribeResource.addMethod("GET", unsubscribeIntegration); // footer link
    unsubscribeResource.addMethod("POST", unsubscribeIntegration); // one-click (mail clients)

    const unsubscribeUrl = `${unsubscribeApi.url}unsubscribe`;

    // 2. Create Dispatch Lambda
    const dispatchLambda = new lambdaNodejs.NodejsFunction(
      this,
      "EmailDispatchFunction",
      {
        runtime: lambda.Runtime.NODEJS_20_X,
        entry: path.join(__dirname, "../lambda/dispatch/dispatch-email.ts"),
        handler: "handler",
        memorySize: 512,
        timeout: cdk.Duration.seconds(300),
        vpc: props.vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [props.lambdaSecurityGroup],
        environment: {
          DATABASE_SECRET_ARN: props.dbSecret.secretArn,
          DATABASE_HOST: props.database.instanceEndpoint.hostname,
          DATABASE_NAME: "marketingsaas",
          UNSUBSCRIBE_BASE_URL: unsubscribeUrl,
        },
        bundling: {
          externalModules: ["@aws-sdk/*"],
        },
      },
    );

    // 3. Grant permissions
    props.dbSecret.grantRead(dispatchLambda);
    this.emailDispatchQueue.grantConsumeMessages(dispatchLambda);

    // Grant SES sending permissions, scoped to this account's verified
    // identities (sending FROM an identity requires the identity resource)
    dispatchLambda.addToRolePolicy(
      new cdk.aws_iam.PolicyStatement({
        actions: [
          "ses:SendEmail",
          "ses:SendRawEmail",
          "ses:SendTemplatedEmail",
        ],
        resources: [
          `arn:aws:ses:${this.region}:${this.account}:identity/*`,
          `arn:aws:ses:${this.region}:${this.account}:configuration-set/*`,
        ],
      }),
    );

    // 4. Add SQS as event source — one campaign per invocation, with partial
    // batch failure reporting so only retryable records are redelivered.
    dispatchLambda.addEventSource(
      new lambdaEventSources.SqsEventSource(this.emailDispatchQueue, {
        batchSize: 1,
        reportBatchItemFailures: true,
      }),
    );

    // 5. Alarms: DLQ depth + Lambda errors → ops topic
    addDispatchAlarms(this, {
      prefix: "Email",
      dlq: emailDispatchDlq,
      fn: dispatchLambda,
      alarmTopic: props.opsAlertsTopic,
    });

    // Outputs
    new cdk.CfnOutput(this, "UnsubscribeEndpointUrl", {
      value: unsubscribeUrl,
    });
    new cdk.CfnOutput(this, "EmailDispatchQueueUrl", {
      value: this.emailDispatchQueue.queueUrl,
    });
    new cdk.CfnOutput(this, "EmailDispatchDlqUrl", {
      value: emailDispatchDlq.queueUrl,
    });
  }
}
