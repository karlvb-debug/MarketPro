'use client';

import { useState, useMemo } from 'react';
import { useStore, Contact, SuppressionReason } from '../lib/store';
import PageHeader from '../components/PageHeader';
import DataTable from '../components/DataTable';
import EmptyState from '../components/EmptyState';
import Modal from '../components/Modal';
import { FormField, FormInput, FormSelect, FormActions, CheckboxChip } from '../components/FormElements';
import { showToast } from '../components/Toast';
import ContactCard from '../components/ContactCard';
import SegmentPanel from '../components/SegmentPanel';
import ImportWizard from '../components/ImportWizard';

export default function ContactsPage() {
  const {
    contacts, segments, addContact, updateContact, updateCompliance, deleteContact,
    importContacts, addContactsToSegment, removeContactsFromSegment, hydrated,
  } = useStore();

  const [showAddModal, setShowAddModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showBulkSegmentModal, setShowBulkSegmentModal] = useState(false);
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [activeSegmentId, setActiveSegmentId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [panelOpen, setPanelOpen] = useState(true);
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', phone: '', company: '', timezone: '', segments: [] as string[] });

  const activeSegment = activeSegmentId ? segments.find((s) => s.segmentId === activeSegmentId) || null : null;

  // Filter contacts by active segment
  const segmentContacts = useMemo(() => {
    if (!activeSegment) return contacts;
    return contacts.filter((c) => c.segments.includes(activeSegment.name));
  }, [contacts, activeSegment]);

  // Filter contacts by search
  const displayContacts = useMemo(() => {
    if (!search.trim()) return segmentContacts;
    const q = search.toLowerCase();
    return segmentContacts.filter((c) =>
      `${c.firstName} ${c.lastName}`.toLowerCase().includes(q) ||
      c.email.toLowerCase().includes(q) ||
      c.phone.includes(q) ||
      (c.company || '').toLowerCase().includes(q)
    );
  }, [segmentContacts, search]);

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

    // Validate phone if provided
    if (form.phone) {
      const digits = form.phone.replace(/\D/g, '');
      if (digits.length < 10 || digits.length > 15) {
        showToast('Phone number must be 10–15 digits (e.g. +15551234567)', 'error');
        return;
      }
      // Auto-normalize to E.164
      let normalized = form.phone.trim();
      if (digits.length === 10) normalized = `+1${digits}`;
      else if (!normalized.startsWith('+')) normalized = `+${digits}`;
      form.phone = normalized;
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
        {/* Mobile overlay for segment panel */}
        {panelOpen && <div className="sp-mobile-overlay" onClick={() => setPanelOpen(false)} />}

        {/* Left: Segment panel */}
        <div className={`contacts-panel ${panelOpen ? 'open' : 'closed'}`}>
          <SegmentPanel
            activeSegmentId={activeSegmentId}
            onSelectSegment={(id) => { setActiveSegmentId(id); setSelectedIds(new Set()); }}
          />
        </div>

        {/* Right: Contact list */}
        <div className="contacts-main">
          <PageHeader
            title={viewTitle}
            subtitle={`${viewCount} contact${viewCount !== 1 ? 's' : ''}`}
            actions={
              <>
                <button className="btn btn-secondary btn-sm mobile-only" onClick={() => setPanelOpen(!panelOpen)}>
                  ☰ Segments
                </button>
                <button className="btn btn-secondary btn-sm" onClick={() => setShowImportModal(true)}>
                  Import CSV
                </button>
                <button className="btn btn-primary btn-sm" onClick={() => setShowAddModal(true)}>
                  + Add Contact
                </button>
              </>
            }
          />

          {/* Search + bulk actions */}
          <div className="contacts-toolbar">
            <input
              className="search-input"
              placeholder="Search contacts..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {selectedIds.size > 0 && (
              <div className="bulk-actions">
                <span className="text-sm text-secondary">{selectedIds.size} selected</span>
                <button className="btn btn-secondary btn-xs" onClick={() => setShowBulkSegmentModal(true)}>
                  Add to Segment
                </button>
                {activeSegment && (
                  <button className="btn btn-secondary btn-xs" onClick={handleBulkRemoveFromSegment}>
                    Remove from {activeSegment.name}
                  </button>
                )}
                <button className="btn btn-danger btn-xs" onClick={() => {
                  if (confirm(`Delete ${selectedIds.size} contacts? This cannot be undone.`)) {
                    selectedIds.forEach((id) => deleteContact(id));
                    showToast(`${selectedIds.size} contacts deleted`);
                    setSelectedIds(new Set());
                  }
                }}>
                  Delete
                </button>
              </div>
            )}
          </div>

          {displayContacts.length === 0 ? (
            <EmptyState
              title={search ? 'No matches found' : 'No contacts yet'}
              description={search ? 'Try a different search term' : 'Add your first contact or import a CSV file to get started.'}
              action={!search ? { label: '+ Add Contact', onClick: () => setShowAddModal(true) } : undefined}
            />
          ) : (
            <DataTable
              columns={[
                {
                  key: 'select',
                  header: (
                    <input
                      type="checkbox"
                      checked={displayContacts.length > 0 && displayContacts.every((c) => selectedIds.has(c.contactId))}
                      onChange={toggleSelectAll}
                    />
                  ),
                  render: (c: Contact) => (
                    <input type="checkbox" checked={selectedIds.has(c.contactId)} onChange={() => toggleSelect(c.contactId)} />
                  ),
                  width: '40px',
                },
                {
                  key: 'name',
                  header: 'Name',
                  render: (c: Contact) => (
                    <button className="contact-name-btn" onClick={() => setSelectedContact(c)}>
                      {c.firstName} {c.lastName}
                    </button>
                  ),
                },
                { key: 'email', header: 'Email', render: (c: Contact) => <span className="text-secondary">{c.email || '—'}</span> },
                { key: 'phone', header: 'Phone', render: (c: Contact) => <span className="text-secondary">{c.phone || '—'}</span>, hideOnMobile: true },
                { key: 'company', header: 'Company', render: (c: Contact) => <span className="text-secondary">{c.company || '—'}</span>, hideOnMobile: true },
                {
                  key: 'segments',
                  header: 'Segments',
                  render: (c: Contact) => (
                    <div className="flex gap-1" style={{ flexWrap: 'wrap' }}>
                      {c.segments.map((s) => <span key={s} className="badge badge-subtle">{s}</span>)}
                    </div>
                  ),
                  hideOnMobile: true,
                },
              ]}
              data={displayContacts}
              rowKey={(c: Contact) => c.contactId}
            />
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
