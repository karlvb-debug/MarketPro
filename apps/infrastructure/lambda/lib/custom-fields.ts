// ============================================
// Custom field definitions — loading and typed value validation.
// Used by the custom-fields API, every contact write path, and the rule
// engine's per-workspace field registry.
// ============================================

import { Pool } from 'pg';
import { normalizeEmail, normalizePhone } from './contact-validate';

export type CustomFieldType = 'text' | 'number' | 'date' | 'email' | 'phone' | 'url' | 'select';

export interface CustomFieldDef {
  fieldId: string;
  key: string;
  name: string;
  type: CustomFieldType;
  required: boolean;
  isUnique: boolean;
  options: string[] | null;
  archived: boolean;
}

const KEY_RE = /^[a-z][a-z0-9_]{0,99}$/;
const URL_RE = /^https?:\/\/[^\s]+$/i;

/** Derive a storage key from a display name: 'Plan Tier' -> 'plan_tier'. */
export function deriveKey(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^(\d)/, 'f$1')
    .substring(0, 100);
}

export function isValidKey(key: string): boolean {
  return KEY_RE.test(key);
}

export async function loadFieldDefinitions(pool: Pool, workspaceId: string): Promise<CustomFieldDef[]> {
  const result = await pool.query(
    `SELECT field_id, key, name, type, required, is_unique, options, archived
       FROM custom_field_definitions
      WHERE workspace_id = $1
      ORDER BY sort_order, created_at`,
    [workspaceId],
  );
  return result.rows.map((r) => ({
    fieldId: r.field_id,
    key: r.key,
    name: r.name,
    type: r.type,
    required: r.required,
    isUnique: r.is_unique,
    options: Array.isArray(r.options) ? r.options : null,
    archived: r.archived,
  }));
}

export interface CustomFieldValidation {
  /** Coerced values for keys with definitions + passthrough for undefined keys. */
  values: Record<string, string | number | boolean>;
  /** Per-key validation errors (strict callers reject; lenient callers drop). */
  errors: Record<string, string>;
  /** Required (non-archived) keys missing a value — enforced on create only. */
  missingRequired: string[];
}

/** Coerce one raw value against a definition; returns [value] or error string. */
function coerce(def: CustomFieldDef, raw: unknown): { ok: true; value: string | number } | { ok: false; error: string } {
  switch (def.type) {
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
      return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, error: 'must be a number' };
    }
    case 'date': {
      const s = String(raw).trim();
      const t = Date.parse(s);
      return Number.isNaN(t)
        ? { ok: false, error: 'must be a valid date' }
        : { ok: true, value: new Date(t).toISOString().substring(0, 10) };
    }
    case 'email': {
      const email = normalizeEmail(raw);
      return email ? { ok: true, value: email } : { ok: false, error: 'must be a valid email' };
    }
    case 'phone': {
      const phone = normalizePhone(raw);
      return phone ? { ok: true, value: phone } : { ok: false, error: 'must be a valid phone number' };
    }
    case 'url': {
      const s = String(raw).trim();
      return URL_RE.test(s) && s.length <= 2048
        ? { ok: true, value: s }
        : { ok: false, error: 'must be a valid http(s) URL' };
    }
    case 'select': {
      const s = String(raw).trim();
      return def.options?.includes(s)
        ? { ok: true, value: s }
        : { ok: false, error: `must be one of: ${(def.options ?? []).join(', ')}` };
    }
    case 'text':
    default: {
      const s = String(raw).substring(0, 1000);
      return { ok: true, value: s };
    }
  }
}

/**
 * Validate/coerce a raw custom-fields object against the workspace
 * definitions. Keys without a definition pass through untyped (sanitized
 * upstream); empty values clear the field.
 */
export function validateCustomFields(
  defs: CustomFieldDef[],
  raw: Record<string, unknown>,
  opts: { forCreate: boolean },
): CustomFieldValidation {
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const values: Record<string, string | number | boolean> = {};
  const errors: Record<string, string> = {};

  for (const [key, rawValue] of Object.entries(raw)) {
    const def = byKey.get(key);
    if (!def) {
      // No definition: passthrough (already sanitized by contact-validate)
      if (typeof rawValue === 'string' || typeof rawValue === 'number' || typeof rawValue === 'boolean') {
        values[key] = rawValue;
      }
      continue;
    }
    if (rawValue === null || rawValue === undefined || String(rawValue).trim() === '') {
      continue; // empty = clear/unset
    }
    const result = coerce(def, rawValue);
    if (result.ok) values[key] = result.value;
    else errors[key] = result.error;
  }

  const missingRequired = opts.forCreate
    ? defs
        .filter((d) => d.required && !d.archived && values[d.key] === undefined)
        .map((d) => d.key)
    : [];

  return { values, errors, missingRequired };
}

/**
 * Check unique custom-field constraints: returns the keys whose values
 * already exist on ANOTHER contact in the workspace.
 */
export async function findUniqueViolations(
  pool: Pool,
  workspaceId: string,
  defs: CustomFieldDef[],
  values: Record<string, string | number | boolean>,
  excludeContactId?: string,
): Promise<string[]> {
  const violations: string[] = [];
  for (const def of defs) {
    if (!def.isUnique || def.archived || values[def.key] === undefined) continue;
    const result = await pool.query(
      `SELECT 1 FROM contacts
        WHERE workspace_id = $1 AND custom_fields->>$2 = $3
          AND ($4::uuid IS NULL OR contact_id <> $4)
        LIMIT 1`,
      [workspaceId, def.key, String(values[def.key]), excludeContactId ?? null],
    );
    if (result.rows.length > 0) violations.push(def.key);
  }
  return violations;
}
