// ============================================
// Nightly Billing Reconciliation
// EventBridge cron → sweeps authorization holds older than 72h that were
// never fully settled (delivery receipts lost, campaign halted, etc.) and
// returns the unsettled remainder to available_credits.
// See lambda/lib/billing.ts releaseStaleAuthorizations for the ledger math.
// ============================================

import { getPool } from './lib/db';
import { releaseStaleAuthorizations } from '@repo/core/billing';
import { Logger } from '@repo/core/logger';

const STALE_HOURS = 72;

export const handler = async (): Promise<{ swept: number; releasedTotal: string }> => {
  const logger = new Logger({ handler: 'reconcile-billing' });
  const pool = await getPool();

  const summary = await releaseStaleAuthorizations(pool, STALE_HOURS);

  logger.info('Reconciliation sweep complete', {
    swept: summary.swept,
    releasedTotal: summary.releasedTotal,
    staleHours: STALE_HOURS,
  });

  return summary;
};
