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
  { key: 'firstName' as const, label: 'First Name', required: false, icon: '👤' },
  { key: 'lastName' as const, label: 'Last Name', required: false, icon: '👤' },
  { key: 'email' as const, label: 'Email Address', required: false, icon: '@' },
  { key: 'phone' as const, label: 'Phone Number', required: false, icon: '#' },
  { key: 'company' as const, label: 'Company', required: false, icon: '□' },
  { key: 'state' as const, label: 'State / Province', required: false, icon: '📍' },
  { key: 'timezone' as const, label: 'Timezone', required: false, icon: '🕐' },
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
  state: string;
  timezone: string;
  issues: ImportIssue[];
  skippedReason?: string;
}

// ---- XLSX Parsing ----
// Reads the first sheet of an .xlsx file and returns the same shape as parseCsv.
// Uses SheetJS (xlsx) — imported dynamically so it doesn't bloat the main bundle.

export async function parseXlsx(buffer: ArrayBuffer): Promise<{ headers: string[]; rows: string[][] }> {
  const XLSX = await import('xlsx');
  const workbook = XLSX.read(buffer, { type: 'array' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return { headers: [], rows: [] };
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) return { headers: [], rows: [] };

  // sheet_to_json with header:1 returns a 2D array (first row = headers)
  const raw = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, defval: '' });
  if (raw.length === 0) return { headers: [], rows: [] };

  const headers = (raw[0] ?? []).map((h) => String(h ?? '').trim());
  const rows = raw.slice(1).map((row) =>
    headers.map((_, i) => String(row[i] ?? '').trim())
  );

  // Filter out entirely empty rows
  const nonBlankRows = rows.filter((row) => row.some((cell) => cell !== ''));
  return { headers, rows: nonBlankRows };
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
  state: [/^state$/i, /province/i, /^st$/i, /region/i],
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
  const result: Record<string, string> = { firstName: '', lastName: '', email: '', phone: '', company: '', state: '', timezone: '' };

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
    if (!validateEmail(result.email)) {
      issues.push({ field: 'email', type: 'error', message: `Invalid email format: "${result.email}" — cleared` });
      result.email = ''; // don't store a bad email
    }
  }
  if (result.phone) {
    const original = result.phone;
    const { normalized, valid } = normalizePhone(result.phone);
    if (!valid) {
      issues.push({ field: 'phone', type: 'warning', message: `Phone could not be normalized: "${original}" — cleared`, original });
      result.phone = ''; // don't store a bad phone number
    } else {
      result.phone = normalized;
      if (normalized !== original) issues.push({ field: 'phone', type: 'fixed', message: 'Phone normalized to E.164', original, corrected: normalized });
    }
  }
  if (!result.email && !result.phone) issues.push({ field: 'email', type: 'warning', message: 'No valid email or phone — contact may be unreachable' });

  // Skip entirely if no identifier AND no name (nothing useful to store)
  if (!result.email && !result.phone && !result.firstName && !result.lastName) return null;

  return { firstName: result.firstName || '', lastName: result.lastName || '', email: result.email || '', phone: result.phone || '', company: result.company || '', state: result.state || '', timezone: result.timezone || '', issues };
}
