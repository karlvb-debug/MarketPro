// ============================================
// @repo/core — the portable half of MarketPro.
//
// Everything here is transport- and vendor-independent: it needs Postgres and
// nothing else. Both the Next route handlers and the dispatch worker import
// this one copy. Deep imports (`@repo/core/rules`) are also supported.
// ============================================

// Data access
export * from './db';
export * as schema from './schema';
export { runMigrations } from './migrate';
export { MIGRATIONS } from './database/migrations';

// Contact data model
export * from './rules';
export * from './custom-fields';
export * from './contact-validate';
export * from './segment-query';
export * from './bulk';
export * from './duplicates';
export * from './merge';
export * from './timeline';
export * from './engagement';
export * from './export';

// Compliance
export * from './consent';
export * from './gdpr';

// Money
export * from './billing';

// Campaigns & dispatch
export * from './campaign-launch';
export * from './dispatch/engine';
export * from './dispatch/errors';
export * from './dispatch/personalize';
export * from './dispatch/quiet-hours';
export * from './dispatch/store';
export * from './dispatch/types';

export { Logger } from './logger';
