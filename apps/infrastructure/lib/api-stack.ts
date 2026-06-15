import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as triggers from 'aws-cdk-lib/triggers';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as path from 'path';

export interface ApiStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  lambdaSecurityGroup: ec2.SecurityGroup;
  database: rds.DatabaseInstance;
  dbSecret: secretsmanager.ISecret;
  userPool: cognito.UserPool;
  userPoolClient: cognito.UserPoolClient;
  emailDispatchQueue?: sqs.IQueue;
  smsDispatchQueue?: sqs.IQueue;
  voiceDispatchQueue?: sqs.IQueue;
  uploadBucket?: s3.IBucket;
  frontendUrl?: string;
  opsAlertsTopic?: sns.ITopic;
}

export class ApiStack extends cdk.Stack {
  public readonly api: apigateway.RestApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const allowedOrigin = props.frontendUrl || '*';

    // Common Lambda configuration
    const commonLambdaProps = {
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 256,
      timeout: cdk.Duration.seconds(15),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.lambdaSecurityGroup],
      environment: {
        DATABASE_SECRET_ARN: props.dbSecret.secretArn,
        DATABASE_HOST: props.database.instanceEndpoint.hostname,
        DATABASE_NAME: 'marketingsaas',
      },
      bundling: {
        // Include drizzle-orm, pg, and the schema in the bundle
        externalModules: ['@aws-sdk/*'],
      },
    };

    // ============================================
    // Authorizer Lambda — JWT verification + RBAC (workspace role check)
    // ============================================
    const authorizerLambda = new lambdaNodejs.NodejsFunction(this, 'WorkspaceAuthorizerFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../lambda/authorizer.ts'),
      handler: 'handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.lambdaSecurityGroup],
      environment: {
        USER_POOL_ID: props.userPool.userPoolId,
        APP_CLIENT_ID: props.userPoolClient.userPoolClientId,
        DATABASE_SECRET_ARN: props.dbSecret.secretArn,
        DATABASE_HOST: props.database.instanceEndpoint.hostname,
        DATABASE_NAME: 'marketingsaas',
        DATABASE_URL: `postgresql://placeholder@${props.database.instanceEndpoint.hostname}:5432/marketingsaas`,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
      },
    });
    props.dbSecret.grantRead(authorizerLambda);

    // Use RequestAuthorizer so we can read X-Workspace-Id for per-workspace caching
    const tokenAuthorizer = new apigateway.RequestAuthorizer(this, 'WorkspaceTokenAuthorizer', {
      handler: authorizerLambda,
      identitySources: [
        apigateway.IdentitySource.header('Authorization'),
        apigateway.IdentitySource.header('X-Workspace-Id'),
      ],
      resultsCacheTtl: cdk.Duration.seconds(300),
    });

    // ============================================
    // DB Migration Lambda — versioned runner (database/migrations/)
    // Invoked automatically on every deploy via Trigger; safe to re-run.
    // ============================================
    const migrateLambda = new lambdaNodejs.NodejsFunction(this, 'DbMigrateFunction', {
      ...commonLambdaProps,
      entry: path.join(__dirname, '../lambda/db-migrate.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(120),
      memorySize: 512,
    });
    props.dbSecret.grantRead(migrateLambda);

    // Run pending migrations on every deploy (re-fires when the Lambda
    // code — i.e. the migration set — changes).
    new triggers.Trigger(this, 'RunMigrationsOnDeploy', {
      handler: migrateLambda,
      invocationType: triggers.InvocationType.REQUEST_RESPONSE,
      timeout: cdk.Duration.minutes(3),
    });

    // ============================================
    // CRUD Lambdas
    // ============================================

    const workspacesLambda = new lambdaNodejs.NodejsFunction(this, 'WorkspacesFunction', {
      ...commonLambdaProps,
      entry: path.join(__dirname, '../lambda/api/workspaces.ts'),
      handler: 'handler',
    });
    props.dbSecret.grantRead(workspacesLambda);

    const contactsLambda = new lambdaNodejs.NodejsFunction(this, 'ContactsFunction', {
      ...commonLambdaProps,
      entry: path.join(__dirname, '../lambda/api/contacts.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(29), // Higher timeout for bulk import (up to 1,000 rows)
      memorySize: 512,                   // More memory for large INSERT batches
      environment: {
        ...commonLambdaProps.environment,
        UPLOAD_BUCKET: props.uploadBucket?.bucketName || '',
      },
    });
    props.dbSecret.grantRead(contactsLambda);
    if (props.uploadBucket) {
      props.uploadBucket.grantPut(contactsLambda);
    }

    const segmentsLambda = new lambdaNodejs.NodejsFunction(this, 'SegmentsFunction', {
      ...commonLambdaProps,
      entry: path.join(__dirname, '../lambda/api/segments.ts'),
      handler: 'handler',
    });
    props.dbSecret.grantRead(segmentsLambda);

    const campaignsLambda = new lambdaNodejs.NodejsFunction(this, 'CampaignsFunction', {
      ...commonLambdaProps,
      entry: path.join(__dirname, '../lambda/api/campaigns.ts'),
      handler: 'handler',
      environment: {
        ...commonLambdaProps.environment,
        EMAIL_DISPATCH_QUEUE_URL: props.emailDispatchQueue?.queueUrl || '',
        SMS_DISPATCH_QUEUE_URL: props.smsDispatchQueue?.queueUrl || '',
        VOICE_DISPATCH_QUEUE_URL: props.voiceDispatchQueue?.queueUrl || '',
      },
    });
    props.dbSecret.grantRead(campaignsLambda);
    if (props.emailDispatchQueue) {
      props.emailDispatchQueue.grantSendMessages(campaignsLambda);
    }
    if (props.smsDispatchQueue) {
      props.smsDispatchQueue.grantSendMessages(campaignsLambda);
    }
    if (props.voiceDispatchQueue) {
      props.voiceDispatchQueue.grantSendMessages(campaignsLambda);
    }

    const settingsLambda = new lambdaNodejs.NodejsFunction(this, 'SettingsFunction', {
      ...commonLambdaProps,
      entry: path.join(__dirname, '../lambda/api/settings.ts'),
      handler: 'handler',
    });
    props.dbSecret.grantRead(settingsLambda);

    const templatesLambda = new lambdaNodejs.NodejsFunction(this, 'TemplatesFunction', {
      ...commonLambdaProps,
      entry: path.join(__dirname, '../lambda/api/templates.ts'),
      handler: 'handler',
    });
    props.dbSecret.grantRead(templatesLambda);

    // GDPR/CCPA right-to-be-forgotten — destructive, admin+ only
    const forgetLambda = new lambdaNodejs.NodejsFunction(this, 'RightToBeForgottenFunction', {
      ...commonLambdaProps,
      entry: path.join(__dirname, '../lambda/right-to-be-forgotten.ts'),
      handler: 'handler',
    });
    props.dbSecret.grantRead(forgetLambda);

    // Custom field definitions (contacts module C1)
    const customFieldsLambda = new lambdaNodejs.NodejsFunction(this, 'CustomFieldsFunction', {
      ...commonLambdaProps,
      entry: path.join(__dirname, '../lambda/api/custom-fields.ts'),
      handler: 'handler',
    });
    props.dbSecret.grantRead(customFieldsLambda);

    const batchLambda = new lambdaNodejs.NodejsFunction(this, 'BatchFunction', {
      ...commonLambdaProps,
      entry: path.join(__dirname, '../lambda/api/batch.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(15),
    });
    props.dbSecret.grantRead(batchLambda);

    // ============================================
    // API Gateway
    // ============================================

    this.api = new apigateway.RestApi(this, 'MarketingSaaSAPI', {
      restApiName: 'Marketing SaaS Platform API',
      description: 'Main entrypoint for the Next.js frontend to interact with backend services',
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization', 'X-Workspace-Id'],
      },
    });

    // Add CORS headers to Gateway error responses (auth failures, 5xx, etc.)
    // Without these, error responses from the authorizer are CORS-blocked
    this.api.addGatewayResponse('Default4XX', {
      type: apigateway.ResponseType.DEFAULT_4XX,
      responseHeaders: {
        'Access-Control-Allow-Origin': "'*'",
        'Access-Control-Allow-Headers': "'Content-Type,Authorization,X-Workspace-Id'",
      },
    });

    this.api.addGatewayResponse('Default5XX', {
      type: apigateway.ResponseType.DEFAULT_5XX,
      responseHeaders: {
        'Access-Control-Allow-Origin': "'*'",
        'Access-Control-Allow-Headers': "'Content-Type,Authorization,X-Workspace-Id'",
      },
    });

    // Shared method options for secured endpoints
    const securedMethodOptions: apigateway.MethodOptions = {
      authorizer: tokenAuthorizer,
      authorizationType: apigateway.AuthorizationType.CUSTOM,
    };

    // ---- /health (open) ----
    const healthResource = this.api.root.addResource('health');
    healthResource.addMethod('GET', new apigateway.MockIntegration({
      integrationResponses: [{
        statusCode: '200',
        responseTemplates: {
          'application/json': JSON.stringify({ status: 'Platform is Online' }),
        },
      }],
      passthroughBehavior: apigateway.PassthroughBehavior.NEVER,
      requestTemplates: { 'application/json': '{"statusCode": 200}' },
    }), {
      methodResponses: [{ statusCode: '200' }],
    });

    // ---- /workspaces ----
    const workspacesResource = this.api.root.addResource('workspaces');
    const workspacesIntegration = new apigateway.LambdaIntegration(workspacesLambda);
    workspacesResource.addMethod('GET', workspacesIntegration, securedMethodOptions);
    workspacesResource.addMethod('POST', workspacesIntegration, securedMethodOptions);

    const workspaceIdResource = workspacesResource.addResource('{id}');
    workspaceIdResource.addMethod('PUT', workspacesIntegration, securedMethodOptions);
    workspaceIdResource.addMethod('DELETE', workspacesIntegration, securedMethodOptions);

    // ---- /contacts ----
    const contactsResource = this.api.root.addResource('contacts');
    const contactsIntegration = new apigateway.LambdaIntegration(contactsLambda);
    contactsResource.addMethod('GET', contactsIntegration, securedMethodOptions);
    contactsResource.addMethod('POST', contactsIntegration, securedMethodOptions);
    contactsResource.addMethod('DELETE', contactsIntegration, securedMethodOptions); // bulk delete

    // /contacts/import — bulk upsert endpoint
    const contactsImportResource = contactsResource.addResource('import');
    contactsImportResource.addMethod('POST', contactsIntegration, securedMethodOptions);

    // /contacts/search — server-side rule filtering
    const contactsSearchResource = contactsResource.addResource('search');
    contactsSearchResource.addMethod('POST', contactsIntegration, securedMethodOptions);

    // /contacts/import-url — generate presigned s3 upload URL
    const contactsImportUrlResource = contactsResource.addResource('import-url');
    contactsImportUrlResource.addMethod('GET', contactsIntegration, securedMethodOptions);

    const contactIdResource = contactsResource.addResource('{id}');
    contactIdResource.addMethod('GET', contactsIntegration, securedMethodOptions);
    contactIdResource.addMethod('PUT', contactsIntegration, securedMethodOptions);
    contactIdResource.addMethod('DELETE', contactsIntegration, securedMethodOptions);

    // /contacts/{id}/forget — GDPR/CCPA erasure (Data Retention Matrix)
    const contactForgetResource = contactIdResource.addResource('forget');
    contactForgetResource.addMethod('POST', new apigateway.LambdaIntegration(forgetLambda), securedMethodOptions);

    // ---- /segments ----
    const segmentsResource = this.api.root.addResource('segments');
    const segmentsIntegration = new apigateway.LambdaIntegration(segmentsLambda);
    segmentsResource.addMethod('GET', segmentsIntegration, securedMethodOptions);
    segmentsResource.addMethod('POST', segmentsIntegration, securedMethodOptions);

    // /segments/preview-count — live count for an unsaved dynamic rule tree
    const segmentsPreviewResource = segmentsResource.addResource('preview-count');
    segmentsPreviewResource.addMethod('POST', segmentsIntegration, securedMethodOptions);

    const segmentIdResource = segmentsResource.addResource('{id}');
    segmentIdResource.addMethod('PUT', segmentsIntegration, securedMethodOptions);
    segmentIdResource.addMethod('DELETE', segmentsIntegration, securedMethodOptions);

    // /segments/{id}/contacts — preview membership (GET) + add/remove (static)
    const segmentContactsResource = segmentIdResource.addResource('contacts');
    segmentContactsResource.addMethod('GET', segmentsIntegration, securedMethodOptions);
    segmentContactsResource.addMethod('POST', segmentsIntegration, securedMethodOptions);
    segmentContactsResource.addMethod('DELETE', segmentsIntegration, securedMethodOptions);

    // ---- /campaigns ----
    const campaignsResource = this.api.root.addResource('campaigns');
    const campaignsIntegration = new apigateway.LambdaIntegration(campaignsLambda);
    campaignsResource.addMethod('GET', campaignsIntegration, securedMethodOptions);
    campaignsResource.addMethod('POST', campaignsIntegration, securedMethodOptions);

    // ---- /settings ----
    const settingsResource = this.api.root.addResource('settings');
    const settingsIntegration = new apigateway.LambdaIntegration(settingsLambda);
    settingsResource.addMethod('GET', settingsIntegration, securedMethodOptions);
    settingsResource.addMethod('PUT', settingsIntegration, securedMethodOptions);

    // ---- /templates/{type} and /templates/{type}/{id} ----
    const templatesResource = this.api.root.addResource('templates');
    const templatesIntegration = new apigateway.LambdaIntegration(templatesLambda);
    const templateTypeResource = templatesResource.addResource('{type}');
    templateTypeResource.addMethod('GET', templatesIntegration, securedMethodOptions);
    templateTypeResource.addMethod('POST', templatesIntegration, securedMethodOptions);

    const templateIdResource = templateTypeResource.addResource('{id}');
    templateIdResource.addMethod('GET', templatesIntegration, securedMethodOptions);
    templateIdResource.addMethod('PUT', templatesIntegration, securedMethodOptions);
    templateIdResource.addMethod('DELETE', templatesIntegration, securedMethodOptions);

    // ---- /custom-fields ----
    const customFieldsResource = this.api.root.addResource('custom-fields');
    const customFieldsIntegration = new apigateway.LambdaIntegration(customFieldsLambda);
    customFieldsResource.addMethod('GET', customFieldsIntegration, securedMethodOptions);
    customFieldsResource.addMethod('POST', customFieldsIntegration, securedMethodOptions);
    const customFieldIdResource = customFieldsResource.addResource('{id}');
    customFieldIdResource.addMethod('PUT', customFieldsIntegration, securedMethodOptions);
    customFieldIdResource.addMethod('DELETE', customFieldsIntegration, securedMethodOptions);

    // ---- /batch (single call for all workspace data) ----
    const batchResource = this.api.root.addResource('batch');
    const batchIntegration = new apigateway.LambdaIntegration(batchLambda);
    batchResource.addMethod('GET', batchIntegration, securedMethodOptions);

    // ============================================
    // Scheduled dispatch poller — launches campaigns whose scheduled_at
    // has come due (claim → authorization hold → SQS), every 5 minutes.
    // ============================================
    const scheduledDispatchLambda = new lambdaNodejs.NodejsFunction(this, 'ScheduledDispatchFunction', {
      ...commonLambdaProps,
      entry: path.join(__dirname, '../lambda/scheduled-dispatch.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(120),
      environment: {
        ...commonLambdaProps.environment,
        EMAIL_DISPATCH_QUEUE_URL: props.emailDispatchQueue?.queueUrl || '',
        SMS_DISPATCH_QUEUE_URL: props.smsDispatchQueue?.queueUrl || '',
        VOICE_DISPATCH_QUEUE_URL: props.voiceDispatchQueue?.queueUrl || '',
      },
    });
    props.dbSecret.grantRead(scheduledDispatchLambda);
    props.emailDispatchQueue?.grantSendMessages(scheduledDispatchLambda);
    props.smsDispatchQueue?.grantSendMessages(scheduledDispatchLambda);
    props.voiceDispatchQueue?.grantSendMessages(scheduledDispatchLambda);

    new events.Rule(this, 'ScheduledDispatchRule', {
      description: 'Launch campaigns whose scheduled send time has arrived',
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [new eventsTargets.LambdaFunction(scheduledDispatchLambda, { retryAttempts: 2 })],
    });

    if (props.opsAlertsTopic) {
      const pollerAlarm = new cloudwatch.Alarm(this, 'ScheduledDispatchErrorsAlarm', {
        alarmDescription: 'Scheduled campaign dispatch poller is failing — due campaigns are not launching.',
        metric: scheduledDispatchLambda.metricErrors({ period: cdk.Duration.minutes(15), statistic: 'Sum' }),
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      pollerAlarm.addAlarmAction(new cloudwatchActions.SnsAction(props.opsAlertsTopic));
    }

    // ============================================
    // WAF — managed protections + per-IP rate limit on the public API
    // ============================================
    const webAcl = new wafv2.CfnWebACL(this, 'ApiWebAcl', {
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: 'MarketingSaaSApiWaf',
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: 'RateLimitPerIp',
          priority: 0,
          action: { block: {} },
          statement: {
            rateBasedStatement: { aggregateKeyType: 'IP', limit: 2000 }, // per 5 min
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'RateLimitPerIp',
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'AWSManagedCommonRuleSet',
          priority: 1,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'CommonRuleSet',
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'AWSManagedKnownBadInputs',
          priority: 2,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesKnownBadInputsRuleSet',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'KnownBadInputs',
            sampledRequestsEnabled: true,
          },
        },
      ],
    });

    new wafv2.CfnWebACLAssociation(this, 'ApiWebAclAssociation', {
      resourceArn: this.api.deploymentStage.stageArn,
      webAclArn: webAcl.attrArn,
    });

    // ============================================
    // Outputs
    // ============================================

    new cdk.CfnOutput(this, 'ApiGatewayUrl', {
      value: this.api.url,
      exportName: 'MarketingSaaSApiUrl',
    });

    new cdk.CfnOutput(this, 'MigrateFunctionName', {
      value: migrateLambda.functionName,
      description: 'Invoke this function once to create database tables',
    });
  }
}
