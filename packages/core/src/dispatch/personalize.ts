import * as crypto from 'crypto';
import { DispatchContact } from './types';

/**
 * Replace merge tags with contact fields. Supports both tag spellings that
 * exist in templates today ({{firstName}} and {{first_name}}).
 */
export function mergeTags(content: string, contact: DispatchContact): string {
  return content
    .replace(/{{\s*(firstName|first_name)\s*}}/g, contact.firstName || '')
    .replace(/{{\s*(lastName|last_name)\s*}}/g, contact.lastName || '')
    .replace(/{{\s*company\s*}}/g, contact.company || '');
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function emailSuppressionHash(contact: DispatchContact): string {
  return sha256((contact.email || '').toLowerCase().trim());
}

export function phoneSuppressionHash(contact: DispatchContact): string {
  return sha256((contact.phone || '').replace(/\D/g, ''));
}

/** Normalize to E.164, defaulting bare 10-digit numbers to +1 (US). */
export function toE164(phone: string): string {
  const trimmed = phone.trim();
  if (trimmed.startsWith('+')) return trimmed;
  const digits = trimmed.replace(/\D/g, '');
  return digits.length === 10 ? `+1${digits}` : `+${digits}`;
}
