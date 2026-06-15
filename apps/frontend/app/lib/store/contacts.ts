'use client';

// ============================================
// Contacts domain slice — pagination state, CRUD,
// compliance updates, and CSV import handling.
// ============================================

import { useState, useCallback, useRef } from 'react';
import { api, ApiError, type BulkAction, type BulkSelection } from '../api-client';
import { contactToApi } from '../api-mappers';
import { showToast } from '../../components/ui/Toast';
import type {
  Contact,
  ContactsListResponse,
  RawContactRow,
  RuleCondition,
  RuleGroup,
  SetStoreData,
  StoreData,
  SuppressionReason,
} from './types';
import { defaultCompliance } from './seed';
import { loadFromApi } from './load';

interface ContactsSliceDeps {
  data: StoreData;
  setData: SetStoreData;
}

/** Server-derived engagement rollup fields — callers never set these directly. */
type EngagementField =
  | 'totalSent' | 'totalDelivered' | 'totalOpened' | 'totalClicked'
  | 'lastSentAt' | 'lastEngagedAt';

export interface ContactsFilter {
  search: string;
  segmentId: string | null;
  status: string;
  /** Rule tree built from the contacts page filter chips — when set, the
   *  list is served by POST /contacts/search instead of GET /contacts. */
  rules?: RuleGroup | null;
}

export function useContactsSlice({ data, setData }: ContactsSliceDeps) {
  // Pagination states
  const [contactsMeta, setContactsMeta] = useState({ total: 0, pageSize: 50, nextCursor: null as string | null, hasMore: false });
  const [contactsLoading, setContactsLoading] = useState(false);
  const [contactsFilter, setContactsFilter] = useState<ContactsFilter>({ search: '', segmentId: null, status: '', rules: null });

  // loadContacts definition
  const loadContacts = useCallback(async (reset: boolean = false) => {
    setContactsLoading(true);
    try {
      const cursor = reset ? undefined : contactsMeta.nextCursor;
      let res: ContactsListResponse | null;

      if (contactsFilter.rules) {
        // Server-side rule filtering — fold search text and the active
        // segment into the rule tree so all constraints apply together.
        const conditions: (RuleCondition | RuleGroup)[] = [contactsFilter.rules];
        if (contactsFilter.search) {
          conditions.push({
            combinator: 'or',
            conditions: ['email', 'first_name', 'last_name', 'company'].map((field) => ({
              field,
              op: 'contains' as const,
              value: contactsFilter.search,
            })),
          });
        }
        if (contactsFilter.segmentId) {
          conditions.push({ field: 'in_segment', op: 'eq', value: contactsFilter.segmentId });
        }
        res = await api.contacts.search({
          rules: { combinator: 'and', conditions },
          cursor: cursor || undefined,
          pageSize: contactsMeta.pageSize,
        }) as ContactsListResponse | null;
      } else {
        res = await api.contacts.list({
          pageSize: contactsMeta.pageSize,
          cursor: cursor || undefined,
          search: contactsFilter.search || undefined,
          status: contactsFilter.status || undefined,
          segmentId: contactsFilter.segmentId || undefined,
        }) as ContactsListResponse | null;
      }

      if (res && res.data) {
        const rawContacts = res.data || [];
        const newContacts: Contact[] = rawContacts.map((row) => {
          const status = row.status || 'active';
          const comp = defaultCompliance();
          if (status === 'unsubscribed') {
            const ts = row.updatedAt || row.updated_at || new Date().toISOString();
            comp.email = { suppressed: true, reason: 'unsubscribed', updatedAt: ts };
            comp.sms = { suppressed: true, reason: 'unsubscribed', updatedAt: ts };
            comp.voice = { suppressed: true, reason: 'unsubscribed', updatedAt: ts };
          } else if (status === 'bounced') {
            comp.email = { suppressed: true, reason: 'bounced', updatedAt: row.updatedAt || row.updated_at || new Date().toISOString() };
          } else if (status === 'complained') {
            comp.email = { suppressed: true, reason: 'complained', updatedAt: row.updatedAt || row.updated_at || new Date().toISOString() };
          }
          return {
            contactId: row.contactId || row.contact_id || crypto.randomUUID(),
            firstName: row.firstName || row.first_name || '',
            lastName: row.lastName || row.last_name || '',
            email: row.email || '',
            phone: row.phone || '',
            company: row.company || '',
            timezone: row.timezone || undefined,
            state: row.state || undefined,
            compliance: comp,
            segments: row.segments || [],
            source: row.source || '',
            consentSource: row.consentSource || row.consent_source || undefined,
            customFields: row.customFields || row.custom_fields || undefined,
            createdAt: row.createdAt || row.created_at || new Date().toISOString(),
            totalSent: row.totalSent ?? row.total_sent ?? 0,
            totalDelivered: row.totalDelivered ?? row.total_delivered ?? 0,
            totalOpened: row.totalOpened ?? row.total_opened ?? 0,
            totalClicked: row.totalClicked ?? row.total_clicked ?? 0,
            lastSentAt: row.lastSentAt ?? row.last_sent_at ?? null,
            lastEngagedAt: row.lastEngagedAt ?? row.last_engaged_at ?? null,
          };
        });

        setData((prev) => ({
          ...prev,
          contacts: reset ? newContacts : [...prev.contacts, ...newContacts],
        }));

        setContactsMeta({
          total: res.meta?.total || 0,
          pageSize: res.meta?.pageSize || 50,
          nextCursor: res.meta?.nextCursor || null,
          hasMore: res.meta?.hasMore || false,
        });
      }
    } catch (err) {
      console.error('[API] loadContacts failed:', err);
    } finally {
      setContactsLoading(false);
    }
  }, [contactsMeta.pageSize, contactsMeta.nextCursor, contactsFilter, setData]);

  // Create contact via API — returns error string on failure, null on success
  const addContact = useCallback(async (contact: Omit<Contact, 'contactId' | 'createdAt' | 'status' | 'compliance' | EngagementField>): Promise<string | null> => {
    // Local duplicate check (fast pre-flight)
    if (contact.email) {
      const emailMatch = data.contacts.find(
        (c) => c.email.toLowerCase() === contact.email.toLowerCase()
      );
      if (emailMatch) {
        return `A contact with email "${contact.email}" already exists (${emailMatch.firstName} ${emailMatch.lastName}).`;
      }
    }

    if (contact.phone) {
      const phoneNorm = contact.phone.replace(/\D/g, '');
      const phoneMatch = data.contacts.find(
        (c) => c.phone.replace(/\D/g, '') === phoneNorm
      );
      if (phoneMatch) {
        return `A contact with phone "${contact.phone}" already exists (${phoneMatch.firstName} ${phoneMatch.lastName}).`;
      }
    }

    // Create on server — server generates the canonical UUID
    try {
      const row = await api.contacts.create(contactToApi(contact)) as RawContactRow;
      const realContactId = row.contactId || row.contact_id;
      const newContact: Contact = {
        totalSent: 0,
        totalDelivered: 0,
        totalOpened: 0,
        totalClicked: 0,
        lastSentAt: null,
        lastEngagedAt: null,
        ...contact,
        contactId: realContactId || crypto.randomUUID(),
        compliance: defaultCompliance(),
        createdAt: row.createdAt || row.created_at || new Date().toISOString(),
      };

      // Associate with segments on the server
      if (realContactId && contact.segments && contact.segments.length > 0) {
        await Promise.all(
          contact.segments.map(async (segName) => {
            const seg = data.segments.find((s) => s.name === segName);
            if (seg) {
              await api.segments.addContacts(seg.segmentId, [realContactId]);
            }
          })
        );
      }

      setData((prev) => {
        const updatedSegments = prev.segments.map((seg) => ({
          ...seg,
          count: contact.segments.includes(seg.name) ? seg.count + 1 : seg.count,
        }));
        return { ...prev, contacts: [newContact, ...prev.contacts], segments: updatedSegments };
      });
      setContactsMeta((prev) => ({ ...prev, total: prev.total + 1 }));

      return null;
    } catch (err) {
      console.error('[API] Create contact failed:', err);
      // API failures throw ApiError-shaped objects, not Error instances.
      // POST /contacts surfaces typed custom-field problems:
      // 400 → { fieldErrors, missingRequired }, 409 → { fields }
      const apiErr = err as Partial<ApiError> | null;
      let message = apiErr?.message || 'Failed to create contact. Please try again.';
      if (apiErr?.fieldErrors && Object.keys(apiErr.fieldErrors).length > 0) {
        message += ` ${Object.entries(apiErr.fieldErrors).map(([key, msg]) => `${key}: ${msg}`).join('; ')}.`;
      }
      if (apiErr?.missingRequired && apiErr.missingRequired.length > 0) {
        message += ` Missing required field${apiErr.missingRequired.length > 1 ? 's' : ''}: ${apiErr.missingRequired.join(', ')}.`;
      }
      if (apiErr?.fields && apiErr.fields.length > 0) {
        message += ` Value${apiErr.fields.length > 1 ? 's' : ''} already in use: ${apiErr.fields.join(', ')}.`;
      }
      return message;
    }
  }, [data.contacts, data.segments, setData]);

  const updateContact = useCallback(async (contactId: string, patch: Partial<Omit<Contact, 'contactId' | 'createdAt'>>): Promise<string | null> => {
    // Snapshot for rollback, then optimistic local update
    let snapshot: Contact | undefined;
    setData((prev) => {
      snapshot = prev.contacts.find((c) => c.contactId === contactId);
      return {
        ...prev,
        contacts: prev.contacts.map((c) =>
          c.contactId === contactId ? { ...c, ...patch } : c
        ),
      };
    });

    // Persist to server — use returned row as canonical state
    try {
      const row = await api.contacts.update(contactId, contactToApi(patch)) as RawContactRow | null;
      if (row && (row.contactId || row.contact_id)) {
        setData((prev) => ({
          ...prev,
          contacts: prev.contacts.map((c) => {
            if (c.contactId !== contactId) return c;
            return {
              ...c,
              firstName: row.firstName || row.first_name || c.firstName,
              lastName: row.lastName || row.last_name || c.lastName,
              email: row.email || c.email,
              phone: row.phone || c.phone,
              company: row.company || c.company,
              timezone: row.timezone || c.timezone,
              state: row.state || c.state,
              consentSource: row.consentSource || row.consent_source || c.consentSource,
            };
          }),
        }));
      }
      return null;
    } catch (err) {
      console.error('[API] Update contact failed:', err);
      // Roll back the optimistic update — the server is the source of truth
      const restore = snapshot;
      if (restore) {
        setData((prev) => ({
          ...prev,
          contacts: prev.contacts.map((c) => (c.contactId === contactId ? restore : c)),
        }));
      }
      const message = (err as Partial<ApiError> | null)?.message || 'Failed to save contact — changes were reverted.';
      showToast(message, 'error');
      return message;
    }
  }, [setData]);

  const updateCompliance = useCallback(async (contactId: string, channel: 'email' | 'sms' | 'voice', reason: SuppressionReason, isDnc = false): Promise<string | null> => {
    // Snapshot for rollback, then optimistic local update
    let snapshot: Contact | undefined;
    setData((prev) => ({
      ...prev,
      contacts: prev.contacts.map((c) => {
        if (c.contactId !== contactId) return c;
        snapshot = c;
        const compliance = { ...c.compliance };
        if (isDnc) {
          // DNC suppresses ALL channels
          const ts = new Date().toISOString();
          compliance.email = { suppressed: true, reason: 'dnc', updatedAt: ts };
          compliance.sms = { suppressed: true, reason: 'dnc', updatedAt: ts };
          compliance.voice = { suppressed: true, reason: 'dnc', updatedAt: ts };
        } else if (reason === 'none') {
          // Restoring a channel
          compliance[channel] = { suppressed: false, reason: 'none', updatedAt: new Date().toISOString() };
        } else {
          compliance[channel] = { suppressed: true, reason, updatedAt: new Date().toISOString() };
        }
        return { ...c, compliance };
      }),
    }));

    // Persist to backend — map compliance reason → DB contact status
    // The contacts table status enum: active | unsubscribed | bounced | complained
    try {
      let dbStatus: string = 'active';
      if (isDnc || reason === 'dnc') {
        dbStatus = 'unsubscribed';
      } else if (reason === 'none') {
        dbStatus = 'active';
      } else if (reason === 'unsubscribed' || reason === 'stop') {
        dbStatus = 'unsubscribed';
      } else if (reason === 'bounced') {
        dbStatus = 'bounced';
      } else if (reason === 'complained') {
        dbStatus = 'complained';
      } else if (reason === 'invalid') {
        dbStatus = 'bounced'; // Map 'invalid' to 'bounced' — both block sends
      }

      await api.contacts.update(contactId, { status: dbStatus });
      return null;
    } catch (err) {
      console.error('[API] Update compliance failed:', err);
      // Roll back the optimistic compliance change
      const restore = snapshot;
      if (restore) {
        setData((prev) => ({
          ...prev,
          contacts: prev.contacts.map((c) => (c.contactId === contactId ? restore : c)),
        }));
      }
      const message = (err as Partial<ApiError> | null)?.message || 'Failed to update compliance — change was reverted.';
      showToast(message, 'error');
      return message;
    }
  }, [setData]);

  const deleteContact = useCallback(async (contactId: string) => {
    try {
      await api.contacts.delete(contactId);
      setData((prev) => {
        const deletedContact = prev.contacts.find((c) => c.contactId === contactId);
        const contactSegments = deletedContact?.segments || [];
        const updatedSegments = prev.segments.map((seg) => ({
          ...seg,
          count: contactSegments.includes(seg.name) ? Math.max(0, seg.count - 1) : seg.count,
        }));
        return {
          ...prev,
          contacts: prev.contacts.filter((c) => c.contactId !== contactId),
          segments: updatedSegments,
        };
      });
      setContactsMeta((prev) => ({ ...prev, total: Math.max(0, prev.total - 1) }));
    } catch (err) {
      console.error('[API] Delete contact failed:', err);
    }
  }, [setData]);

  // Bulk delete — single API call for up to 500 contacts
  const bulkDeleteContacts = useCallback(async (contactIds: string[]) => {
    if (contactIds.length === 0) return;
    try {
      await api.contacts.bulkDelete(contactIds);
      const idSet = new Set(contactIds);
      setData((prev) => {
        const deletedContacts = prev.contacts.filter((c) => idSet.has(c.contactId));
        const segmentDecrementMap = new Map<string, number>();
        for (const c of deletedContacts) {
          for (const s of (c.segments || [])) {
            segmentDecrementMap.set(s, (segmentDecrementMap.get(s) || 0) + 1);
          }
        }
        const updatedSegments = prev.segments.map((seg) => ({
          ...seg,
          count: Math.max(0, seg.count - (segmentDecrementMap.get(seg.name) || 0)),
        }));
        return {
          ...prev,
          contacts: prev.contacts.filter((c) => !idSet.has(c.contactId)),
          segments: updatedSegments,
        };
      });
      setContactsMeta((prev) => ({ ...prev, total: Math.max(0, prev.total - contactIds.length) }));
    } catch (err) {
      console.error('[API] Bulk delete failed:', err);
    }
  }, [setData]);

  // Reload segment counts from the server without disturbing other store
  // slices — used after bulk/merge operations that change membership.
  const refreshSegmentCounts = useCallback(async () => {
    const fresh = await loadFromApi();
    if (fresh) {
      setData((prev) => ({ ...prev, segments: fresh.segments }));
    }
  }, [setData]);

  // Selection-aware bulk action. `selection` is either explicit contactIds
  // ("the rows I checked") or a rule tree ("everything matching the filters").
  // On success: toast the affected count and refresh the contact list; for
  // membership/status-changing actions also refresh segment counts. Throws the
  // ApiError on failure (after toasting) so callers can react if they need to.
  const bulkAction = useCallback(async (
    selection: BulkSelection,
    action: BulkAction,
  ): Promise<{ affected: number }> => {
    try {
      const res = await api.contacts.bulk({ selection, action });
      const affected = res?.affected ?? 0;
      const noun = `contact${affected === 1 ? '' : 's'}`;
      const messages: Record<BulkAction['type'], string> = {
        add_segment: `Added ${affected} ${noun} to the segment`,
        remove_segment: `Removed ${affected} ${noun} from the segment`,
        set_custom_field: `Updated ${affected} ${noun}`,
        unsubscribe: `Unsubscribed ${affected} ${noun}`,
        delete: `Deleted ${affected} ${noun}`,
      };
      showToast(messages[action.type]);
      // Reload the visible page; segment membership / status changes also need
      // the segment counts refreshed so the left panel stays accurate.
      await loadContacts(true);
      if (action.type !== 'set_custom_field') {
        await refreshSegmentCounts();
      }
      return { affected };
    } catch (err) {
      console.error('[API] Bulk action failed:', err);
      const message = (err as Partial<ApiError> | null)?.message || 'Bulk action failed.';
      showToast(message, 'error');
      throw err;
    }
  }, [loadContacts, refreshSegmentCounts]);

  // Merge duplicates into a survivor (admin only). Survivor keeps its non-empty
  // fields; duplicates are deleted. On success toast the merged count and
  // refresh contacts + segment counts. Throws the ApiError on failure (after
  // toasting) so the duplicate-review UI can keep its modal open.
  const mergeContacts = useCallback(async (
    survivorId: string,
    duplicateIds: string[],
  ): Promise<{ survivorId: string; mergedCount: number }> => {
    try {
      const res = await api.contacts.merge({ survivorId, duplicateIds });
      const mergedCount = res?.mergedCount ?? 0;
      showToast(`Merged ${mergedCount} contact${mergedCount === 1 ? '' : 's'}`);
      await loadContacts(true);
      await refreshSegmentCounts();
      return { survivorId: res?.survivorId ?? survivorId, mergedCount };
    } catch (err) {
      console.error('[API] Merge contacts failed:', err);
      const message = (err as Partial<ApiError> | null)?.message || 'Merge failed.';
      showToast(message, 'error');
      throw err;
    }
  }, [loadContacts, refreshSegmentCounts]);

  // Guard against overlapping imports interleaving state mutations
  const importInFlightRef = useRef(false);

  // Returns counts plus `serverError` when persistence (partially) failed.
  // Local state is applied synchronously; the server upsert is awaited so
  // the caller can tell the user whether the import actually saved.
  const importContacts = useCallback(async (newContacts: Omit<Contact, 'contactId' | 'createdAt' | 'compliance' | EngagementField>[]): Promise<{ added: number; updated: number; skipped: number; blankSkipped: number; serverError: string | null }> => {
    if (importInFlightRef.current) {
      return { added: 0, updated: 0, skipped: 0, blankSkipped: 0, serverError: 'An import is already in progress — wait for it to finish.' };
    }
    importInFlightRef.current = true;
    let added = 0;
    let updated = 0;
    let skipped = 0;
    let blankSkipped = 0;

    const created: Contact[] = [];
    const updatedPayload: Contact[] = [];

    setData((prev) => {
      // Clone existing contacts for mutation
      const updatedContacts = [...prev.contacts];

      // Build lookup maps: normalized value → index in updatedContacts
      const emailIndex = new Map<string, number>();
      const phoneIndex = new Map<string, number>();
      updatedContacts.forEach((c, idx) => {
        const email = c.email?.toLowerCase().trim();
        const phone = c.phone?.replace(/\D/g, '');
        if (email) emailIndex.set(email, idx);
        if (phone) phoneIndex.set(phone, idx);
      });

      // Also track emails/phones added within THIS import to avoid intra-batch dupes
      const batchEmails = new Set<string>();
      const batchPhones = new Set<string>();

      for (const c of newContacts) {
        // Skip blank/unidentifiable contacts
        const hasEmail = c.email && c.email.trim();
        const hasPhone = c.phone && c.phone.trim();
        const hasName = (c.firstName && c.firstName.trim()) || (c.lastName && c.lastName.trim());
        if (!hasEmail && !hasPhone && !hasName) {
          blankSkipped++;
          continue;
        }

        const emailNorm = c.email?.toLowerCase().trim() || '';
        const phoneNorm = c.phone?.replace(/\D/g, '') || '';

        // Find an existing contact that matches by email OR phone
        let matchIdx = -1;
        if (emailNorm && emailIndex.has(emailNorm)) {
          matchIdx = emailIndex.get(emailNorm)!;
        } else if (phoneNorm && phoneIndex.has(phoneNorm)) {
          matchIdx = phoneIndex.get(phoneNorm)!;
        }

        if (matchIdx >= 0) {
          // UPDATE existing record — merge in new data (prefer non-empty values)
          const existing = updatedContacts[matchIdx];
          if (!existing) {
            // matchIdx points into the `created` batch — treat as duplicate, skip
            skipped++;
            continue;
          }
          const merged: Contact = {
            ...existing,
            firstName: c.firstName?.trim() || existing.firstName,
            lastName: c.lastName?.trim() || existing.lastName,
            email: emailNorm || existing.email,
            phone: phoneNorm ? c.phone : existing.phone,
            company: c.company?.trim() || existing.company || '',
            timezone: c.timezone?.trim() || existing.timezone || '',
            segments: [...new Set([...(existing.segments || []), ...(c.segments || [])])],
            customFields: (existing.customFields || c.customFields)
              ? { ...existing.customFields, ...c.customFields }
              : undefined,
          };
          updatedContacts[matchIdx] = merged;
          // Collect for API payload
          updatedPayload.push(merged);

          // Update indexes with the merged contact's values
          if (emailNorm) emailIndex.set(emailNorm, matchIdx);
          if (phoneNorm) phoneIndex.set(phoneNorm, matchIdx);
          updated++;
          continue;
        }

        // Check if this is a duplicate within the current batch
        if (emailNorm && batchEmails.has(emailNorm)) { skipped++; continue; }
        if (phoneNorm && batchPhones.has(phoneNorm)) { skipped++; continue; }

        // Track in batch dedup sets
        if (emailNorm) batchEmails.add(emailNorm);
        if (phoneNorm) batchPhones.add(phoneNorm);

        const newContact: Contact = {
          totalSent: 0,
          totalDelivered: 0,
          totalOpened: 0,
          totalClicked: 0,
          lastSentAt: null,
          lastEngagedAt: null,
          ...c,
          contactId: crypto.randomUUID(),
          compliance: defaultCompliance(),
          createdAt: new Date().toISOString(),
        };
        created.push(newContact);

        // Add to lookup maps so subsequent rows can match against this new contact
        const newIdx = updatedContacts.length + created.length - 1;
        if (emailNorm) emailIndex.set(emailNorm, newIdx);
        if (phoneNorm) phoneIndex.set(phoneNorm, newIdx);
        added++;
      }

      // Calculate how many contacts were added to each segment
      const segmentIncrementMap = new Map<string, number>();
      for (const c of created) {
        for (const s of (c.segments || [])) {
          segmentIncrementMap.set(s, (segmentIncrementMap.get(s) || 0) + 1);
        }
      }
      for (const merged of updatedPayload) {
        const emailNorm = merged.email?.toLowerCase().trim();
        const phoneNorm = merged.phone?.replace(/\D/g, '');
        const existing = prev.contacts.find(c =>
          (emailNorm && c.email?.toLowerCase().trim() === emailNorm) ||
          (phoneNorm && c.phone?.replace(/\D/g, '') === phoneNorm)
        );
        const existingSegs = new Set(existing?.segments || []);
        for (const s of (merged.segments || [])) {
          if (!existingSegs.has(s)) {
            segmentIncrementMap.set(s, (segmentIncrementMap.get(s) || 0) + 1);
          }
        }
      }

      const updatedSegments = prev.segments.map((seg) => ({
        ...seg,
        count: seg.count + (segmentIncrementMap.get(seg.name) || 0),
      }));

      return { ...prev, contacts: [...created, ...updatedContacts], segments: updatedSegments };
    });

    const allImports = [
      ...created.map((c) => contactToApi(c)),
      ...updatedPayload.map((c) => contactToApi(c)),
    ];

    let serverError: string | null = null;
    try {
      if (allImports.length > 0) {
        // Find segmentId from the first contact's segments
        let segmentId: string | undefined;
        const firstWithSegment = newContacts.find(c => c.segments && c.segments.length > 0);
        if (firstWithSegment && firstWithSegment.segments?.[0]) {
          const seg = data.segments.find(s => s.name === firstWithSegment.segments[0]);
          if (seg) segmentId = seg.segmentId;
        }

        const chunkSize = 1000;
        const chunks: Record<string, unknown>[][] = [];
        for (let i = 0; i < allImports.length; i += chunkSize) {
          chunks.push(allImports.slice(i, i + chunkSize));
        }
        // Await every chunk: the user must know whether the import saved.
        const results = await Promise.allSettled(
          chunks.map((chunk) => api.contacts.import(chunk, segmentId))
        );
        const failures = results.filter((r) => r.status === 'rejected');
        if (failures.length > 0) {
          const first = failures[0] as PromiseRejectedResult;
          const detail = (first.reason as Partial<ApiError> | null)?.message || 'server error';
          serverError = failures.length === chunks.length
            ? `Import failed to save: ${detail}`
            : `Import partially saved — ${failures.length} of ${chunks.length} batches failed (${detail}). Re-run the import to retry; existing contacts are deduplicated.`;
          console.error('[API] Import chunks failed:', failures);
        }
      }
    } finally {
      importInFlightRef.current = false;
    }

    return { added, updated, skipped, blankSkipped, serverError };
  }, [data.segments, setData]);

  return {
    contactsMeta,
    contactsLoading,
    contactsFilter,
    setContactsFilter,
    loadContacts,
    addContact,
    updateContact,
    updateCompliance,
    deleteContact,
    bulkDeleteContacts,
    bulkAction,
    mergeContacts,
    importContacts,
  };
}
