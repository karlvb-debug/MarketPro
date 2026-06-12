// ============================================
// Filter rule engine — JSON rule AST → parameterized SQL.
//
// One engine powers ad-hoc contact filtering (C1), dynamic segments (C2),
// saved views (C5), and campaign audience estimation. Safety properties:
// - only whitelisted fields compile (core registry + typed custom fields)
// - values are ALWAYS bound parameters, never interpolated
// - depth/size caps reject rule bombs
// - every compiled query is workspace-scoped by the caller
// ============================================

export type RuleOp =
  | 'eq' | 'neq'
  | 'contains' | 'starts_with' | 'ends_with'
  | 'is_set' | 'not_set'
  | 'gt' | 'gte' | 'lt' | 'lte' | 'between' | 'within_days'
  | 'in' | 'not_in';

export interface RuleCondition {
  field: string;
  op: RuleOp;
  value?: unknown;
}

export interface RuleGroup {
  combinator: 'and' | 'or';
  conditions: (RuleCondition | RuleGroup)[];
}

export type FieldType = 'text' | 'number' | 'date' | 'email' | 'phone' | 'url' | 'select' | 'enum';

export interface FieldDef {
  type: FieldType;
  /** SQL expression for the field, referencing the contacts table as c. */
  expr: string;
  /** Allowed values for enum/select fields (validated before binding). */
  allowedValues?: string[];
}

const MAX_DEPTH = 5;
const MAX_CONDITIONS = 50;

// Core contact field registry. Custom fields are merged in per-workspace.
const CORE_FIELDS: Record<string, FieldDef> = {
  email: { type: 'email', expr: 'c.email' },
  phone: { type: 'phone', expr: "regexp_replace(COALESCE(c.phone, ''), '\\D', '', 'g')" },
  first_name: { type: 'text', expr: 'c.first_name' },
  last_name: { type: 'text', expr: 'c.last_name' },
  company: { type: 'text', expr: 'c.company' },
  state: { type: 'text', expr: 'c.state' },
  timezone: { type: 'text', expr: 'c.timezone' },
  source: { type: 'text', expr: 'c.source' },
  status: {
    type: 'enum',
    expr: 'c.status::text',
    allowedValues: ['active', 'unsubscribed', 'bounced', 'complained'],
  },
  consent_source: {
    type: 'enum',
    expr: 'c.consent_source::text',
    allowedValues: ['collected_by_us', 'partner_with_proof', 'existing_customers', 'purchased_list', 'unknown'],
  },
  created_at: { type: 'date', expr: 'c.created_at' },
  updated_at: { type: 'date', expr: 'c.updated_at' },
  // Membership pseudo-fields (value = segment uuid); compiled as EXISTS
  in_segment: { type: 'text', expr: '__segment__' },
  not_in_segment: { type: 'text', expr: '__segment__' },
};

const OPS_BY_TYPE: Record<FieldType, RuleOp[]> = {
  text: ['eq', 'neq', 'contains', 'starts_with', 'ends_with', 'is_set', 'not_set', 'in', 'not_in'],
  email: ['eq', 'neq', 'contains', 'starts_with', 'ends_with', 'is_set', 'not_set', 'in', 'not_in'],
  phone: ['eq', 'neq', 'contains', 'starts_with', 'is_set', 'not_set'],
  url: ['eq', 'neq', 'contains', 'is_set', 'not_set'],
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'is_set', 'not_set'],
  date: ['gt', 'gte', 'lt', 'lte', 'between', 'within_days', 'is_set', 'not_set'],
  select: ['eq', 'neq', 'in', 'not_in', 'is_set', 'not_set'],
  enum: ['eq', 'neq', 'in', 'not_in'],
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CUSTOM_KEY_RE = /^[\w .-]{1,100}$/;

export class RuleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuleValidationError';
  }
}

export interface CustomFieldDefinition {
  key: string;
  type: 'text' | 'number' | 'date' | 'email' | 'phone' | 'url' | 'select';
  options?: string[] | null;
}

export interface CompiledRules {
  /** WHERE fragment with $N placeholders starting at `paramOffset + 1`. */
  text: string;
  params: unknown[];
}

interface CompileContext {
  fields: Record<string, FieldDef>;
  params: unknown[];
  paramOffset: number;
  conditionCount: number;
}

function bind(ctx: CompileContext, value: unknown): string {
  ctx.params.push(value);
  return `$${ctx.paramOffset + ctx.params.length}`;
}

/** Build the per-workspace field registry: core + custom.<key>. */
export function buildFieldRegistry(customDefs: CustomFieldDefinition[]): Record<string, FieldDef> {
  const registry: Record<string, FieldDef> = { ...CORE_FIELDS };
  for (const def of customDefs) {
    if (!CUSTOM_KEY_RE.test(def.key)) continue; // defensive: keys are validated at definition time
    const jsonExpr = `c.custom_fields->>'${def.key.replace(/'/g, "''")}'`;
    const expr =
      def.type === 'number'
        ? `(CASE WHEN ${jsonExpr} ~ '^-?\\d+(\\.\\d+)?$' THEN (${jsonExpr})::numeric ELSE NULL END)`
        : def.type === 'date'
          ? `(CASE WHEN ${jsonExpr} ~ '^\\d{4}-\\d{2}-\\d{2}' THEN (${jsonExpr})::timestamptz ELSE NULL END)`
          : jsonExpr;
    registry[`custom.${def.key}`] = {
      type: def.type,
      expr,
      allowedValues: def.type === 'select' && Array.isArray(def.options) ? def.options : undefined,
    };
  }
  return registry;
}

function asScalar(value: unknown, type: FieldType, field: string): string | number {
  if (type === 'number') {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) throw new RuleValidationError(`'${field}': numeric value required`);
    return n;
  }
  if (typeof value !== 'string' || value.length > 1000) {
    throw new RuleValidationError(`'${field}': string value required`);
  }
  if (type === 'date' && Number.isNaN(Date.parse(value))) {
    throw new RuleValidationError(`'${field}': invalid date value`);
  }
  return type === 'phone' ? value.replace(/\D/g, '') : value;
}

function compileCondition(cond: RuleCondition, ctx: CompileContext): string {
  ctx.conditionCount++;
  if (ctx.conditionCount > MAX_CONDITIONS) {
    throw new RuleValidationError(`Rules exceed the maximum of ${MAX_CONDITIONS} conditions`);
  }

  const def = ctx.fields[cond.field];
  if (!def) throw new RuleValidationError(`Unknown field '${cond.field}'`);
  if (!OPS_BY_TYPE[def.type].includes(cond.op)) {
    throw new RuleValidationError(`Operator '${cond.op}' is not valid for field '${cond.field}' (${def.type})`);
  }

  // Membership pseudo-fields
  if (cond.field === 'in_segment' || cond.field === 'not_in_segment') {
    if (typeof cond.value !== 'string' || !UUID_RE.test(cond.value)) {
      throw new RuleValidationError(`'${cond.field}': segment id required`);
    }
    const exists = `EXISTS (SELECT 1 FROM contact_segment cs WHERE cs.contact_id = c.contact_id AND cs.segment_id = ${bind(ctx, cond.value)})`;
    return cond.field === 'in_segment' ? exists : `NOT ${exists}`;
  }

  const checkAllowed = (v: unknown) => {
    if (def.allowedValues && !def.allowedValues.includes(String(v))) {
      throw new RuleValidationError(`'${cond.field}': value '${String(v)}' is not an allowed option`);
    }
  };

  const expr = def.expr;
  switch (cond.op) {
    case 'is_set':
      return `(${expr} IS NOT NULL AND ${expr}::text <> '')`;
    case 'not_set':
      return `(${expr} IS NULL OR ${expr}::text = '')`;
    case 'eq': {
      checkAllowed(cond.value);
      return `${expr} = ${bind(ctx, asScalar(cond.value, def.type, cond.field))}`;
    }
    case 'neq': {
      checkAllowed(cond.value);
      return `(${expr} IS DISTINCT FROM ${bind(ctx, asScalar(cond.value, def.type, cond.field))})`;
    }
    case 'contains':
      return `${expr} ILIKE '%' || ${bind(ctx, asScalar(cond.value, 'text', cond.field))} || '%'`;
    case 'starts_with':
      return `${expr} ILIKE ${bind(ctx, asScalar(cond.value, 'text', cond.field))} || '%'`;
    case 'ends_with':
      return `${expr} ILIKE '%' || ${bind(ctx, asScalar(cond.value, 'text', cond.field))}`;
    case 'gt':
      return `${expr} > ${bind(ctx, asScalar(cond.value, def.type, cond.field))}`;
    case 'gte':
      return `${expr} >= ${bind(ctx, asScalar(cond.value, def.type, cond.field))}`;
    case 'lt':
      return `${expr} < ${bind(ctx, asScalar(cond.value, def.type, cond.field))}`;
    case 'lte':
      return `${expr} <= ${bind(ctx, asScalar(cond.value, def.type, cond.field))}`;
    case 'between': {
      if (!Array.isArray(cond.value) || cond.value.length !== 2) {
        throw new RuleValidationError(`'${cond.field}': between requires [low, high]`);
      }
      const lo = bind(ctx, asScalar(cond.value[0], def.type, cond.field));
      const hi = bind(ctx, asScalar(cond.value[1], def.type, cond.field));
      return `${expr} BETWEEN ${lo} AND ${hi}`;
    }
    case 'within_days': {
      const days = typeof cond.value === 'number' ? cond.value : Number(cond.value);
      if (!Number.isInteger(days) || days < 0 || days > 36500) {
        throw new RuleValidationError(`'${cond.field}': within_days requires a non-negative integer`);
      }
      return `${expr} >= NOW() - (${bind(ctx, days)}::int * INTERVAL '1 day')`;
    }
    case 'in':
    case 'not_in': {
      if (!Array.isArray(cond.value) || cond.value.length === 0 || cond.value.length > 100) {
        throw new RuleValidationError(`'${cond.field}': ${cond.op} requires a non-empty array (max 100)`);
      }
      cond.value.forEach(checkAllowed);
      const list = cond.value.map((v) => bind(ctx, asScalar(v, def.type, cond.field))).join(', ');
      return cond.op === 'in' ? `${expr} IN (${list})` : `(${expr} IS NULL OR ${expr} NOT IN (${list}))`;
    }
    default: {
      const exhaustive: never = cond.op;
      throw new RuleValidationError(`Unsupported operator '${exhaustive}'`);
    }
  }
}

function compileGroup(group: RuleGroup, ctx: CompileContext, depth: number): string {
  if (depth > MAX_DEPTH) throw new RuleValidationError(`Rules exceed the maximum nesting depth of ${MAX_DEPTH}`);
  if (group.combinator !== 'and' && group.combinator !== 'or') {
    throw new RuleValidationError(`Invalid combinator '${String(group.combinator)}'`);
  }
  if (!Array.isArray(group.conditions) || group.conditions.length === 0) {
    throw new RuleValidationError('Rule groups must contain at least one condition');
  }
  const parts = group.conditions.map((node) =>
    'combinator' in node ? compileGroup(node, ctx, depth + 1) : compileCondition(node, ctx),
  );
  return `(${parts.join(` ${group.combinator.toUpperCase()} `)})`;
}

/**
 * Compile a rule tree to a parameterized WHERE fragment over `contacts c`.
 * `paramOffset` = number of $N parameters the caller has already used.
 * Throws RuleValidationError on any invalid input — nothing unvalidated
 * ever reaches the SQL text.
 */
export function compileRules(
  rules: RuleGroup,
  customDefs: CustomFieldDefinition[],
  paramOffset = 0,
): CompiledRules {
  const ctx: CompileContext = {
    fields: buildFieldRegistry(customDefs),
    params: [],
    paramOffset,
    conditionCount: 0,
  };
  const text = compileGroup(rules, ctx, 1);
  return { text, params: ctx.params };
}

/** Parse + structurally validate an untrusted rules payload. */
export function parseRules(raw: unknown): RuleGroup {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RuleValidationError('Rules must be an object with combinator and conditions');
  }
  return raw as RuleGroup; // structure is fully validated during compilation
}
