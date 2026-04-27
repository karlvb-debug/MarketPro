// ============================================
// Contact Import Utilities
// CSV parsing, column mapping, data sanitization
// ============================================

// ---- Phone Validation & Normalization ----
// Returns { valid: true, normalized: '+1...' } or { valid: false, error: 'message' }

export function validatePhone(raw: string): { valid: true; normalized: string } | { valid: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { valid: true, normalized: '' }; // empty is OK (optional field)

  const digits = trimmed.replace(/\D/g, '');

  if (digits.length < 7) {
    return { valid: false, error: 'Phone number is too short (minimum 7 digits).' };
  }

  // US/CA: 10 digits (no country code) or 11 starting with 1
  if (digits.length === 10) {
    return { valid: true, normalized: `+1${digits}` };
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    return { valid: true, normalized: `+${digits}` };
  }

  // International: 7-13 digits (E.164 max is 15 incl. country code, but real numbers are ≤13)
  if (digits.length > 13) {
    return { valid: false, error: `Phone number is too long (${digits.length} digits). US numbers should be 10 digits, international max 13.` };
  }

  // Normalize: add + prefix if missing
  const normalized = trimmed.startsWith('+') ? `+${digits}` : `+${digits}`;
  return { valid: true, normalized };
}

export const SYSTEM_FIELDS = [
  { key: 'firstName' as const, label: 'First Name', required: false },
  { key: 'lastName' as const, label: 'Last Name', required: false },
  { key: 'email' as const, label: 'Email Address', required: false },
  { key: 'phone' as const, label: 'Phone Number', required: false },
  { key: 'company' as const, label: 'Company', required: false },
  { key: 'timezone' as const, label: 'Timezone', required: false },
];

export type SystemFieldKey = typeof SYSTEM_FIELDS[number]['key'];

export interface ImportIssue {
  field: string;
  type: 'fixed' | 'warning' | 'error';
  message: string;
  original?: string;
  corrected?: string;
}

export interface ProcessedContact {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  company: string;
  timezone: string;
  issues: ImportIssue[];
}

export function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };

  const parse = (line: string): string[] => {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (inQuotes) {
        if (ch === '"') {
          if (i + 1 < line.length && line[i + 1] === '"') { current += '"'; i++; }
          else inQuotes = false;
        } else current += ch;
      } else {
        if (ch === '"') inQuotes = true;
        else if (ch === ',') { result.push(current.trim()); current = ''; }
        else current += ch;
      }
    }
    result.push(current.trim());
    return result;
  };

  const headers = parse(lines[0]!);
  const rows = lines.slice(1).map((line) => parse(line));
  return { headers, rows };
}

const FIELD_PATTERNS: Record<SystemFieldKey, RegExp[]> = {
  firstName: [/first.?name/i, /^first$/i, /^fname$/i, /^given/i],
  lastName: [/last.?name/i, /^last$/i, /^lname$/i, /^surname/i, /^family/i],
  email: [/e.?mail/i, /^email$/i, /email.?addr/i],
  phone: [/phone/i, /mobile/i, /cell/i, /tel/i, /number/i],
  company: [/company/i, /org/i, /business/i, /employer/i],
  timezone: [/timezone/i, /time.?zone/i, /tz/i],
};

export function guessColumnMapping(headers: string[]): Record<string, SystemFieldKey | ''> {
  const mapping: Record<string, SystemFieldKey | ''> = {};
  const usedFields = new Set<SystemFieldKey>();
  for (const header of headers) {
    let matched = false;
    for (const [field, patterns] of Object.entries(FIELD_PATTERNS) as [SystemFieldKey, RegExp[]][]) {
      if (usedFields.has(field)) continue;
      if (patterns.some((p) => p.test(header))) {
        mapping[header] = field;
        usedFields.add(field);
        matched = true;
        break;
      }
    }
    if (!matched) mapping[header] = '';
  }
  return mapping;
}

export function isBlankRow(row: Record<string, string>): boolean {
  return Object.values(row).every((v) => !v || v.trim() === '');
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/(?:^|\s|-)\w/g, (ch) => ch.toUpperCase());
}

function normalizePhone(phone: string): { normalized: string; valid: boolean } {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 0) return { normalized: '', valid: false };
  if (digits.length === 10) return { normalized: `+1${digits}`, valid: true };
  if (digits.length === 11 && digits.startsWith('1')) return { normalized: `+${digits}`, valid: true };
  if (digits.length >= 10 && digits.length <= 15) return { normalized: `+${digits}`, valid: true };
  return { normalized: phone, valid: false };
}

function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function processImportRow(
  values: string[],
  mapping: Record<string, SystemFieldKey | ''>,
): ProcessedContact | null {
  const issues: ImportIssue[] = [];
  const result: Record<string, string> = { firstName: '', lastName: '', email: '', phone: '', company: '', timezone: '' };

  const headers = Object.keys(mapping);
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i]!;
    const fieldKey = mapping[header];
    if (fieldKey && values[i]) result[fieldKey] = values[i]!.trim();
  }

  if (!result.email && !result.phone && !result.firstName && !result.lastName) return null;

  if (result.firstName) {
    const original = result.firstName;
    result.firstName = titleCase(result.firstName);
    if (result.firstName !== original) issues.push({ field: 'firstName', type: 'fixed', message: 'Name capitalized', original, corrected: result.firstName });
  }
  if (result.lastName) {
    const original = result.lastName;
    result.lastName = titleCase(result.lastName);
    if (result.lastName !== original) issues.push({ field: 'lastName', type: 'fixed', message: 'Name capitalized', original, corrected: result.lastName });
  }
  if (result.email) {
    result.email = result.email.toLowerCase();
    if (!validateEmail(result.email)) issues.push({ field: 'email', type: 'error', message: `Invalid email format: "${result.email}"` });
  }
  if (result.phone) {
    const original = result.phone;
    const { normalized, valid } = normalizePhone(result.phone);
    result.phone = normalized;
    if (!valid && result.phone) issues.push({ field: 'phone', type: 'warning', message: `Phone may be invalid: "${original}"`, original, corrected: normalized });
    else if (normalized !== original) issues.push({ field: 'phone', type: 'fixed', message: 'Phone normalized to E.164', original, corrected: normalized });
  }
  if (!result.email && !result.phone) issues.push({ field: 'email', type: 'warning', message: 'No email or phone — contact may be unreachable' });

  return { firstName: result.firstName || '', lastName: result.lastName || '', email: result.email || '', phone: result.phone || '', company: result.company || '', timezone: result.timezone || '', issues };
}
