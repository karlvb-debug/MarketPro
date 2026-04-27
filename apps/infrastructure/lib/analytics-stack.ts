import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as athena from 'aws-cdk-lib/aws-athena';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as path from 'path';

export interface AnalyticsStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  lambdaSecurityGroup: ec2.SecurityGroup;
  database: rds.DatabaseInstance;
  dbSecret: secretsmanager.ISecret;
}

export class AnalyticsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AnalyticsStackProps) {
    super(scope, id, props);

    // 1. Data Lake S3 Bucket (Receives Firehose streams from SNS)
    const dataLakeBucket = new s3.Bucket(this, 'MarketingSaaSDataLake', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
    });

    // 2. Athena Query Results Bucket
    const athenaResultsBucket = new s3.Bucket(this, 'AthenaQueryResults', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [{ expiration: cdk.Duration.days(30) }] // Clean up temp query results
    });

    // 3. S3 Glacier Archive Bucket for TCPA consent records (4-year retention)
    const glacierArchiveBucket = new s3.Bucket(this, 'GlacierConsentArchive', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      lifecycleRules: [{
        transitions: [{
          storageClass: s3.StorageClass.GLACIER,
          transitionAfter: cdk.Duration.days(1), // Move to Glacier immediately
        }],
        expiration: cdk.Duration.days(1461), // 4 years (TCPA statute of limitations)
      }],
    });

    // 4. Glue Database for Data Lake Schema
    const glueDatabase = new glue.CfnDatabase(this, 'MarketingSaaSDataLakeDb', {
      catalogId: this.account,
      databaseInput: {
        name: 'marketingsaas_telemetry_db',
        description: 'Database for aggregated marketing engagement metrics',
      },
    });

    // 5. Athena Workgroup for logical grouping of dashboard queries
    const athenaWorkgroup = new athena.CfnWorkGroup(this, 'AppAthenaWorkgroup', {
      name: 'marketing-saas-dashboard-queries',
      workGroupConfiguration: {
        resultConfiguration: {
          outputLocation: `s3://${athenaResultsBucket.bucketName}/results/`,
        },
      },
    });

    // 6. Deploy the Right to Be Forgotten Lambda (GDPR compliance)
    const rtfLambda = new lambdaNodejs.NodejsFunction(this, 'RightToBeForgottenFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../lambda/right-to-be-forgotten.ts'),
      handler: 'handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.lambdaSecurityGroup],
      environment: {
        GLACIER_ARCHIVE_BUCKET: glacierArchiveBucket.bucketName,
        DATABASE_URL: `postgresql://${props.database.instanceEndpoint.hostname}:5432/marketingsaas`,
      },
    });

    // Grant RTF Lambda access to RDS and Glacier bucket
    props.dbSecret.grantRead(rtfLambda);

    glacierArchiveBucket.grantWrite(rtfLambda);

    // 7. Integrate RTF Lambda into an internal Admin API with IAM authentication
    // This endpoint MUST be secured — it triggers data deletion.
    const adminApi = new apigateway.RestApi(this, 'AdminComplianceApi', {
      restApiName: 'Internal Compliance API',
    });
    const privacyResource = adminApi.root.addResource('privacy').addResource('delete');
    privacyResource.addMethod('POST', new apigateway.LambdaIntegration(rtfLambda), {
      authorizationType: apigateway.AuthorizationType.IAM, // IAM auth required — no anonymous access
    });

    // Outputs
    new cdk.CfnOutput(this, 'DataLakeBucketName', {
      value: dataLakeBucket.bucketName,
    });
  }
}
