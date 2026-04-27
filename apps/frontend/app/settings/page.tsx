'use client';

import { useState } from 'react';
import { useStore, CustomField } from '../lib/store';
import { useWorkspace } from '../lib/workspace';
import PageHeader from '../components/PageHeader';
import Tabs from '../components/Tabs';
import { Card } from '../components/DataTable';
import { FormField, FormInput, FormSelect, FormActions, CheckboxChip } from '../components/FormElements';
import Modal from '../components/Modal';
import { showToast } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';

// ============================================
// Field type config
// ============================================

const FIELD_TYPES = [
  { value: 'text', label: 'Text', icon: 'Aa' },
  { value: 'number', label: 'Number', icon: '#' },
  { value: 'date', label: 'Date', icon: '□' },
  { value: 'email', label: 'Email', icon: '@' },
  { value: 'phone', label: 'Phone', icon: '#' },
  { value: 'url', label: 'URL', icon: '→' },
  { value: 'select', label: 'Dropdown', icon: '≡' },
];

// ============================================
// Settings Page
// ============================================

export default function SettingsPage() {
  const store = useStore();
  const confirm = useConfirm();
  const { activeWorkspace, renameWorkspace, deleteWorkspace, workspaces } = useWorkspace();
  const [activeTab, setActiveTab] = useState('general');
  const [showAddField, setShowAddField] = useState(false);
  const [wsName, setWsName] = useState(activeWorkspace.name);

  // Channel settings local state
  const [channels, setChannels] = useState({
    smsSenderId: store.settings.smsSenderId,
    smsPhoneNumber: store.settings.smsPhoneNumber,
    voicePhoneNumber: store.settings.voicePhoneNumber,
    emailFromName: store.settings.emailFromName,
    emailFromAddress: store.settings.emailFromAddress,
    emailReplyTo: store.settings.emailReplyTo,
    timezone: store.settings.timezone,
  });

  // Compliance settings local state
  const [compliance, setCompliance] = useState({
    businessName: store.settings.businessName,
    businessAddress: store.settings.businessAddress,
    businessCity: store.settings.businessCity,
    businessState: store.settings.businessState,
    businessZip: store.settings.businessZip,
    businessCountry: store.settings.businessCountry,
    sanNumber: store.settings.sanNumber,
  });

  // New field form
  const [newField, setNewField] = useState({
    name: '', key: '', type: 'text' as CustomField['type'],
    isUnique: false, required: false, options: '',
  });

  const tabs = [
    { id: 'general', label: 'General', icon: '' },
    { id: 'channels', label: 'Channels', icon: '' },
    { id: 'compliance', label: 'Compliance', icon: '' },
    { id: 'fields', label: 'Custom Fields', icon: '' },
    { id: 'danger', label: 'Danger Zone', icon: '' },
  ];

  if (!store.hydrated) return null;

  const handleSaveGeneral = () => {
    renameWorkspace(activeWorkspace.workspaceId, wsName);
    store.updateSettings({ timezone: channels.timezone });
    showToast('Workspace settings saved');
  };

  const handleSaveChannels = () => {
    store.updateSettings(channels);
    showToast('Channel settings saved');
  };

  const handleSaveCompliance = () => {
    store.updateSettings(compliance);
    showToast('Compliance settings saved');
  };

  const handleMarkDncScrub = () => {
    const now = new Date().toISOString();
    store.updateSettings({ lastDncScrubDate: now });
    showToast('DNC scrub date recorded');
  };

  // DNC scrub age calculation
  const dncScrubAge = store.settings.lastDncScrubDate
    ? Math.floor((Date.now() - new Date(store.settings.lastDncScrubDate).getTime()) / (1000 * 60 * 60 * 24))
    : null;
  const dncOverdue = dncScrubAge !== null && dncScrubAge > 31;
  const hasBusinessAddress = store.settings.businessAddress.trim().length > 0;

  const handleAddField = () => {
    if (!newField.name.trim()) return;
    const key = newField.key.trim() || newField.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    store.addCustomField({
      name: newField.name.trim(),
      key,
      type: newField.type,
      isUnique: newField.isUnique,
      required: newField.required,
      options: newField.type === 'select' ? newField.options.split(',').map((o) => o.trim()).filter(Boolean) : undefined,
    });
    showToast(`Custom field "${newField.name}" added`);
    setNewField({ name: '', key: '', type: 'text', isUnique: false, required: false, options: '' });
    setShowAddField(false);
  };

  return (
    <>
      <PageHeader title="Settings" subtitle={`Configure your "${activeWorkspace.name}" workspace`} />

      <Tabs tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} />

      {/* =========== GENERAL =========== */}
      {activeTab === 'general' && (
        <Card title="Workspace Details">
          <FormField label="Workspace Name" required hint="This is how the workspace appears in the sidebar switcher">
            <FormInput value={wsName} onChange={(e) => setWsName(e.target.value)} placeholder="My Agency" />
          </FormField>
          <FormField label="Default Timezone" hint="Used for scheduling campaigns and TCPA compliance">
            <FormSelect value={channels.timezone} onChange={(e) => setChannels({ ...channels, timezone: e.target.value })}>
              <option value="America/New_York">Eastern Time (ET)</option>
              <option value="America/Chicago">Central Time (CT)</option>
              <option value="America/Denver">Mountain Time (MT)</option>
              <option value="America/Los_Angeles">Pacific Time (PT)</option>
              <option value="UTC">UTC</option>
            </FormSelect>
          </FormField>

          <div className="info-box mb-5">
            <p className="text-secondary" style={{ fontSize: 'var(--text-sm)' }}>
              <strong>Workspace ID:</strong> <span className="font-mono text-tertiary">{activeWorkspace.workspaceId}</span>
            </p>
            <p className="text-secondary" style={{ fontSize: 'var(--text-sm)', marginTop: 'var(--space-1)' }}>
              <strong>Created:</strong> <span className="text-tertiary">{new Date(activeWorkspace.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</span>
            </p>
          </div>

          <FormActions>
            <button className="btn btn-primary" onClick={handleSaveGeneral}>Save Changes</button>
          </FormActions>
        </Card>
      )}

      {/* =========== CHANNELS =========== */}
      {activeTab === 'channels' && (
        <>
          <Card title="Email Configuration" className="mb-6">
            <div className="form-grid-2">
              <FormField label="From Name" hint="The sender name recipients will see">
                <FormInput value={channels.emailFromName} onChange={(e) => setChannels({ ...channels, emailFromName: e.target.value })} placeholder="Acme Marketing" />
              </FormField>
              <FormField label="From Address" hint="Must be a verified domain in SES">
                <FormInput type="email" value={channels.emailFromAddress} onChange={(e) => setChannels({ ...channels, emailFromAddress: e.target.value })} placeholder="marketing@acme.com" />
              </FormField>
            </div>
            <FormField label="Reply-To Address" hint="Where replies get sent — can differ from the From address">
              <FormInput type="email" value={channels.emailReplyTo} onChange={(e) => setChannels({ ...channels, emailReplyTo: e.target.value })} placeholder="support@acme.com" />
            </FormField>
          </Card>

          <Card title="SMS Configuration" className="mb-6">
            <div className="form-grid-2">
              <FormField label="Sender ID / Short Code" hint="Alphanumeric ID or short code for outbound SMS">
                <FormInput value={channels.smsSenderId} onChange={(e) => setChannels({ ...channels, smsSenderId: e.target.value })} placeholder="ACME or 12345" />
              </FormField>
              <FormField label="Phone Number" hint="E.164 format — the number SMS are sent from">
                <FormInput type="tel" value={channels.smsPhoneNumber} onChange={(e) => setChannels({ ...channels, smsPhoneNumber: e.target.value })} placeholder="+15551234567" />
              </FormField>
            </div>
          </Card>

          <Card title="Voice Configuration" className="mb-6">
            <FormField label="Caller ID Number" hint="The phone number displayed on outbound calls">
              <FormInput type="tel" value={channels.voicePhoneNumber} onChange={(e) => setChannels({ ...channels, voicePhoneNumber: e.target.value })} placeholder="+15551234567" />
            </FormField>
          </Card>

          <FormActions>
            <button className="btn btn-primary" onClick={handleSaveChannels}>Save Channel Settings</button>
          </FormActions>
        </>
      )}

      {/* =========== COMPLIANCE =========== */}
      {activeTab === 'compliance' && (
        <>
          {/* Compliance Status Overview */}
          <Card title="Compliance Status" className="mb-6">
            <div style={{ display: 'flex', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
              <div className={`info-box ${hasBusinessAddress ? '' : 'info-box-warning'}`} style={{ flex: 1, minWidth: 200 }}>
                <p className="font-medium text-primary" style={{ fontSize: 'var(--text-sm)', marginBottom: 'var(--space-1)' }}>
                  {hasBusinessAddress ? '✅' : '⚠️'} Physical Address
                </p>
                <p className="text-tertiary" style={{ fontSize: 'var(--text-xs)' }}>
                  {hasBusinessAddress ? 'Set — will be included in email footers' : 'Required for CAN-SPAM compliance'}
                </p>
              </div>
              <div className={`info-box ${dncOverdue ? 'info-box-warning' : ''}`} style={{ flex: 1, minWidth: 200 }}>
                <p className="font-medium text-primary" style={{ fontSize: 'var(--text-sm)', marginBottom: 'var(--space-1)' }}>
                  {dncScrubAge === null ? '⚠️' : dncOverdue ? '🔴' : '✅'} DNC Scrub
                </p>
                <p className="text-tertiary" style={{ fontSize: 'var(--text-xs)' }}>
                  {dncScrubAge === null
                    ? 'Never performed'
                    : dncOverdue
                      ? `${dncScrubAge} days ago — overdue (max 31 days)`
                      : `${dncScrubAge} days ago`}
                </p>
              </div>
            </div>
          </Card>

          {/* Business Address (CAN-SPAM) */}
          <Card title="Business Address" className="mb-6">
            <p className="text-secondary mb-5" style={{ fontSize: 'var(--text-sm)' }}>
              CAN-SPAM requires a valid physical postal address in every commercial email. This address will be automatically injected into your email footers.
            </p>
            <FormField label="Business / Organization Name">
              <FormInput value={compliance.businessName} onChange={(e) => setCompliance({ ...compliance, businessName: e.target.value })} placeholder="Acme Marketing Inc." />
            </FormField>
            <FormField label="Street Address" required>
              <FormInput value={compliance.businessAddress} onChange={(e) => setCompliance({ ...compliance, businessAddress: e.target.value })} placeholder="123 Main St, Suite 100" />
            </FormField>
            <div className="form-grid-2">
              <FormField label="City">
                <FormInput value={compliance.businessCity} onChange={(e) => setCompliance({ ...compliance, businessCity: e.target.value })} placeholder="New York" />
              </FormField>
              <FormField label="State">
                <FormInput value={compliance.businessState} onChange={(e) => setCompliance({ ...compliance, businessState: e.target.value })} placeholder="NY" />
              </FormField>
            </div>
            <div className="form-grid-2">
              <FormField label="ZIP Code">
                <FormInput value={compliance.businessZip} onChange={(e) => setCompliance({ ...compliance, businessZip: e.target.value })} placeholder="10001" />
              </FormField>
              <FormField label="Country">
                <FormSelect value={compliance.businessCountry} onChange={(e) => setCompliance({ ...compliance, businessCountry: e.target.value })}>
                  <option value="US">United States</option>
                  <option value="CA">Canada</option>
                  <option value="GB">United Kingdom</option>
                  <option value="AU">Australia</option>
                </FormSelect>
              </FormField>
            </div>
          </Card>

          {/* DNC Registry */}
          <Card title="Do Not Call (DNC) Registry" className="mb-6">
            <p className="text-secondary mb-5" style={{ fontSize: 'var(--text-sm)' }}>
              Federal law requires scrubbing your call/SMS lists against the National DNC registry <strong>every 31 days</strong>. You must have an FTC Subscription Account Number (SAN) to access the registry.
            </p>
            <FormField label="FTC SAN Number" hint="Your Subscription Account Number from telemarketing.donotcall.gov">
              <FormInput value={compliance.sanNumber} onChange={(e) => setCompliance({ ...compliance, sanNumber: e.target.value })} placeholder="SAN-XXXXXXXXXX" />
            </FormField>
            <div className="info-box mb-5">
              <p className="text-secondary" style={{ fontSize: 'var(--text-xs)', lineHeight: 1.6 }}>
                <strong>Don&apos;t have a SAN?</strong> Register at{' '}
                <a href="https://telemarketing.donotcall.gov" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-primary)' }}>telemarketing.donotcall.gov</a>.
                The first 5 area codes are free. Additional area codes cost $82/year (FY 2026).
              </p>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
              <div>
                <p className="text-primary font-medium" style={{ fontSize: 'var(--text-sm)' }}>Last scrub:</p>
                <p className={`font-medium ${dncOverdue ? 'text-danger' : 'text-secondary'}`} style={{ fontSize: 'var(--text-sm)' }}>
                  {store.settings.lastDncScrubDate
                    ? new Date(store.settings.lastDncScrubDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
                    : 'Never'}
                  {dncOverdue && ' — OVERDUE'}
                </p>
              </div>
              <button className="btn btn-secondary btn-sm" onClick={handleMarkDncScrub}>
                Mark Scrub Complete
              </button>
            </div>
          </Card>

          <FormActions>
            <button className="btn btn-primary" onClick={handleSaveCompliance}>Save Compliance Settings</button>
          </FormActions>
        </>
      )}

      {/* =========== CUSTOM FIELDS =========== */}
      {activeTab === 'fields' && (
        <>
          <Card
            title="Custom Contact Fields"
            action={<button className="btn btn-primary btn-sm" onClick={() => setShowAddField(true)}>+ Add Field</button>}
          >
            <p className="text-secondary mb-5" style={{ fontSize: 'var(--text-sm)' }}>
              Define custom fields to capture additional data on your contacts. Fields marked as <strong>Unique</strong> will be enforced as unique identifiers alongside email and phone.
            </p>

            {/* Built-in fields (read only) */}
            <div className="settings-field-list">
              <div className="settings-field-row builtin">
                <div className="settings-field-info">
                  <span className="settings-field-name">Email</span>
                  <span className="settings-field-meta">email · Built-in</span>
                </div>
                <div className="flex gap-2">
                  <span className="badge badge-info">Unique</span>
                  <span className="badge badge-neutral">Required</span>
                </div>
              </div>
              <div className="settings-field-row builtin">
                <div className="settings-field-info">
                  <span className="settings-field-name">Phone Number</span>
                  <span className="settings-field-meta">phone · Built-in</span>
                </div>
                <div className="flex gap-2">
                  <span className="badge badge-info">Unique</span>
                  <span className="badge badge-neutral">Required</span>
                </div>
              </div>

              {/* Custom fields */}
              {store.settings.customFields.map((field) => (
                <div key={field.fieldId} className="settings-field-row">
                  <div className="settings-field-info">
                    <span className="settings-field-name">{field.name}</span>
                    <span className="settings-field-meta">
                      {FIELD_TYPES.find((t) => t.value === field.type)?.icon} {field.type} · <span className="font-mono">{field.key}</span>
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    {field.isUnique && <span className="badge badge-info">Unique</span>}
                    {field.required && <span className="badge badge-neutral">Required</span>}
                    {field.type === 'select' && field.options && (
                      <span className="badge badge-neutral">{field.options.length} options</span>
                    )}
                    <button
                      className="btn btn-ghost btn-sm"
                      title={`Toggle unique identifier for ${field.name}`}
                      onClick={() => {
                        store.updateCustomField(field.fieldId, { isUnique: !field.isUnique });
                        showToast(`${field.name} ${!field.isUnique ? 'marked as unique' : 'no longer unique'}`);
                      }}
                      style={{ color: field.isUnique ? 'var(--accent-primary)' : 'var(--text-tertiary)' }}
                    >
                      ≡
                    </button>
                    <button
                      className="btn btn-ghost btn-sm"
                      title={`Delete ${field.name}`}
                      onClick={() => { store.deleteCustomField(field.fieldId); showToast(`Field "${field.name}" removed`); }}
                      style={{ color: 'var(--text-tertiary)' }}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}

              {store.settings.customFields.length === 0 && (
                <div className="settings-field-empty">
                  <p className="text-tertiary" style={{ fontSize: 'var(--text-sm)' }}>No custom fields defined yet. Click &quot;+ Add Field&quot; to create one.</p>
                </div>
              )}
            </div>
          </Card>
        </>
      )}

      {/* =========== DANGER ZONE =========== */}
      {activeTab === 'danger' && (
        <Card title="Danger Zone">
          <div className="settings-danger-item">
            <div>
              <h3 className="text-primary font-medium" style={{ fontSize: 'var(--text-sm)', marginBottom: 'var(--space-1)' }}>Reset Workspace Data</h3>
              <p className="text-tertiary" style={{ fontSize: 'var(--text-xs)' }}>Restore this workspace to its default seed data. All contacts, campaigns, and templates will be replaced.</p>
            </div>
            <button className="btn btn-danger btn-sm" onClick={async () => {
              const ok = await confirm('This will reset ALL data in this workspace to defaults. Are you sure?', { title: 'Reset Workspace', variant: 'danger', confirmLabel: 'Reset Data' });
              if (ok) {
                store.resetData();
                showToast('Workspace data reset to defaults', 'info');
              }
            }}>Reset Data</button>
          </div>

          {workspaces.length > 1 && (
            <div className="settings-danger-item">
              <div>
                <h3 className="text-primary font-medium" style={{ fontSize: 'var(--text-sm)', marginBottom: 'var(--space-1)' }}>Delete Workspace</h3>
                <p className="text-tertiary" style={{ fontSize: 'var(--text-xs)' }}>Permanently delete &quot;{activeWorkspace.name}&quot; and all its data. You cannot undo this.</p>
              </div>
              <button className="btn btn-danger btn-sm" onClick={async () => {
                const ok = await confirm(`Permanently delete "${activeWorkspace.name}"? This cannot be undone.`, { title: 'Delete Workspace', variant: 'danger', confirmLabel: 'Delete Workspace' });
                if (ok) {
                  deleteWorkspace(activeWorkspace.workspaceId);
                  showToast(`Workspace "${activeWorkspace.name}" deleted`, 'info');
                }
              }}>Delete Workspace</button>
            </div>
          )}
        </Card>
      )}

      {/* =========== ADD FIELD MODAL =========== */}
      <Modal isOpen={showAddField} onClose={() => setShowAddField(false)} title="Add Custom Field" width="540px">
        <FormField label="Field Name" required hint="The label shown on the contact form">
          <FormInput
            placeholder="e.g. CRM ID, Account Number, Company Size"
            value={newField.name}
            onChange={(e) => {
              const name = e.target.value;
              const key = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
              setNewField({ ...newField, name, key });
            }}
          />
        </FormField>

        <FormField label="Field Key" hint="Used internally for data storage and API access. Auto-generated from the name.">
          <FormInput
            className="font-mono"
            placeholder="crm_id"
            value={newField.key}
            onChange={(e) => setNewField({ ...newField, key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') })}
          />
        </FormField>

        <FormField label="Field Type" required>
          <FormSelect value={newField.type} onChange={(e) => setNewField({ ...newField, type: e.target.value as CustomField['type'] })}>
            {FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.icon} {t.label}</option>)}
          </FormSelect>
        </FormField>

        {newField.type === 'select' && (
          <FormField label="Options" required hint="Comma-separated list of dropdown options">
            <FormInput
              placeholder="Small, Medium, Large, Enterprise"
              value={newField.options}
              onChange={(e) => setNewField({ ...newField, options: e.target.value })}
            />
          </FormField>
        )}

        <div className="flex gap-4 mb-5">
          <CheckboxChip label="Unique Identifier" checked={newField.isUnique} onChange={() => setNewField({ ...newField, isUnique: !newField.isUnique })} />
          <CheckboxChip label="Required Field" checked={newField.required} onChange={() => setNewField({ ...newField, required: !newField.required })} />
        </div>

        {newField.isUnique && (
          <div className="info-box mb-5" style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
             <strong>Unique Identifier:</strong> This field will be enforced as unique across all contacts. Duplicates with the same value will be rejected during import and manual entry.
          </div>
        )}

        <FormActions>
          <button className="btn btn-secondary" onClick={() => setShowAddField(false)}>Cancel</button>
          <button className="btn btn-primary" onClick={handleAddField} disabled={!newField.name.trim()}>Add Field</button>
        </FormActions>
      </Modal>
    </>
  );
}
