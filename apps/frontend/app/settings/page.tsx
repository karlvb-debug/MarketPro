'use client';

import { useState } from 'react';
import { useStore, CustomField } from '../lib/store';
import { useWorkspace } from '../lib/workspace';
import PageHeader from '../components/PageHeader';
import { Card } from '../components/DataTable';
import { Button, Tabs, Modal, Field, Input, Select, Checkbox, FormActions, showToast } from '../components/ui';
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
          <Field label="Workspace Name" required hint="This is how the workspace appears in the sidebar switcher">
            <Input value={wsName} onChange={(e) => setWsName(e.target.value)} placeholder="My Agency" />
          </Field>
          <Field label="Default Timezone" hint="Used for scheduling campaigns and TCPA compliance">
            <Select value={channels.timezone} onChange={(e) => setChannels({ ...channels, timezone: e.target.value })}>
              <option value="America/New_York">Eastern Time (ET)</option>
              <option value="America/Chicago">Central Time (CT)</option>
              <option value="America/Denver">Mountain Time (MT)</option>
              <option value="America/Los_Angeles">Pacific Time (PT)</option>
              <option value="UTC">UTC</option>
            </Select>
          </Field>

          <div className="info-box mb-5">
            <p className="text-secondary text-sm">
              <strong>Workspace ID:</strong> <span className="font-mono text-tertiary">{activeWorkspace.workspaceId}</span>
            </p>
            <p className="text-secondary text-sm mt-1">
              <strong>Created:</strong> <span className="text-tertiary">{new Date(activeWorkspace.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</span>
            </p>
          </div>

          <FormActions>
            <Button variant="primary" onClick={handleSaveGeneral}>Save Changes</Button>
          </FormActions>
        </Card>
      )}

      {/* =========== CHANNELS =========== */}
      {activeTab === 'channels' && (
        <>
          <Card title="Email Configuration" className="mb-6">
            <div className="form-grid-2">
              <Field label="From Name" hint="The sender name recipients will see">
                <Input value={channels.emailFromName} onChange={(e) => setChannels({ ...channels, emailFromName: e.target.value })} placeholder="Acme Marketing" />
              </Field>
              <Field label="From Address" hint="Must be a verified domain in SES">
                <Input type="email" value={channels.emailFromAddress} onChange={(e) => setChannels({ ...channels, emailFromAddress: e.target.value })} placeholder="marketing@acme.com" />
              </Field>
            </div>
            <Field label="Reply-To Address" hint="Where replies get sent — can differ from the From address">
              <Input type="email" value={channels.emailReplyTo} onChange={(e) => setChannels({ ...channels, emailReplyTo: e.target.value })} placeholder="support@acme.com" />
            </Field>
          </Card>

          <Card title="SMS Configuration" className="mb-6">
            <div className="form-grid-2">
              <Field label="Sender ID / Short Code" hint="Alphanumeric ID or short code for outbound SMS">
                <Input value={channels.smsSenderId} onChange={(e) => setChannels({ ...channels, smsSenderId: e.target.value })} placeholder="ACME or 12345" />
              </Field>
              <Field label="Phone Number" hint="E.164 format — the number SMS are sent from">
                <Input type="tel" value={channels.smsPhoneNumber} onChange={(e) => setChannels({ ...channels, smsPhoneNumber: e.target.value })} placeholder="+15551234567" />
              </Field>
            </div>
          </Card>

          <Card title="Voice Configuration" className="mb-6">
            <Field label="Caller ID Number" hint="The phone number displayed on outbound calls">
              <Input type="tel" value={channels.voicePhoneNumber} onChange={(e) => setChannels({ ...channels, voicePhoneNumber: e.target.value })} placeholder="+15551234567" />
            </Field>
          </Card>

          <FormActions>
            <Button variant="primary" onClick={handleSaveChannels}>Save Channel Settings</Button>
          </FormActions>
        </>
      )}

      {/* =========== COMPLIANCE =========== */}
      {activeTab === 'compliance' && (
        <>
          {/* Compliance Status Overview */}
          <Card title="Compliance Status" className="mb-6">
            <div className="flex gap-4 flex-wrap">
              <div className={`info-box ${hasBusinessAddress ? '' : 'info-box-warning'}`} style={{ flex: 1, minWidth: 200 }}>
                <p className="font-medium text-primary text-sm mb-1">
                  {hasBusinessAddress ? '✅' : '⚠️'} Physical Address
                </p>
                <p className="text-tertiary text-xs" >
                  {hasBusinessAddress ? 'Set — will be included in email footers' : 'Required for CAN-SPAM compliance'}
                </p>
              </div>
              <div className={`info-box ${dncOverdue ? 'info-box-warning' : ''}`} style={{ flex: 1, minWidth: 200 }}>
                <p className="font-medium text-primary text-sm mb-1">
                  {dncScrubAge === null ? '⚠️' : dncOverdue ? '🔴' : '✅'} DNC Scrub
                </p>
                <p className="text-tertiary text-xs" >
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
            <p className="text-secondary mb-5 text-sm">
              CAN-SPAM requires a valid physical postal address in every commercial email. This address will be automatically injected into your email footers.
            </p>
            <Field label="Business / Organization Name">
              <Input value={compliance.businessName} onChange={(e) => setCompliance({ ...compliance, businessName: e.target.value })} placeholder="Acme Marketing Inc." />
            </Field>
            <Field label="Street Address" required>
              <Input value={compliance.businessAddress} onChange={(e) => setCompliance({ ...compliance, businessAddress: e.target.value })} placeholder="123 Main St, Suite 100" />
            </Field>
            <div className="form-grid-2">
              <Field label="City">
                <Input value={compliance.businessCity} onChange={(e) => setCompliance({ ...compliance, businessCity: e.target.value })} placeholder="New York" />
              </Field>
              <Field label="State">
                <Input value={compliance.businessState} onChange={(e) => setCompliance({ ...compliance, businessState: e.target.value })} placeholder="NY" />
              </Field>
            </div>
            <div className="form-grid-2">
              <Field label="ZIP Code">
                <Input value={compliance.businessZip} onChange={(e) => setCompliance({ ...compliance, businessZip: e.target.value })} placeholder="10001" />
              </Field>
              <Field label="Country">
                <Select value={compliance.businessCountry} onChange={(e) => setCompliance({ ...compliance, businessCountry: e.target.value })}>
                  <option value="US">United States</option>
                  <option value="CA">Canada</option>
                  <option value="GB">United Kingdom</option>
                  <option value="AU">Australia</option>
                </Select>
              </Field>
            </div>
          </Card>

          {/* DNC Registry */}
          <Card title="Do Not Call (DNC) Registry" className="mb-6">
            <p className="text-secondary mb-5 text-sm">
              Federal law requires scrubbing your call/SMS lists against the National DNC registry <strong>every 31 days</strong>. You must have an FTC Subscription Account Number (SAN) to access the registry.
            </p>
            <Field label="FTC SAN Number" hint="Your Subscription Account Number from telemarketing.donotcall.gov">
              <Input value={compliance.sanNumber} onChange={(e) => setCompliance({ ...compliance, sanNumber: e.target.value })} placeholder="SAN-XXXXXXXXXX" />
            </Field>
            <div className="info-box mb-5">
              <p className="text-secondary text-xs" style={{ lineHeight: 1.6 }}>
                <strong>Don&apos;t have a SAN?</strong> Register at{' '}
                <a href="https://telemarketing.donotcall.gov" target="_blank" rel="noopener noreferrer" className="text-accent">telemarketing.donotcall.gov</a>.
                The first 5 area codes are free. Additional area codes cost $82/year (FY 2026).
              </p>
            </div>
            <div className="flex items-center gap-4 flex-wrap">
              <div>
                <p className="text-primary font-medium text-sm">Last scrub:</p>
                <p className={`font-medium text-sm ${dncOverdue ? 'text-danger' : 'text-secondary'}`}>
                  {store.settings.lastDncScrubDate
                    ? new Date(store.settings.lastDncScrubDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
                    : 'Never'}
                  {dncOverdue && ' — OVERDUE'}
                </p>
              </div>
              <Button size="sm" onClick={handleMarkDncScrub}>
                Mark Scrub Complete
              </Button>
            </div>
          </Card>

          <FormActions>
            <Button variant="primary" onClick={handleSaveCompliance}>Save Compliance Settings</Button>
          </FormActions>
        </>
      )}

      {/* =========== CUSTOM FIELDS =========== */}
      {activeTab === 'fields' && (
        <>
          <Card
            title="Custom Contact Fields"
            action={<Button variant="primary" size="sm" onClick={() => setShowAddField(true)}>+ Add Field</Button>}
          >
            <p className="text-secondary mb-5 text-sm">
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
                    <Button
                      variant="ghost" size="sm"
                      title={`Toggle unique identifier for ${field.name}`}
                      onClick={() => {
                        store.updateCustomField(field.fieldId, { isUnique: !field.isUnique });
                        showToast(`${field.name} ${!field.isUnique ? 'marked as unique' : 'no longer unique'}`);
                      }}
                      style={{ color: field.isUnique ? 'var(--accent-primary)' : 'var(--text-tertiary)' }}
                    >
                      ≡
                    </Button>
                    <Button
                      variant="ghost" size="sm"
                      title={`Delete ${field.name}`}
                      onClick={() => { store.deleteCustomField(field.fieldId); showToast(`Field "${field.name}" removed`); }}
                      
                    >
                      ✕
                    </Button>
                  </div>
                </div>
              ))}

              {store.settings.customFields.length === 0 && (
                <div className="settings-field-empty">
                  <p className="text-tertiary text-sm">No custom fields defined yet. Click &quot;+ Add Field&quot; to create one.</p>
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
              <h3 className="text-primary font-medium text-sm mb-1">Reset Workspace Data</h3>
              <p className="text-tertiary text-xs" >Restore this workspace to its default seed data. All contacts, campaigns, and templates will be replaced.</p>
            </div>
            <Button variant="danger" size="sm" onClick={async () => {
              const ok = await confirm('This will reset ALL data in this workspace to defaults. Are you sure?', { title: 'Reset Workspace', variant: 'danger', confirmLabel: 'Reset Data' });
              if (ok) {
                store.resetData();
                showToast('Workspace data reset to defaults', 'info');
              }
            }}>Reset Data</Button>
          </div>

          {workspaces.length > 1 && (
            <div className="settings-danger-item">
              <div>
                <h3 className="text-primary font-medium text-sm mb-1">Delete Workspace</h3>
                <p className="text-tertiary text-xs" >Permanently delete &quot;{activeWorkspace.name}&quot; and all its data. You cannot undo this.</p>
              </div>
              <Button variant="danger" size="sm" onClick={async () => {
                const ok = await confirm(`Permanently delete "${activeWorkspace.name}"? This cannot be undone.`, { title: 'Delete Workspace', variant: 'danger', confirmLabel: 'Delete Workspace' });
                if (ok) {
                  deleteWorkspace(activeWorkspace.workspaceId);
                  showToast(`Workspace "${activeWorkspace.name}" deleted`, 'info');
                }
              }}>Delete Workspace</Button>
            </div>
          )}
        </Card>
      )}

      {/* =========== ADD FIELD MODAL =========== */}
      <Modal isOpen={showAddField} onClose={() => setShowAddField(false)} title="Add Custom Field" size="md">
        <Field label="Field Name" required hint="The label shown on the contact form">
          <Input
            placeholder="e.g. CRM ID, Account Number, Company Size"
            value={newField.name}
            onChange={(e) => {
              const name = e.target.value;
              const key = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
              setNewField({ ...newField, name, key });
            }}
          />
        </Field>

        <Field label="Field Key" hint="Used internally for data storage and API access. Auto-generated from the name.">
          <Input
            className="font-mono"
            placeholder="crm_id"
            value={newField.key}
            onChange={(e) => setNewField({ ...newField, key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') })}
          />
        </Field>

        <Field label="Field Type" required>
          <Select value={newField.type} onChange={(e) => setNewField({ ...newField, type: e.target.value as CustomField['type'] })}>
            {FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.icon} {t.label}</option>)}
          </Select>
        </Field>

        {newField.type === 'select' && (
          <Field label="Options" required hint="Comma-separated list of dropdown options">
            <Input
              placeholder="Small, Medium, Large, Enterprise"
              value={newField.options}
              onChange={(e) => setNewField({ ...newField, options: e.target.value })}
            />
          </Field>
        )}

        <div className="flex gap-4 mb-5">
          <Checkbox label="Unique Identifier" checked={newField.isUnique} onChange={() => setNewField({ ...newField, isUnique: !newField.isUnique })} />
          <Checkbox label="Required Field" checked={newField.required} onChange={() => setNewField({ ...newField, required: !newField.required })} />
        </div>

        {newField.isUnique && (
          <div className="info-box mb-5 text-xs text-tertiary">
             <strong>Unique Identifier:</strong> This field will be enforced as unique across all contacts. Duplicates with the same value will be rejected during import and manual entry.
          </div>
        )}

        <FormActions>
          <Button onClick={() => setShowAddField(false)}>Cancel</Button>
          <Button variant="primary" onClick={handleAddField} disabled={!newField.name.trim()}>Add Field</Button>
        </FormActions>
      </Modal>
    </>
  );
}
