'use client';

import { useState, useMemo, useCallback, useEffect } from 'react';
import { useStore, Contact, SuppressionReason, getOverallStatus } from '../lib/store';
import Toolbar from '../components/Toolbar';
import DataTable from '../components/DataTable';
import { Button, EmptyState, Modal, Field, Input, Select, Checkbox, FormActions, showToast } from '../components/ui';
import { useConfirm } from '../components/ConfirmDialog';
import ContactCard from '../components/ContactCard';
import SegmentPanel from '../components/SegmentPanel';
import ImportWizard from '../components/ImportWizard';
import { validatePhone } from '../lib/contact-utils';

export default function ContactsPage() {
  const {
    contacts, segments, settings, addContact, updateContact, updateCompliance, deleteContact,
    importContacts, bulkDeleteContacts, addContactsToSegment, removeContactsFromSegment, hydrated,
    refreshContacts,
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
  const [showBulkEditModal, setShowBulkEditModal] = useState(false);
  const [bulkEditData, setBulkEditData] = useState({ company: '', state: '', timezone: '' });

  // ---- FILTERS ----
  interface ActiveFilter {
    id: string;
    field: string;
    operator: 'contains' | 'equals' | 'starts_with' | 'is_empty' | 'is_not_empty';
    value: string;
  }
  const [filters, setFilters] = useState<ActiveFilter[]>([]);
  const [showFilterMenu, setShowFilterMenu] = useState(false);

  // ---- SAVED VIEWS ----
  interface SavedView {
    id: string;
    name: string;
    filters: ActiveFilter[];
    segmentId: string | null;
  }
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const [showSaveViewInput, setShowSaveViewInput] = useState(false);
  const [newViewName, setNewViewName] = useState('');

  // Load saved views from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem('cliquey_saved_views');
      if (stored) setSavedViews(JSON.parse(stored));
    } catch { /* ignore */ }
  }, []);

  const persistViews = (views: SavedView[]) => {
    setSavedViews(views);
    localStorage.setItem('cliquey_saved_views', JSON.stringify(views));
  };

  const saveCurrentView = () => {
    if (!newViewName.trim()) return;
    const view: SavedView = {
      id: crypto.randomUUID(),
      name: newViewName.trim(),
      filters: filters.map(({ id, ...rest }) => ({ ...rest, id: crypto.randomUUID() })),
      segmentId: activeSegmentId,
    };
    persistViews([...savedViews, view]);
    setActiveViewId(view.id);
    setNewViewName('');
    setShowSaveViewInput(false);
    showToast(`View "${view.name}" saved`);
  };

  const loadView = (view: SavedView) => {
    setFilters(view.filters.map((f) => ({ ...f, id: crypto.randomUUID() })));
    setActiveSegmentId(view.segmentId);
    setActiveViewId(view.id);
    setSearch('');
  };

  const deleteView = (viewId: string) => {
    persistViews(savedViews.filter((v) => v.id !== viewId));
    if (activeViewId === viewId) setActiveViewId(null);
  };

  // Quick-filter presets
  const PRESETS = useMemo(() => [
    { label: 'Active', icon: '●', apply: () => {
      setFilters([{ id: crypto.randomUUID(), field: 'status', operator: 'equals' as const, value: 'active' }]);
      setActiveViewId(null);
    }},
    { label: 'Suppressed', icon: '⊘', apply: () => {
      setFilters([{ id: crypto.randomUUID(), field: 'status', operator: 'equals' as const, value: 'suppressed' }]);
      setActiveViewId(null);
    }},
    { label: 'No Email', icon: '@', apply: () => {
      setFilters([{ id: crypto.randomUUID(), field: 'email', operator: 'is_empty' as const, value: '' }]);
      setActiveViewId(null);
    }},
    { label: 'No Phone', icon: '#', apply: () => {
      setFilters([{ id: crypto.randomUUID(), field: 'phone', operator: 'is_empty' as const, value: '' }]);
      setActiveViewId(null);
    }},
    { label: 'No Segment', icon: '◫', apply: () => {
      setFilters([{ id: crypto.randomUUID(), field: 'segments', operator: 'is_empty' as const, value: '' }]);
      setActiveSegmentId(null);
      setActiveViewId(null);
    }},
  ], []);

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
  const handleAddContact = async (e: React.FormEvent) => {
    e.preventDefault();
    if (form.phone) {
      const result = validatePhone(form.phone);
      if (!result.valid) { showToast(result.error, 'error'); return; }
      form.phone = result.normalized;
    }
    const segs = activeSegment && !form.segments.includes(activeSegment.name)
      ? [...form.segments, activeSegment.name] : form.segments;
    const error = await addContact({ ...form, segments: segs, source: 'manual' });
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

  // ---- EXPORT CSV ----
  const exportCsv = useCallback(() => {
    const rows = selectedIds.size > 0
      ? displayContacts.filter((c) => selectedIds.has(c.contactId))
      : displayContacts;
    if (rows.length === 0) { showToast('No contacts to export', 'error'); return; }

    const headers = ['First Name', 'Last Name', 'Email', 'Phone', 'Company', 'State', 'Timezone', 'Source', 'Segments', 'Created'];
    const csvLines = [
      headers.join(','),
      ...rows.map((c) => [
        c.firstName, c.lastName, c.email, c.phone, c.company || '', c.state || '',
        c.timezone || '', c.source || '', (c.segments || []).join(';'),
        new Date(c.createdAt).toISOString(),
      ].map((v) => `"${(v || '').replace(/"/g, '""')}"`).join(',')),
    ];
    const blob = new Blob([csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `contacts_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`Exported ${rows.length} contacts`);
  }, [displayContacts, selectedIds]);

  // ---- BULK EDIT ----
  const handleBulkEdit = () => {
    const ids = Array.from(selectedIds);
    const patch: Partial<Contact> = {};
    if (bulkEditData.company.trim()) patch.company = bulkEditData.company.trim();
    if (bulkEditData.state.trim()) patch.state = bulkEditData.state.trim().toUpperCase().slice(0, 2);
    if (bulkEditData.timezone.trim()) patch.timezone = bulkEditData.timezone.trim();
    if (Object.keys(patch).length === 0) { showToast('No fields to update', 'error'); return; }
    for (const id of ids) {
      updateContact(id, patch);
    }
    showToast(`Updated ${ids.length} contacts`);
    setBulkEditData({ company: '', state: '', timezone: '' });
    setShowBulkEditModal(false);
    setSelectedIds(new Set());
  };

  if (!hydrated) return (
    <div className="contacts-layout">
      <div className="contacts-content" style={{ padding: 'var(--space-6)' }}>
        <div className="skeleton-bar" style={{ width: 200, height: 28, marginBottom: 'var(--space-4)' }} />
        <div className="skeleton-bar" style={{ width: '100%', height: 40, marginBottom: 'var(--space-3)' }} />
        {[...Array(6)].map((_, i) => (
          <div key={i} className="skeleton-bar" style={{ width: '100%', height: 36, marginBottom: 'var(--space-2)' }} />
        ))}
      </div>
    </div>
  );

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
                <Button
                  size="sm"
                  variant={filters.length > 0 ? 'primary' : 'secondary'}
                  onClick={() => setShowFilterMenu(!showFilterMenu)}
                >
                  ⧩ Filter{filters.length > 0 ? ` (${filters.length})` : ''}
                </Button>
                <Button size="sm" onClick={exportCsv} title="Export contacts as CSV">
                  ↓ Export
                </Button>
                <Button size="sm" onClick={() => setShowImportModal(true)}>
                  Import CSV / Excel
                </Button>
                <Button variant="primary" size="sm" onClick={() => setShowAddModal(true)}>
                  + Add Contact
                </Button>
              </>
            }
            bulkBar={selectedIds.size > 0 ? (
              <>
                <span className="text-sm text-secondary">{selectedIds.size} selected</span>
                <Button size="xs" onClick={() => setShowBulkSegmentModal(true)}>
                  Add to Segment
                </Button>
                <Button size="xs" onClick={() => { setShowBulkEditModal(true); setBulkEditData({ company: '', state: '', timezone: '' }); }}>
                  ✏ Edit
                </Button>
                <Button size="xs" onClick={exportCsv}>
                  ↓ Export Selected
                </Button>
                {activeSegment && (
                  <Button size="xs" onClick={handleBulkRemoveFromSegment}>
                    Remove from {activeSegment.name}
                  </Button>
                )}
                <Button variant="danger" size="xs" onClick={async () => {
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
                </Button>
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
              {filters.length > 0 && (
                <button
                  className="filter-save-btn"
                  onClick={() => setShowSaveViewInput(true)}
                  title="Save as view"
                >💾 Save View</button>
              )}
            </div>
          )}

          {/* Quick-filter presets + saved views */}
          {(savedViews.length > 0 || filters.length === 0) && (
            <div className="filter-presets-bar">
              <div className="filter-presets">
                {PRESETS.map((p) => (
                  <button
                    key={p.label}
                    className="filter-preset-btn"
                    onClick={p.apply}
                    title={p.label}
                  >
                    <span className="filter-preset-icon">{p.icon}</span>
                    {p.label}
                  </button>
                ))}
              </div>
              {savedViews.length > 0 && (
                <div className="saved-views">
                  <span className="saved-views-label">Views:</span>
                  {savedViews.map((v) => (
                    <div key={v.id} className={`saved-view-chip ${activeViewId === v.id ? 'saved-view-active' : ''}`}>
                      <button className="saved-view-name" onClick={() => loadView(v)}>{v.name}</button>
                      <button className="saved-view-delete" onClick={() => deleteView(v.id)} title="Delete view">×</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Save view input */}
          {showSaveViewInput && (
            <div className="filter-bar" style={{ gap: 'var(--space-2)' }}>
              <input
                className="filter-chip-value"
                type="text"
                placeholder="View name..."
                value={newViewName}
                onChange={(e) => setNewViewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') saveCurrentView(); if (e.key === 'Escape') setShowSaveViewInput(false); }}
                autoFocus
                style={{ flex: '1', minWidth: 120 }}
              />
              <Button size="xs" variant="primary" onClick={saveCurrentView} disabled={!newViewName.trim()}>Save</Button>
              <Button size="xs" onClick={() => setShowSaveViewInput(false)}>Cancel</Button>
            </div>
          )}

          {displayContacts.length === 0 ? (
            <EmptyState
              icon={search ? '🔍' : '👥'}
              title={search ? 'No matches found' : 'No contacts yet'}
              description={search ? 'Try a different search term or clear your filters.' : 'Add your first contact or import a CSV or Excel file to get started.'}
            >
              {!search && (
                <Button variant="primary" size="sm" onClick={() => setShowAddModal(true)}>
                  + Add Contact
                </Button>
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
                    <div className="flex gap-1 flex-wrap">
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
            segments={segments}
            onAddToSegment={(ids, segName) => {
              addContactsToSegment(ids, segName);
              setSelectedContact((prev) => prev ? { ...prev, segments: [...prev.segments, segName] } : prev);
            }}
            onRemoveFromSegment={(ids, segName) => {
              removeContactsFromSegment(ids, segName);
              setSelectedContact((prev) => prev ? { ...prev, segments: prev.segments.filter((s) => s !== segName) } : prev);
            }}
          />
        )}
      </div>

      {/* ===== ADD CONTACT MODAL ===== */}
      <Modal isOpen={showAddModal} onClose={() => setShowAddModal(false)} title="Add New Contact">
        <form onSubmit={handleAddContact}>
          <div className="form-grid-2">
            <Field label="First Name" required><Input placeholder="Sarah" required value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} /></Field>
            <Field label="Last Name" required><Input placeholder="Chen" required value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} /></Field>
          </div>
          <Field label="Email Address"><Input type="email" placeholder="sarah@example.com" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Phone Number"><Input type="tel" inputMode="tel" pattern="[\+\d\s\-\(\)]{7,}" placeholder="+15551234567" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
          <Field label="Company"><Input placeholder="Acme Corp" value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} /></Field>
          <Field label="Timezone">
            <Select value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
              <option value="">Auto-detect from area code</option>
              <option value="America/New_York">Eastern (ET)</option>
              <option value="America/Chicago">Central (CT)</option>
              <option value="America/Denver">Mountain (MT)</option>
              <option value="America/Los_Angeles">Pacific (PT)</option>
            </Select>
          </Field>
          <Field label="Segments">
            <div className="flex gap-2 flex-wrap">
              {segments.map((seg) => <Checkbox key={seg.segmentId} label={seg.name} checked={form.segments.includes(seg.name)} onChange={() => toggleFormSegment(seg.name)} />)}
            </div>
          </Field>
          {activeSegment && !form.segments.includes(activeSegment.name) && (
            <div className="info-box mb-4 text-xs" >
              This contact will also be added to <strong>{activeSegment.name}</strong> since you&apos;re viewing that segment.
            </div>
          )}
          <FormActions>
            <Button onClick={() => setShowAddModal(false)}>Cancel</Button>
            <Button variant="primary" type="submit">Add Contact</Button>
          </FormActions>
        </form>
      </Modal>

      {/* ===== IMPORT WIZARD ===== */}
      <ImportWizard
        isOpen={showImportModal}
        onClose={() => setShowImportModal(false)}
        activeSegmentName={activeSegment?.name}
        importContacts={importContacts}
        refreshContacts={refreshContacts}
      />

      {/* ===== BULK ADD TO SEGMENT MODAL ===== */}
      <Modal isOpen={showBulkSegmentModal} onClose={() => setShowBulkSegmentModal(false)} title="Add to Segment" width="400px">
        <p className="text-secondary mb-5 text-sm" >
          Choose a segment to add {selectedIds.size} selected contact{selectedIds.size > 1 ? 's' : ''} to:
        </p>
        <div className="segment-pick-list">
          {segments.map((seg) => (
            <button key={seg.segmentId} className="segment-pick-item" onClick={() => handleBulkAddToSegment(seg.name)}>
              <span>{seg.name}</span>
              <span className="text-tertiary text-xs" >{seg.count} contacts</span>
            </button>
          ))}
          {segments.length === 0 && (
            <p className="text-tertiary text-sm text-center p-6">
              No segments yet. Create one from the panel on the left.
            </p>
          )}
        </div>
      </Modal>

      {/* ===== BULK EDIT MODAL ===== */}
      <Modal isOpen={showBulkEditModal} onClose={() => setShowBulkEditModal(false)} title={`Edit ${selectedIds.size} Contact${selectedIds.size > 1 ? 's' : ''}`} width="420px">
        <p className="text-secondary mb-5 text-sm">
          Only non-empty fields will be updated. Leave blank to skip a field.
        </p>
        <Field label="Company">
          <Input
            placeholder="Set company for all selected..."
            value={bulkEditData.company}
            onChange={(e) => setBulkEditData({ ...bulkEditData, company: e.target.value })}
          />
        </Field>
        <Field label="State">
          <Input
            placeholder="e.g. CA, FL, TX"
            value={bulkEditData.state}
            onChange={(e) => setBulkEditData({ ...bulkEditData, state: e.target.value.toUpperCase().slice(0, 2) })}
            style={{ textTransform: 'uppercase', maxWidth: 80 }}
          />
        </Field>
        <Field label="Timezone">
          <Select value={bulkEditData.timezone} onChange={(e) => setBulkEditData({ ...bulkEditData, timezone: e.target.value })}>
            <option value="">— Don&apos;t change —</option>
            <option value="America/New_York">Eastern (ET)</option>
            <option value="America/Chicago">Central (CT)</option>
            <option value="America/Denver">Mountain (MT)</option>
            <option value="America/Los_Angeles">Pacific (PT)</option>
            <option value="America/Anchorage">Alaska (AKT)</option>
            <option value="Pacific/Honolulu">Hawaii (HST)</option>
          </Select>
        </Field>
        <FormActions>
          <Button onClick={() => setShowBulkEditModal(false)}>Cancel</Button>
          <Button variant="primary" onClick={handleBulkEdit}>
            Update {selectedIds.size} Contact{selectedIds.size > 1 ? 's' : ''}
          </Button>
        </FormActions>
      </Modal>
    </>
  );
}
