// ============================================
// Contact input normalization & validation
// Shared by the CSV import pipeline and the /contacts/import bulk API so
// every ingestion path produces the same canonical shape.
// ============================================

// Pragmatic RFC 5322 subset — rejects whitespace, multiple @, missing TLD
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const MAX_FIELD_LENGTH = 255;
const MAX_CUSTOM_FIELDS = 50;
const MAX_CUSTOM_VALUE_LENGTH = 1000;

/** Lowercased, trimmed email — or null if invalid. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (!email || email.length > 320 || !EMAIL_RE.test(email)) return null;
  return email;
}

/**
 * Canonical phone: digits with optional leading +; bare 10-digit US numbers
 * gain +1. Returns null when fewer than 10 digits remain.
 */
export function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) return null;
  if (trimmed.startsWith('+')) return `+${digits}`;
  return digits.length === 10 ? `+1${digits}` : `+${digits}`;
}

/** Trimmed, length-capped, control-character-free scalar string or null. */
export function normalizeName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const value = raw.replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (!value) return null;
  return value.substring(0, MAX_FIELD_LENGTH);
}

/**
 * Sanitize a custom-fields object: scalar values only (no nested
 * objects/arrays), capped count and value length. Anything else is dropped.
 */
export function sanitizeCustomFields(raw: unknown): Record<string, string | number | boolean> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string | number | boolean> = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= MAX_CUSTOM_FIELDS) break;
    const cleanKey = key.replace(/[^\w .-]/g, '').trim().substring(0, 100);
    if (!cleanKey) continue;
    if (typeof value === 'number' || typeof value === 'boolean') {
      out[cleanKey] = value;
    } else if (typeof value === 'string') {
      // eslint-disable-next-line no-control-regex
      out[cleanKey] = value.replace(/[\x00-\x1f\x7f]/g, '').substring(0, MAX_CUSTOM_VALUE_LENGTH);
    } else {
      continue; // nested objects/arrays/null dropped
    }
    count++;
  }
  return out;
}

export interface NormalizedContactInput {
  email: string | null;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  timezone: string | null;
  state: string | null;
  customFields: Record<string, string | number | boolean>;
}

/**
 * Normalize one raw imported row (CSV or API). Returns null when the row is
 * unreachable: no valid email AND no valid phone.
 */
export function normalizeContactRow(raw: Record<string, unknown>): NormalizedContactInput | null {
  const email = normalizeEmail(raw.email);
  const phone = normalizePhone(raw.phone);
  if (!email && !phone) return null;

  const state = normalizeName(raw.state);
  return {
    email,
    phone,
    firstName: normalizeName(raw.first_name ?? raw.firstName),
    lastName: normalizeName(raw.last_name ?? raw.lastName),
    company: normalizeName(raw.company),
    timezone: normalizeName(raw.timezone),
    state: state ? state.substring(0, 2).toUpperCase() : null,
    customFields: sanitizeCustomFields(raw.custom_fields ?? raw.customFields),
  };
}
