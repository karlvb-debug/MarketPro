// ============================================
// Typed readers for untrusted JSON request bodies.
//
// Request bodies arrive as `unknown`. These readers accept the first key that
// carries a value of the expected type, which is how the API tolerates both
// snake_case and camelCase spellings without ever trusting the shape.
// ============================================

export type JsonBody = Record<string, unknown>;

/** Parse a JSON request body, tolerating empty/invalid input as `{}`. */
export function parseBody(raw: string | null | undefined): JsonBody {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as JsonBody)
      : {};
  } catch {
    return {};
  }
}

/** First key holding a string. */
export function str(body: JsonBody, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = body[k];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

/** First key holding a finite number. */
export function num(body: JsonBody, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = body[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

/** First key holding a boolean. */
export function bool(body: JsonBody, ...keys: string[]): boolean | undefined {
  for (const k of keys) {
    const v = body[k];
    if (typeof v === 'boolean') return v;
  }
  return undefined;
}

/** First key holding an array of strings (rejects mixed arrays). */
export function strArray(body: JsonBody, ...keys: string[]): string[] | undefined {
  for (const k of keys) {
    const v = body[k];
    if (Array.isArray(v) && v.every((e) => typeof e === 'string')) return v as string[];
  }
  return undefined;
}

/**
 * First key that is present at all, as an opaque value. For jsonb columns,
 * where the payload is arbitrary JSON the API stores verbatim.
 */
export function raw(body: JsonBody, ...keys: string[]): unknown {
  for (const k of keys) {
    if (body[k] !== undefined) return body[k];
  }
  return undefined;
}

/** True when any of the keys is present (used to tell "absent" from "null"). */
export function has(body: JsonBody, ...keys: string[]): boolean {
  return keys.some((k) => body[k] !== undefined);
}

/** Rows affected by a drizzle write, which types this loosely. */
export function rowsAffected(result: unknown): number {
  const n = (result as { rowCount?: unknown } | null)?.rowCount;
  return typeof n === 'number' ? n : 0;
}
