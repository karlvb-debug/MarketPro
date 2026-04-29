import { SQSEvent, SQSHandler } from 'aws-lambda';
import { Pool } from 'pg';

// ============================================
// Idempotent Billing Capture Lambda
// Triggered by the SQS Billing Queue to process carrier delivery/bounce events.
// Uses DynamoDB for idempotency and SELECT FOR UPDATE for billing atomicity.
// ============================================

let pool: Pool | null = null;

async function getPool(): Promise<Pool> {
  if (pool) return pool;

  const secretArn = process.env.DATABASE_SECRET_ARN;
  const dbHost = process.env.DATABASE_HOST;
  const dbName = process.env.DATABASE_NAME || 'marketingsaas';

  let connectionString: string;

  if (secretArn) {
    const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
    const smClient = new SecretsManagerClient({});
    const secret = await smClient.send(new GetSecretValueCommand({ SecretId: secretArn }));
    const creds = JSON.parse(secret.SecretString || '{}');
    connectionString = `postgresql://${creds.username}:${encodeURIComponent(creds.password)}@${dbHost || creds.host}:${creds.port || 5432}/${dbName}`;
  } else {
    connectionString = process.env.DATABASE_URL || '';
  }

  pool = new Pool({
    connectionString,
    max: 1,
    idleTimeoutMillis: 60000,
    connectionTimeoutMillis: 10000,
    ssl: connectionString.includes('localhost') ? undefined : { rejectUnauthorized: false },
  });

  return pool;
}

export const handler: SQSHandler = async (event: SQSEvent) => {
  console.log(`Received ${event.Records.length} billing events.`);

  const idempotencyTable = process.env.IDEMPOTENCY_TABLE;
  let ddbClient: any = null;

  // Lazily init DynamoDB client for idempotency checks
  if (idempotencyTable) {
    const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
    ddbClient = new DynamoDBClient({});
  }

  const pg = await getPool();

  for (const record of event.Records) {
    try {
      const messageBody = JSON.parse(record.body);

      // SES/SNS wraps the payload in a Message attribute
      const eventDetails = JSON.parse(messageBody.Message || '{}');
      const messageId = eventDetails.mail?.messageId || eventDetails.messageId;
      const workspaceId = eventDetails.tags?.workspace_id?.[0];
      const eventType = (eventDetails.eventType || eventDetails.status || '').toLowerCase();

      if (!messageId || !workspaceId) {
        console.warn('Missing essential tracking parameters. Skipping.', record.messageId);
        continue;
      }

      console.log(`Processing Event: ${messageId} | Type: ${eventType} | Workspace: ${workspaceId}`);

      // 1. Idempotency Check — skip if we've already processed this messageId
      if (ddbClient && idempotencyTable) {
        const { GetItemCommand, PutItemCommand } = await import('@aws-sdk/client-dynamodb');

        const existing = await ddbClient.send(new GetItemCommand({
          TableName: idempotencyTable,
          Key: { Message_ID: { S: messageId } },
        }));

        if (existing.Item) {
          console.log(`Idempotent skip: ${messageId} already processed.`);
          continue;
        }

        // Insert idempotency key with 7-day TTL
        const ttl = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
        await ddbClient.send(new PutItemCommand({
          TableName: idempotencyTable,
          Item: {
            Message_ID: { S: messageId },
            processed_at: { S: new Date().toISOString() },
            ttl: { N: String(ttl) },
          },
        }));
      }

      // 2. Atomic billing update using SELECT FOR UPDATE to prevent race conditions
      const client = await pg.connect();
      try {
        await client.query('BEGIN');

        // Lock the workspace balance row — serializes concurrent writes
        const balanceResult = await client.query(
          'SELECT available_credits, hold_credits FROM account_balances WHERE workspace_id = $1 FOR UPDATE',
          [workspaceId]
        );

        if (balanceResult.rows.length === 0) {
          console.warn(`No account_balances row for workspace ${workspaceId}. Skipping billing.`);
          await client.query('ROLLBACK');
          continue;
        }

        const { available_credits, hold_credits } = balanceResult.rows[0];
        const perMessageCost = 0.01; // TODO: look up from workspace pricing config

        if (eventType === 'delivery' || eventType === 'delivered' || eventType === 'send') {
          // CAPTURE: deduct from hold → finalize the charge
          const newHold = Math.max(0, parseFloat(hold_credits) - perMessageCost);
          await client.query(
            'UPDATE account_balances SET hold_credits = $1, last_updated_at = NOW() WHERE workspace_id = $2',
            [newHold.toFixed(6), workspaceId]
          );

          await client.query(
            `INSERT INTO transactions_ledger (workspace_id, type, amount, reference_id, status)
             VALUES ($1, 'CAPTURE', $2, $3, 'COMPLETED')`,
            [workspaceId, perMessageCost.toFixed(6), messageId]
          );
        } else if (eventType === 'bounce' || eventType === 'complaint' || eventType === 'reject') {
          // REFUND: move from hold → available
          const newHold = Math.max(0, parseFloat(hold_credits) - perMessageCost);
          const newAvailable = parseFloat(available_credits) + perMessageCost;
          await client.query(
            'UPDATE account_balances SET hold_credits = $1, available_credits = $2, last_updated_at = NOW() WHERE workspace_id = $3',
            [newHold.toFixed(6), newAvailable.toFixed(6), workspaceId]
          );

          await client.query(
            `INSERT INTO transactions_ledger (workspace_id, type, amount, reference_id, status)
             VALUES ($1, 'REFUND', $2, $3, 'COMPLETED')`,
            [workspaceId, perMessageCost.toFixed(6), messageId]
          );

          // Add to suppression list for bounces/complaints
          if (eventType === 'bounce' || eventType === 'complaint') {
            const recipientEmail = eventDetails.mail?.destination?.[0];
            if (recipientEmail) {
              const crypto = await import('crypto');
              const emailHash = crypto.createHash('sha256').update(recipientEmail.toLowerCase()).digest('hex');
              const reason = eventType === 'bounce' ? 'bounce' : 'complaint';
              await client.query(
                `INSERT INTO suppression_list (workspace_id, email_hash, reason) VALUES ($1, $2, $3)
                 ON CONFLICT DO NOTHING`,
                [workspaceId, emailHash, reason]
              );
            }
          }
        }

        await client.query('COMMIT');
        console.log(`Billing ${eventType} processed for ${messageId}.`);
      } catch (txErr) {
        await client.query('ROLLBACK');
        throw txErr;
      } finally {
        client.release();
      }

    } catch (err) {
      console.error('Failed to process SQS record:', err);
      // Throwing ensures the message goes back to the queue or DLQ
      throw err;
    }
  }
};
