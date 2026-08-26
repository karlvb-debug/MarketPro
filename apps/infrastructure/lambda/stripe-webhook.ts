import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import Stripe from 'stripe';
import { accountBalances, transactionsLedger } from '@repo/core/schema';
import { sql } from 'drizzle-orm';
import { getDb } from './lib/db';

let stripeClient: Stripe.Stripe | null = null;
let webhookSecret: string | null = null;

/**
 * Resolve a secret value: prefer Secrets Manager (ARN env var),
 * fall back to a plaintext env var for local development only.
 */
async function resolveSecret(arnEnvVar: string, plainEnvVar: string): Promise<string> {
  const arn = process.env[arnEnvVar];
  if (arn) {
    const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
    const smClient = new SecretsManagerClient({});
    const secret = await smClient.send(new GetSecretValueCommand({ SecretId: arn }));
    if (!secret.SecretString) {
      throw new Error(`Secret ${arnEnvVar} resolved to an empty value`);
    }
    return secret.SecretString;
  }
  const plain = process.env[plainEnvVar];
  if (!plain) {
    throw new Error(`Neither ${arnEnvVar} nor ${plainEnvVar} is configured`);
  }
  return plain;
}

/** Lazily initialize the Stripe client and webhook secret (cached across warm starts). */
async function getStripe(): Promise<{ stripe: Stripe.Stripe; webhookSecret: string }> {
  if (!stripeClient || !webhookSecret) {
    const [secretKey, whSecret] = await Promise.all([
      resolveSecret('STRIPE_SECRET_ARN', 'STRIPE_SECRET_KEY'),
      resolveSecret('STRIPE_WEBHOOK_SECRET_ARN', 'STRIPE_WEBHOOK_SECRET'),
    ]);
    stripeClient = new Stripe(secretKey);
    webhookSecret = whSecret;
  }
  return { stripe: stripeClient, webhookSecret };
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const signature = event.headers['Stripe-Signature'] || event.headers['stripe-signature'];

  try {
    const { stripe, webhookSecret: whSecret } = await getStripe();

    if (!signature) {
      throw new Error('Missing Stripe-Signature header');
    }

    // 1. Verify the secure webhook payload using official Stripe library
    // We must pass the raw body string to constructEvent
    const stripeEvent = stripe.webhooks.constructEvent(event.body || '', signature, whSecret);

    if (stripeEvent.type === 'payment_intent.succeeded') {
      const paymentIntent = stripeEvent.data.object;

      // We encode the workspaceId into the Payment Intent metadata when the frontend creates the checkout session
      const workspaceId = paymentIntent.metadata?.workspace_id;

      if (!workspaceId) {
          console.error(`Payment Intent ${paymentIntent.id} has no workspace_id mapped.`);
          return { statusCode: 200, body: 'Ignored: No Workspace Mapped' }; // Return 200 so Stripe doesn't retry
      }

      console.log(`Processing ${paymentIntent.amount} deposit for Workspace ${workspaceId}`);

      // Amount is in cents, convert to standard numeric scalar (e.g. 5000 -> 50.00)
      const depositAmount = (paymentIntent.amount / 100).toString();

      // 2. Connect to database (credentials from Secrets Manager via shared client)
      const currentDb = await getDb();

      // 3. Execute the Double-Entry DEPOSIT Transaction using Drizzle ORM
      await currentDb.transaction(async (tx) => {
          // Add to Transactions Ledger as 'DEPOSIT'
          await tx.insert(transactionsLedger).values({
              workspaceId: workspaceId,
              type: 'DEPOSIT',
              amount: depositAmount,
              referenceId: paymentIntent.id,
              status: 'COMPLETED'
          });

          // Increment available_credits with SQL-side numeric math (race-safe).
          // UPSERT: a first-ever deposit must create the balance row rather
          // than silently updating zero rows.
          await tx.insert(accountBalances)
            .values({ workspaceId, availableCredits: depositAmount })
            .onConflictDoUpdate({
              target: accountBalances.workspaceId,
              set: {
                availableCredits: sql`${accountBalances.availableCredits} + ${depositAmount}`,
                lastUpdatedAt: sql`CURRENT_TIMESTAMP`,
              },
            });
      });

      console.log(`Successfully completed deposit transaction for ${paymentIntent.id}`);
    }

    // Acknowledge receipt to Stripe
    return {
      statusCode: 200,
      body: JSON.stringify({ received: true }),
    };

  } catch (err) {
    console.error('Stripe webhook verification failed:', err);
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Webhook verification failed' }), // Don't leak err.message
    };
  }
};
