import { SQSEvent, SQSHandler } from 'aws-lambda';

// This Lambda is triggered by the SQS Billing Queue to asynchronously and idempotently process
// carrier events (Delivery, Bounces) and update the RDS ledger without double charging.
export const handler: SQSHandler = async (event: SQSEvent) => {
  console.log(`Received ${event.Records.length} billing events.`);

  for (const record of event.Records) {
    try {
      const messageBody = JSON.parse(record.body);
      
      // Usually, SES/SNS wraps the payload in a Message attribute
      const eventDetails = JSON.parse(messageBody.Message || '{}');
      const messageId = eventDetails.mail?.messageId || eventDetails.messageId;
      const workspaceId = eventDetails.tags?.workspace_id?.[0]; // SES VDM Tags
      const status = eventDetails.eventType || eventDetails.status;

      if (!messageId || !workspaceId) {
        console.warn('Missing essential tracking parameters. Skipping.', record.messageId);
        continue;
      }

      console.log(`Processing Event: ${messageId} | Status: ${status} | Workspace: ${workspaceId}`);

      // TODO:
      // 1. Check DynamoDB Idempotency Store
      //    const ddbParams = { TableName: process.env.IDEMPOTENCY_TABLE, Key: { Message_ID: { S: messageId }}};
      //    if (exists) -> return immediately (Idempotent bypass)
      
      // 2. Insert into DynamoDB with TTL
      // 3. Connect to RDS PostgreSQL
      // 4. Update the ledger
      //    IF 'Delivery' -> Execute CAPTURE (Move hold_credits -> deduct completely)
      //    IF 'Bounce'   -> Execute REFUND  (Move hold_credits -> available_credits)
      //    Update Transactions_Ledger status to 'COMPLETED'
      
      // 5. If bounce/complaint -> Add to Global Suppression List in RDS

    } catch (err) {
      console.error('Failed to process SQS record:', err);
      // Throwing an error ensures the message goes back to the queue or DLQ
      throw err; 
    }
  }
};
