import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import Stripe from 'stripe';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { accountBalances, transactionsLedger } from '../drizzle/schema';
import { eq, sql } from 'drizzle-orm';

// @ts-expect-error Stripe v22+ has updated type exports
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string);

let pool: Pool | null = null;
let db: ReturnType<typeof drizzle<Record<string, unknown>>> | null = null;

const getDbConnection = async () => {
    if (db) return db;
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    db = drizzle(pool);
    return db;
};

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const signature = event.headers['Stripe-Signature'] || event.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  try {
    if (!signature || !webhookSecret) {
      throw new Error('Missing Stripe Signature or Secret');
    }

    // 1. Verify the secure webhook payload using official Stripe library
    // We must pass the raw body string to constructEvent
    const stripeEvent = stripe.webhooks.constructEvent(event.body || '', signature, webhookSecret);

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

      // 2. Connect to database
      const currentDb = await getDbConnection();

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

          // Increment available_credits safely using raw SQL math within Drizzle to avoid race conditions
          // This replicates what the authorize_campaign_funds pl/pgsql function does!
          await tx.update(accountBalances)
            .set({ 
               availableCredits: sql`${accountBalances.availableCredits} + ${depositAmount}`,
               lastUpdatedAt: sql`CURRENT_TIMESTAMP`
            })
            .where(eq(accountBalances.workspaceId, workspaceId));
      });

      console.log(`Successfully completed deposit transaction for ${paymentIntent.id}`);
    }

    // Acknowledge receipt to Stripe
    return {
      statusCode: 200,
      body: JSON.stringify({ received: true }),
    };

  } catch (err: any) {
    console.error('Stripe webhook verification failed:', err);
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Webhook verification failed' }), // Don't leak err.message
    };
  }
};
