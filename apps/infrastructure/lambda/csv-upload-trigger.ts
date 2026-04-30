import { S3Event } from 'aws-lambda';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';

const sfnClient = new SFNClient({});
const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN!;

// Triggered by S3 PutObject events on .csv files.
// Splits the uploaded file into chunk definitions and starts the Step Function.
export const handler = async (event: S3Event) => {
  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
    const fileSize = record.s3.object.size;

    console.log(`CSV uploaded: s3://${bucket}/${key} (${fileSize} bytes)`);

    // Pass the bucket and key to the Step Function. The parser Lambda will handle the full file.
    const input = {
      bucket,
      key,
    };

    // Start Step Function execution
    await sfnClient.send(new StartExecutionCommand({
      stateMachineArn: STATE_MACHINE_ARN,
      name: `csv-ingest-${Date.now()}-${key.replace(/[^a-zA-Z0-9]/g, '-')}`.slice(0, 80),
      input: JSON.stringify(input),
    }));

    console.log(`Started Step Function for ${key}`);
  }
};
