'use client';

import { useState, useMemo, useCallback } from 'react';
import { useStore, Contact, SuppressionReason, getOverallStatus } from '../lib/store';
import Toolbar from '../components/Toolbar';
import DataTable from '../components/DataTable';
import EmptyState from '../components/EmptyState';
import Modal from '../components/Modal';
import { FormField, FormInput, FormSelect, FormActions, CheckboxChip } from '../components/FormElements';
import { showToast } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';
import ContactCard from '../components/ContactCard';
import SegmentPanel from '../components/SegmentPanel';
import ImportWizard from '../components/ImportWizard';
import { validatePhone } from '../lib/contact-utils';

export default function ContactsPage() {
  const {
    contacts, segments, settings, addContact, updateContact, updateCompliance, deleteContact,
    importContacts, bulkDeleteContacts, addContactsToSegment, removeContactsFromSegment, hydrated,
  } = useStore();
  const confirm = useConfirm();

  const [showAddModal, setShowAddModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showBulkSegmentModal, setShowBulkSegmentModal] = useState(false);
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [activeSegmentId, setActiveSegmentId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [panelOpen, setPanelOpen] = useState(true);
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', phone: '', company: '', timezone: '', segments: [] as string[] });

  // ---- FILTERS ----
  interface ActiveFilter {
    id: string;
    field: string;
    operator: 'contains' | 'equals' | 'starts_with' | 'is_empty' | 'is_not_empty';
    value: string;
  }
  const [filters, setFilters] = useState<ActiveFilter[]>([]);
  const [showFilterMenu, setShowFilterMenu] = useState(false);

  const filterableFields = useMemo(() => {
    const system = [
      { key: 'firstName', label: 'First Name', type: 'text' as const },
      { key: 'lastName', label: 'Last Name', type: 'text' as const },
      { key: 'email', label: 'Email', type: 'text' as const },
      { key: 'phone', label: 'Phone', type: 'text' as const },
      { key: 'company', label: 'Company', type: 'text' as const },
      { key: 'timezone', label: 'Timezone', type: 'text' as const },
      { key: 'source', label: 'Source', type: 'text' as const },
      { key: 'status', label: 'Status', type: 'select' as const, options: ['active', 'suppressed', 'dnc'] },
      { key: 'segments', label: 'Segment', type: 'select' as const, options: segments.map((s) => s.name) },
    ];
    const custom = (settings.customFields || []).map((cf) => ({
      key: `custom:${cf.key}`,
      label: cf.name,
      type: cf.type === 'select' ? 'select' as const : 'text' as const,
      options: cf.options,
    }));
    return [...system, ...custom];
  }, [segments, settings.customFields]);

  const addFilter = (fieldKey: string) => {
    setFilters((prev) => [...prev, { id: crypto.randomUUID(), field: fieldKey, operator: 'contains', value: '' }]);
    setShowFilterMenu(false);
  };
  const updateFilter = (id: string, patch: Partial<ActiveFilter>) => {
    setFilters((prev) => prev.map((f) => f.id === id ? { ...f, ...patch } : f));
  };
  const removeFilter = (id: string) => { setFilters((prev) => prev.filter((f) => f.id !== id)); };
  const clearFilters = () => setFilters([]);

  const activeSegment = activeSegmentId ? segments.find((s) => s.segmentId === activeSegmentId) || null : null;

  // Filter contacts by active segment
  const segmentContacts = useMemo(() => {
    if (!activeSegment) return contacts;
    return contacts.filter((c) => c.segments.includes(activeSegment.name));
  }, [contacts, activeSegment]);

  // Filter contacts by search + filters
  const displayContacts = useMemo(() => {
    let list = segmentContacts;
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((c) =>
        `${c.firstName} ${c.lastName}`.toLowerCase().includes(q) ||
        c.email.toLowerCase().includes(q) ||
        c.phone.includes(q) ||
        (c.company || '').toLowerCase().includes(q)
      );
    }
    for (const f of filters) {
      if (f.operator !== 'is_empty' && f.operator !== 'is_not_empty' && !f.value) continue;
      list = list.filter((c) => {
        let fieldValue = '';
        if (f.field === 'status') {
          fieldValue = getOverallStatus(c.compliance);
        } else if (f.field === 'segments') {
          const v = f.value.toLowerCase();
          if (f.operator === 'contains') return c.segments.some((s) => s.toLowerCase().includes(v));
          if (f.operator === 'equals') return c.segments.some((s) => s.toLowerCase() === v);
          if (f.operator === 'is_empty') return c.segments.length === 0;
          if (f.operator === 'is_not_empty') return c.segments.length > 0;
          return true;
        } else if (f.field.startsWith('custom:')) {
          const customKey = f.field.replace('custom:', '');
          fieldValue = c.customFields?.[customKey] || '';
        } else {
          fieldValue = String((c as any)[f.field] || '');
        }
        const val = fieldValue.toLowerCase();
        const target = f.value.toLowerCase();
        switch (f.operator) {
          case 'contains': return val.includes(target);
          case 'equals': return val === target;
          case 'starts_with': return val.startsWith(target);
          case 'is_empty': return !val;
          case 'is_not_empty': return !!val;
          default: return true;
        }
      });
    }
    return list;
  }, [segmentContacts, search, filters]);

  // Selection
  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    const allIds = displayContacts.map((c) => c.contactId);
    const allSelected = allIds.length > 0 && allIds.every((id) => selectedIds.has(id));
    setSelectedIds(allSelected ? new Set() : new Set(allIds));
  };

  // Handlers
  const handleAddContact = (e: React.FormEvent) => {
    e.preventDefault();
    if (form.phone) {
      const result = validatePhone(form.phone);
      if (!result.valid) { showToast(result.error, 'error'); return; }
      form.phone = result.normalized;
    }
    const segs = activeSegment && !form.segments.includes(activeSegment.name)
      ? [...form.segments, activeSegment.name] : form.segments;
    const error = addContact({ ...form, segments: segs, source: 'manual' });
    if (error) { showToast(error, 'error'); return; }
    showToast(`Contact ${form.firstName} ${form.lastName} added`);
    setForm({ firstName: '', lastName: '', email: '', phone: '', company: '', timezone: '', segments: [] });
    setShowAddModal(false);
  };

  const handleBulkAddToSegment = (segName: string) => {
    addContactsToSegment(Array.from(selectedIds), segName);
    showToast(`${selectedIds.size} contacts added to "${segName}"`);
    setSelectedIds(new Set());
    setShowBulkSegmentModal(false);
  };

  const handleBulkRemoveFromSegment = () => {
    if (!activeSegment) return;
    removeContactsFromSegment(Array.from(selectedIds), activeSegment.name);
    showToast(`${selectedIds.size} contacts removed from "${activeSegment.name}"`);
    setSelectedIds(new Set());
  };

  const toggleFormSegment = (segName: string) => {
    setForm((prev) => ({
      ...prev,
      segments: prev.segments.includes(segName)
        ? prev.segments.filter((s) => s !== segName) : [...prev.segments, segName],
    }));
  };

  if (!hydrated) return null;

  const viewTitle = activeSegment ? activeSegment.name : 'All Contacts';
  const viewCount = displayContacts.length;

  return (
    <>
      <div className="contacts-layout">
        {panelOpen && <div className="sp-mobile-overlay" onClick={() => setPanelOpen(false)} />}

        <SegmentPanel
          activeSegmentId={activeSegmentId}
          onSelectSegment={(id) => { setActiveSegmentId(id); setSelectedIds(new Set()); }}
        />

        <div className="contacts-content">
          <Toolbar
            title={viewTitle}
            count={viewCount}
            search={search}
            onSearchChange={setSearch}
            searchPlaceholder="Search contacts..."
            onTogglePanel={() => setPanelOpen(!panelOpen)}
            panelOpen={panelOpen}
            actions={
              <>
                <button
                  className={`btn btn-sm ${filters.length > 0 ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setShowFilterMenu(!showFilterMenu)}
                >
                  ⧩ Filter{filters.length > 0 ? ` (${filters.length})` : ''}
                </button>
                <button className="btn btn-secondary btn-sm" onClick={() => setShowImportModal(true)}>
                  Import CSV / Excel
                </button>
                <button className="btn btn-primary btn-sm" onClick={() => setShowAddModal(true)}>
                  + Add Contact
                </button>
              </>
            }
            bulkBar={selectedIds.size > 0 ? (
              <>
                <span className="text-sm text-secondary">{selectedIds.size} selected</span>
                <button className="btn btn-secondary btn-xs" onClick={() => setShowBulkSegmentModal(true)}>
                  Add to Segment
                </button>
                {activeSegment && (
                  <button className="btn btn-secondary btn-xs" onClick={handleBulkRemoveFromSegment}>
                    Remove from {activeSegment.name}
                  </button>
                )}
                <button className="btn btn-danger btn-xs" onClick={async () => {
                  const ok = await confirm(
                    `Permanently delete ${selectedIds.size} contact${selectedIds.size !== 1 ? 's' : ''}? This cannot be undone.`,
                    { title: 'Delete Contacts', variant: 'danger', confirmLabel: `Delete ${selectedIds.size}` }
                  );
                  if (ok) {
                    const ids = Array.from(selectedIds);
                    bulkDeleteContacts(ids);
                    showToast(`${ids.length} contact${ids.length !== 1 ? 's' : ''} deleted`);
                    setSelectedIds(new Set());
                  }
                }}>
                  🗑 Delete {selectedIds.size}
                </button>
              </>
            ) : undefined}
          />

          {/* Filter bar */}
          {(filters.length > 0 || showFilterMenu) && (
            <div className="filter-bar">
              {filters.map((f) => {
                const fieldDef = filterableFields.find((ff) => ff.key === f.field);
                return (
                  <div key={f.id} className="filter-chip">
                    <span className="filter-chip-label">{fieldDef?.label || f.field}</span>
                    <select
                      className="filter-chip-operator"
                      value={f.operator}
                      onChange={(e) => updateFilter(f.id, { operator: e.target.value as any })}
                    >
                      <option value="contains">contains</option>
                      <option value="equals">equals</option>
                      <option value="starts_with">starts with</option>
                      <option value="is_empty">is empty</option>
                      <option value="is_not_empty">is not empty</option>
                    </select>
                    {f.operator !== 'is_empty' && f.operator !== 'is_not_empty' && (
                      fieldDef?.type === 'select' && fieldDef.options ? (
                        <select className="filter-chip-value" value={f.value} onChange={(e) => updateFilter(f.id, { value: e.target.value })}>
                          <option value="">Select...</option>
                          {fieldDef.options.map((opt) => (<option key={opt} value={opt}>{opt}</option>))}
                        </select>
                      ) : (
                        <input className="filter-chip-value" type="text" placeholder="Value..." value={f.value} onChange={(e) => updateFilter(f.id, { value: e.target.value })} autoFocus />
                      )
                    )}
                    <button className="filter-chip-remove" onClick={() => removeFilter(f.id)} title="Remove filter">×</button>
                  </div>
                );
              })}
              <div className="filter-add-wrapper">
                <button className="filter-add-btn" onClick={() => setShowFilterMenu(!showFilterMenu)}>+ Add Filter</button>
                {showFilterMenu && (
                  <div className="filter-dropdown">
                    {filterableFields.map((ff) => (
                      <button key={ff.key} className="filter-dropdown-item" onClick={() => addFilter(ff.key)}>{ff.label}</button>
                    ))}
                  </div>
                )}
              </div>
              {filters.length > 0 && (
                <button className="filter-clear-btn" onClick={clearFilters}>Clear All</button>
              )}
            </div>
          )}

          {displayContacts.length === 0 ? (
            <EmptyState
              icon={search ? '🔍' : '👥'}
              title={search ? 'No matches found' : 'No contacts yet'}
              description={search ? 'Try a different search term or clear your filters.' : 'Add your first contact or import a CSV or Excel file to get started.'}
            >
              {!search && (
                <button className="btn btn-primary btn-sm" onClick={() => setShowAddModal(true)}>
                  + Add Contact
                </button>
              )}
            </EmptyState>
          ) : (
            <DataTable headers={['', 'Name', 'Email', 'Phone', 'Company', 'Segments']}>
              <tr>
                <th style={{ width: '40px', padding: '0 var(--space-3)' }}>
                  <input
                    type="checkbox"
                    title="Select all"
                    checked={displayContacts.length > 0 && displayContacts.every((c) => selectedIds.has(c.contactId))}
                    ref={(el) => {
                      if (el) el.indeterminate = selectedIds.size > 0 && !displayContacts.every((c) => selectedIds.has(c.contactId));
                    }}
                    onChange={toggleSelectAll}
                  />
                </th>
                <th>Name</th>
                <th className="hide-mobile">Email</th>
                <th className="hide-mobile">Phone</th>
                <th className="hide-mobile">Company</th>
                <th className="hide-mobile">Segments</th>
              </tr>
              {displayContacts.map((c) => (
                <tr key={c.contactId}>
                  <td style={{ width: '40px' }}>
                    <input type="checkbox" checked={selectedIds.has(c.contactId)} onChange={() => toggleSelect(c.contactId)} />
                  </td>
                  <td>
                    <button
                      onClick={() => setSelectedContact(c)}
                      style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontWeight: 500, padding: 0, textAlign: 'left' }}
                    >
                      {c.firstName} {c.lastName}
                    </button>
                  </td>
                  <td className="text-secondary hide-mobile">{c.email || '—'}</td>
                  <td className="text-secondary hide-mobile">{c.phone || '—'}</td>
                  <td className="text-secondary hide-mobile">{c.company || '—'}</td>
                  <td className="hide-mobile">
                    <div className="flex gap-1" style={{ flexWrap: 'wrap' }}>
                      {c.segments.map((s) => <span key={s} className="badge badge-subtle">{s}</span>)}
                    </div>
                  </td>
                </tr>
              ))}
            </DataTable>
          )}
        </div>

        {/* Contact detail card */}
        {selectedContact && (
          <ContactCard
            contact={selectedContact}
            onClose={() => setSelectedContact(null)}
            onUpdate={(id, patch) => {
              updateContact(id, patch);
              setSelectedContact((prev) => prev ? { ...prev, ...patch } : prev);
            }}
            onDelete={(id) => { deleteContact(id); setSelectedContact(null); showToast('Contact deleted'); }}
            onUpdateCompliance={(id, channel, reason, isDnc) => {
              setSelectedContact((prev) => {
                if (!prev || prev.contactId !== id) return prev;
                const compliance = { ...prev.compliance };
                if (isDnc) {
                  const ts = new Date().toISOString();
                  compliance.email = { suppressed: true, reason: 'dnc', updatedAt: ts };
                  compliance.sms = { suppressed: true, reason: 'dnc', updatedAt: ts };
                  compliance.voice = { suppressed: true, reason: 'dnc', updatedAt: ts };
                } else if (reason === 'none') {
                  compliance[channel] = { suppressed: false, reason: 'none', updatedAt: new Date().toISOString() };
                } else {
                  compliance[channel] = { suppressed: true, reason, updatedAt: new Date().toISOString() };
                }
                return { ...prev, compliance };
              });
            }}
          />
        )}
      </div>

      {/* ===== ADD CONTACT MODAL ===== */}
      <Modal isOpen={showAddModal} onClose={() => setShowAddModal(false)} title="Add New Contact">
        <form onSubmit={handleAddContact}>
          <div className="form-grid-2">
            <FormField label="First Name" required><FormInput placeholder="Sarah" required value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} /></FormField>
            <FormField label="Last Name" required><FormInput placeholder="Chen" required value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} /></FormField>
          </div>
          <FormField label="Email Address"><FormInput type="email" placeholder="sarah@example.com" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></FormField>
          <FormField label="Phone Number"><FormInput type="tel" inputMode="tel" pattern="[\+\d\s\-\(\)]{7,}" placeholder="+15551234567" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></FormField>
          <FormField label="Company"><FormInput placeholder="Acme Corp" value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} /></FormField>
          <FormField label="Timezone">
            <FormSelect value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
              <option value="">Auto-detect from area code</option>
              <option value="America/New_York">Eastern (ET)</option>
              <option value="America/Chicago">Central (CT)</option>
              <option value="America/Denver">Mountain (MT)</option>
              <option value="America/Los_Angeles">Pacific (PT)</option>
            </FormSelect>
          </FormField>
          <FormField label="Segments">
            <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
              {segments.map((seg) => <CheckboxChip key={seg.segmentId} label={seg.name} checked={form.segments.includes(seg.name)} onChange={() => toggleFormSegment(seg.name)} />)}
            </div>
          </FormField>
          {activeSegment && !form.segments.includes(activeSegment.name) && (
            <div className="info-box mb-4" style={{ fontSize: 'var(--text-xs)' }}>
              This contact will also be added to <strong>{activeSegment.name}</strong> since you&apos;re viewing that segment.
            </div>
          )}
          <FormActions>
            <button type="button" className="btn btn-secondary" onClick={() => setShowAddModal(false)}>Cancel</button>
            <button type="submit" className="btn btn-primary">Add Contact</button>
          </FormActions>
        </form>
      </Modal>

      {/* ===== IMPORT WIZARD ===== */}
      <ImportWizard
        isOpen={showImportModal}
        onClose={() => setShowImportModal(false)}
        activeSegmentName={activeSegment?.name}
        importContacts={importContacts}
      />

      {/* ===== BULK ADD TO SEGMENT MODAL ===== */}
      <Modal isOpen={showBulkSegmentModal} onClose={() => setShowBulkSegmentModal(false)} title="Add to Segment" width="400px">
        <p className="text-secondary mb-5" style={{ fontSize: 'var(--text-sm)' }}>
          Choose a segment to add {selectedIds.size} selected contact{selectedIds.size > 1 ? 's' : ''} to:
        </p>
        <div className="segment-pick-list">
          {segments.map((seg) => (
            <button key={seg.segmentId} className="segment-pick-item" onClick={() => handleBulkAddToSegment(seg.name)}>
              <span>{seg.name}</span>
              <span className="text-tertiary" style={{ fontSize: 'var(--text-xs)' }}>{seg.count} contacts</span>
            </button>
          ))}
          {segments.length === 0 && (
            <p className="text-tertiary" style={{ fontSize: 'var(--text-sm)', textAlign: 'center', padding: 'var(--space-6)' }}>
              No segments yet. Create one from the panel on the left.
            </p>
          )}
        </div>
      </Modal>
    </>
  );
}
