import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as path from 'path';

export interface ContactIngestionStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  lambdaSecurityGroup: ec2.SecurityGroup;
  database: rds.DatabaseInstance;
  dbSecret: secretsmanager.ISecret;
}

export class ContactIngestionStack extends cdk.Stack {
  public readonly uploadBucket: s3.Bucket;
  public readonly ingestionStateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: ContactIngestionStackProps) {
    super(scope, id, props);

    // 1. Create secure S3 Bucket for CSV Uploads
    this.uploadBucket = new s3.Bucket(this, 'ContactUploadBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      lifecycleRules: [
        {
          // Automatically delete ingested CSVs after 3 days to minimize storage costs
          expiration: cdk.Duration.days(3),
        },
      ],
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
        },
      ],
      removalPolicy: cdk.RemovalPolicy.DESTROY, // For dev
    });

    // 2. Create the CSV Parser Lambda File (processes chunks of rows)
    const csvParserLambda = new lambdaNodejs.NodejsFunction(this, 'CsvParserFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../lambda/csv-parser.ts'),
      handler: 'handler',
      memorySize: 512,
      timeout: cdk.Duration.minutes(5),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.lambdaSecurityGroup],
      environment: {
        UPLOAD_BUCKET: this.uploadBucket.bucketName,
        DATABASE_URL: `postgresql://${props.database.instanceEndpoint.hostname}:5432/marketingsaas`,
      },
    });

    // Grant Lambda permission to read from the upload bucket and access RDS
    this.uploadBucket.grantRead(csvParserLambda);
    props.dbSecret.grantRead(csvParserLambda);


    // 3. Define the Step Function Tasks
    const parseChunkTask = new tasks.LambdaInvoke(this, 'Parse CSV Chunk', {
      lambdaFunction: csvParserLambda,
      outputPath: '$.Payload',
    });

    const successState = new sfn.Succeed(this, 'Ingestion Complete');
    const failState = new sfn.Fail(this, 'Ingestion Failed', {
      cause: 'CSV ingestion encountered an unrecoverable error',
      error: 'IngestionError',
    });

    // Add error catch to route failures to the fail state
    parseChunkTask.addCatch(failState);

    // Tie it together
    const definition = parseChunkTask.next(successState);

    // 4. Create the Step Function State Machine
    this.ingestionStateMachine = new sfn.StateMachine(this, 'ContactIngestionOrchestrator', {
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      stateMachineName: 'Contact-CSV-Ingestion-Flow',
    });

    // 5. Trigger Step Function when a CSV is uploaded to S3
    // Creates a Lambda that starts the state machine execution on S3 PutObject
    const triggerLambda = new lambdaNodejs.NodejsFunction(this, 'CsvUploadTrigger', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler',
      memorySize: 128,
      timeout: cdk.Duration.seconds(10),
      entry: path.join(__dirname, '../lambda/csv-upload-trigger.ts'),
      environment: {
        STATE_MACHINE_ARN: this.ingestionStateMachine.stateMachineArn,
      },
    });

    this.ingestionStateMachine.grantStartExecution(triggerLambda);

    this.uploadBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(triggerLambda),
      { suffix: '.csv' } // Only trigger on CSV files
    );
  }
}
