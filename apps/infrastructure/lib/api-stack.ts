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
  frontendUrl?: string;
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
    // Authorizer Lambda — JWT verification only (no DB needed)
    // ============================================
    const authorizerLambda = new lambdaNodejs.NodejsFunction(this, 'WorkspaceAuthorizerFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../lambda/authorizer.ts'),
      handler: 'handler',
      memorySize: 128,
      timeout: cdk.Duration.seconds(5),
      environment: {
        USER_POOL_ID: props.userPool.userPoolId,
        APP_CLIENT_ID: props.userPoolClient.userPoolClientId,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
      },
    });

    const tokenAuthorizer = new apigateway.TokenAuthorizer(this, 'WorkspaceTokenAuthorizer', {
      handler: authorizerLambda,
      identitySource: apigateway.IdentitySource.header('Authorization'),
      resultsCacheTtl: cdk.Duration.seconds(300),
    });

    // ============================================
    // DB Migration Lambda (one-shot, manually invoked)
    // ============================================
    const migrateLambda = new lambdaNodejs.NodejsFunction(this, 'DbMigrateFunction', {
      ...commonLambdaProps,
      entry: path.join(__dirname, '../lambda/db-migrate.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
    });
    props.dbSecret.grantRead(migrateLambda);

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
    });
    props.dbSecret.grantRead(contactsLambda);

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

    const contactIdResource = contactsResource.addResource('{id}');
    contactIdResource.addMethod('GET', contactsIntegration, securedMethodOptions);
    contactIdResource.addMethod('PUT', contactsIntegration, securedMethodOptions);
    contactIdResource.addMethod('DELETE', contactsIntegration, securedMethodOptions);

    // ---- /segments ----
    const segmentsResource = this.api.root.addResource('segments');
    const segmentsIntegration = new apigateway.LambdaIntegration(segmentsLambda);
    segmentsResource.addMethod('GET', segmentsIntegration, securedMethodOptions);
    segmentsResource.addMethod('POST', segmentsIntegration, securedMethodOptions);

    const segmentIdResource = segmentsResource.addResource('{id}');
    segmentIdResource.addMethod('PUT', segmentsIntegration, securedMethodOptions);
    segmentIdResource.addMethod('DELETE', segmentsIntegration, securedMethodOptions);

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

    // ---- /batch (single call for all workspace data) ----
    const batchResource = this.api.root.addResource('batch');
    const batchIntegration = new apigateway.LambdaIntegration(batchLambda);
    batchResource.addMethod('GET', batchIntegration, securedMethodOptions);

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
