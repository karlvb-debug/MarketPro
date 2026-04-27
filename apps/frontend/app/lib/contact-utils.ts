// ============================================
// Contact Import Utilities
// CSV parsing, column mapping, data sanitization
// ============================================

export const SYSTEM_FIELDS = {
  firstName: { label: 'First Name', required: false },
  lastName: { label: 'Last Name', required: false },
  email: { label: 'Email Address', required: false },
  phone: { label: 'Phone Number', required: false },
  company: { label: 'Company', required: false },
  timezone: { label: 'Timezone', required: false },
} as const;

export type SystemFieldKey = keyof typeof SYSTEM_FIELDS;

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
