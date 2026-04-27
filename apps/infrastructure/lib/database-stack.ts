import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

export class DatabaseStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly database: rds.DatabaseInstance;
  public readonly idempotencyTable: dynamodb.TableV2;
  public readonly dbSecret: secretsmanager.ISecret;
  public readonly lambdaSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create the VPC for RDS
    this.vpc = new ec2.Vpc(this, 'MarketingSaaSVpc', {
      maxAzs: 2,
      natGateways: 1, // Minimize cost for dev, use 2+ for production
    });

    // Create the DynamoDB Idempotency Store (7-day TTL as per architecture plan)
    this.idempotencyTable = new dynamodb.TableV2(this, 'IdempotencyStore', {
      partitionKey: { name: 'Message_ID', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'ttl',
      billing: dynamodb.Billing.onDemand(),
      removalPolicy: cdk.RemovalPolicy.DESTROY, // For dev purposes only
    });

    // Create a Security Group for Lambda functions that need RDS access
    this.lambdaSecurityGroup = new ec2.SecurityGroup(this, 'LambdaSecurityGroup', {
      vpc: this.vpc,
      description: 'Security group for Lambda functions accessing RDS',
      allowAllOutbound: true,
    });

    // Create the RDS Security Group
    const rdsSecurityGroup = new ec2.SecurityGroup(this, 'RdsSecurityGroup', {
      vpc: this.vpc,
      description: 'Security group for the RDS PostgreSQL instance',
    });

    // Allow Lambda SG to reach RDS on port 5432
    rdsSecurityGroup.addIngressRule(
      this.lambdaSecurityGroup,
      ec2.Port.tcp(5432),
      'Allow Lambda functions to connect to RDS directly'
    );

    // Create the Amazon RDS PostgreSQL Single System of Record
    this.database = new rds.DatabaseInstance(this, 'MarketingSaaSDB', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16_3, // Modern postgres version
      }),
      vpc: this.vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroups: [rdsSecurityGroup],
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO), // Cost effective for base
      allocatedStorage: 20,
      maxAllocatedStorage: 100, // Autoscaling
      multiAz: false, // For dev, set to true for production
      publiclyAccessible: false,
      databaseName: 'marketingsaas',
      credentials: rds.Credentials.fromGeneratedSecret('marketingsaas_admin', {
        secretName: 'marketing-saas/rds-credentials',
      }),
      removalPolicy: cdk.RemovalPolicy.DESTROY, // For dev purposes only
    });

    // Store reference to the auto-generated secret
    this.dbSecret = this.database.secret!;

    // NOTE: RDS Proxy removed — not available on free-tier AWS accounts.
    // Lambdas connect directly to RDS. For production with high concurrency,
    // consider upgrading AWS plan and adding RDS Proxy back.

    // Outputs
    new cdk.CfnOutput(this, 'DynamoDbIdempotencyTableName', {
      value: this.idempotencyTable.tableName,
    });

    new cdk.CfnOutput(this, 'RdsEndpoint', {
      value: this.database.instanceEndpoint.hostname,
      exportName: 'MarketingSaaSRdsEndpoint',
    });
  }
}
