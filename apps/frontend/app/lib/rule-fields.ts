// ============================================
// Shared rule-field metadata — the single source of truth for the
// rule engine's field registry and operator matrix on the frontend.
//
// Mirrors apps/infrastructure/lambda/lib/rules.ts (CORE_FIELDS + OPS_BY_TYPE)
// so two surfaces stay in sync:
//   1. The contacts page filter chips (buildRulesFromFilters)
//   2. The reusable RuleBuilder component (Smart/dynamic segments)
//
// Keeping this in one place means an op or field added to the backend only
// needs to be reflected here once.
// ============================================

import type { CustomField, RuleOp, Segment } from './store/types';

/** Field value types — mirrors FieldType in lambda/lib/rules.ts. */
export type RuleFieldType =
  | 'text'
  | 'number'
  | 'date'
  | 'email'
  | 'phone'
  | 'url'
  | 'select'
  | 'enum'
  | 'segment';

export interface RuleFieldDef {
  /** Server rule field name (e.g. 'first_name', 'custom.<key>', 'in_segment'). */
  field: string;
  /** Human label shown in pickers. */
  label: string;
  type: RuleFieldType;
  /** Allowed values for enum/select fields. */
  options?: string[];
}

// ---- Operator matrix — mirrors OPS_BY_TYPE in lambda/lib/rules.ts ----
// 'segment' is a frontend-only pseudo-type for the in_segment/not_in_segment
// membership fields; on the wire those fields use op 'eq' with a segment uuid.
export const OPS_BY_TYPE: Record<RuleFieldType, RuleOp[]> = {
  text: ['eq', 'neq', 'contains', 'starts_with', 'ends_with', 'is_set', 'not_set', 'in', 'not_in'],
  email: ['eq', 'neq', 'contains', 'starts_with', 'ends_with', 'is_set', 'not_set', 'in', 'not_in'],
  phone: ['eq', 'neq', 'contains', 'starts_with', 'is_set', 'not_set'],
  url: ['eq', 'neq', 'contains', 'is_set', 'not_set'],
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'is_set', 'not_set'],
  date: ['gt', 'gte', 'lt', 'lte', 'between', 'within_days', 'is_set', 'not_set'],
  select: ['eq', 'neq', 'in', 'not_in', 'is_set', 'not_set'],
  enum: ['eq', 'neq', 'in', 'not_in'],
  segment: ['eq'],
};

/** Human-friendly operator labels for dropdowns. */
export const OP_LABELS: Record<RuleOp, string> = {
  eq: 'equals',
  neq: 'does not equal',
  contains: 'contains',
  starts_with: 'starts with',
  ends_with: 'ends with',
  is_set: 'is set',
  not_set: 'is not set',
  gt: 'greater than',
  gte: 'greater than or equal',
  lt: 'less than',
  lte: 'less than or equal',
  between: 'between',
  within_days: 'within the last (days)',
  in: 'is any of',
  not_in: 'is none of',
};

/** Ops that require no value input. */
export const VALUELESS_OPS: ReadonlySet<RuleOp> = new Set<RuleOp>(['is_set', 'not_set']);
/** Ops that take a list of values. */
export const MULTI_VALUE_OPS: ReadonlySet<RuleOp> = new Set<RuleOp>(['in', 'not_in']);

// Guardrails — must match MAX_DEPTH / MAX_CONDITIONS in lambda/lib/rules.ts.
export const MAX_DEPTH = 5;
export const MAX_CONDITIONS = 50;

// ---- Core field registry — mirrors CORE_FIELDS in lambda/lib/rules.ts ----
const STATUS_VALUES = ['active', 'unsubscribed', 'bounced', 'complained'];
const CONSENT_VALUES = [
  'collected_by_us',
  'partner_with_proof',
  'existing_customers',
  'purchased_list',
  'unknown',
];

/** Guaranteed non-undefined fallback field (used when a registry is empty). */
export const FALLBACK_RULE_FIELD: RuleFieldDef = { field: 'first_name', label: 'First Name', type: 'text' };

export const CORE_RULE_FIELDS: RuleFieldDef[] = [
  { field: 'first_name', label: 'First Name', type: 'text' },
  { field: 'last_name', label: 'Last Name', type: 'text' },
  { field: 'email', label: 'Email', type: 'email' },
  { field: 'phone', label: 'Phone', type: 'phone' },
  { field: 'company', label: 'Company', type: 'text' },
  { field: 'state', label: 'State', type: 'text' },
  { field: 'timezone', label: 'Timezone', type: 'text' },
  { field: 'source', label: 'Source', type: 'text' },
  { field: 'status', label: 'Status', type: 'enum', options: STATUS_VALUES },
  { field: 'consent_source', label: 'Consent Source', type: 'enum', options: CONSENT_VALUES },
  { field: 'created_at', label: 'Created Date', type: 'date' },
  { field: 'updated_at', label: 'Updated Date', type: 'date' },
  { field: 'in_segment', label: 'In Segment', type: 'segment' },
  { field: 'not_in_segment', label: 'Not In Segment', type: 'segment' },
];

/** Custom-field type → rule field type. */
function customFieldType(cf: CustomField): RuleFieldType {
  // CustomField.type already aligns with the backend's typed custom fields.
  return cf.type as RuleFieldType;
}

/**
 * Build the full field registry for the rule builder: core fields plus the
 * non-archived custom fields (labeled "Custom: <name>", field "custom.<key>").
 */
export function buildRuleFieldRegistry(customFields: CustomField[]): RuleFieldDef[] {
  const custom: RuleFieldDef[] = (customFields || [])
    .filter((cf) => !cf.archived)
    .map((cf) => ({
      field: `custom.${cf.key}`,
      label: `Custom: ${cf.name}`,
      type: customFieldType(cf),
      options: cf.type === 'select' && Array.isArray(cf.options) ? cf.options : undefined,
    }));
  return [...CORE_RULE_FIELDS, ...custom];
}

/** Lookup a single field definition by its server field name. */
export function findRuleField(field: string, registry: RuleFieldDef[]): RuleFieldDef | undefined {
  return registry.find((f) => f.field === field);
}

/** Default operator for a field type (first in its OPS list). */
export function defaultOpForType(type: RuleFieldType): RuleOp {
  return OPS_BY_TYPE[type][0] ?? 'eq';
}

/** Friendly label for a segment uuid (used by the membership value picker). */
export function segmentLabel(segmentId: string, segments: Segment[]): string {
  return segments.find((s) => s.segmentId === segmentId)?.name || 'Select segment…';
}
