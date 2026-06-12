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

export interface Migration {
  id: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  { id: baseline.id, sql: baseline.sql },
];
