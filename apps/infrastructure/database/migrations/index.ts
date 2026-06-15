// ============================================
// Migration registry — append new migrations here, never edit applied ones.
//
// Rules:
// - ids are ordered lexicographically and applied in array order
// - each migration runs in its own transaction and is recorded in
//   schema_migrations; the runner never re-applies a recorded id
// - to add one: create NNNN-description.ts exporting { id, sql },
//   import it below, append to MIGRATIONS
// ============================================

import * as baseline from './0001-baseline';
import * as customFields from './0002-custom-fields-and-filter-indexes';
import * as dynamicSegments from './0003-dynamic-segments';
import * as engagementRollups from './0004-engagement-rollups';

export interface Migration {
  id: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  { id: baseline.id, sql: baseline.sql },
  { id: customFields.id, sql: customFields.sql },
  { id: dynamicSegments.id, sql: dynamicSegments.sql },
  { id: engagementRollups.id, sql: engagementRollups.sql },
];
