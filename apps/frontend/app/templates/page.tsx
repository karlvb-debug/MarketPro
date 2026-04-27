'use client';

import { useState, useMemo } from 'react';
import { useStore } from '../lib/store';
import Toolbar from '../components/Toolbar';
import TemplateFolderPanel from '../components/TemplateFolderPanel';
import EmptyState from '../components/EmptyState';
import Modal from '../components/Modal';
import { FormField, FormInput, FormTextarea, FormActions } from '../components/FormElements';
import { showToast } from '../components/Toast';

type ContentType = 'email' | 'sms' | 'voice' | 'webform';

// Normalize template ID across types
function getTplId(t: any): string { return t.templateId || t.scriptId || t.formId; }

const TYPE_LABELS: Record<ContentType, { singular: string; plural: string; icon: string }> = {
  email: { singular: 'Email', plural: 'Emails', icon: '@' },
  sms: { singular: 'SMS', plural: 'SMS Messages', icon: '#' },
  voice: { singular: 'Call Script', plural: 'Call Scripts', icon: '☎' },
  webform: { singular: 'Web Form', plural: 'Web Forms', icon: '☐' },
};

export default function TemplatesPage() {
  const store = useStore();
  const { templates, templateFolders, hydrated } = store;

  // Panel state
  const [activeType, setActiveType] = useState<ContentType>('email');
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [search, setSearch] = useState('');

  // Modals
  const [showNewEmail, setShowNewEmail] = useState(false);
  const [showNewSms, setShowNewSms] = useState(false);
  const [showNewWebForm, setShowNewWebForm] = useState(false);
  const [emailName, setEmailName] = useState('');
  const [emailSubject, setEmailSubject] = useState('');
  const [smsName, setSmsName] = useState('');
  const [smsBody, setSmsBody] = useState('');
  const [webFormName, setWebFormName] = useState('');
  const [webFormDesc, setWebFormDesc] = useState('');

  // Preview drawer
  const [previewId, setPreviewId] = useState<string | null>(null);

  // Resolve active folder name
  const activeFolder = activeFolderId
    ? (templateFolders || []).find((f) => f.folderId === activeFolderId)
    : null;

  // Filter templates by type, folder, and search
  const displayItems = useMemo(() => {
    let list = templates[activeType] as any[];

    // Folder filter
    if (activeFolderId === '__uncategorized__') {
      list = list.filter((t: any) => !t.folder);
    } else if (activeFolder) {
      list = list.filter((t: any) => t.folder === activeFolder.name);
    }

    // Search filter
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((t: any) =>
        t.name.toLowerCase().includes(q) ||
        (t.subjectLine && t.subjectLine.toLowerCase().includes(q)) ||
        (t.body && t.body.toLowerCase().includes(q))
      );
    }

    return list.sort((a: any, b: any) => (a.order || 0) - (b.order || 0));
  }, [templates, activeType, activeFolderId, activeFolder, search]);

  const labels = TYPE_LABELS[activeType];

  // Title
  const viewTitle = activeFolder
    ? activeFolder.name
    : activeFolderId === '__uncategorized__'
    ? 'Uncategorized'
    : `All ${labels.plural}`;

  // Handlers
  const handleAddEmail = (e: React.FormEvent) => {
    e.preventDefault();
    store.addEmailTemplate({ name: emailName, subjectLine: emailSubject });
    showToast(`"${emailName}" created`);
    setEmailName(''); setEmailSubject(''); setShowNewEmail(false);
  };

  const handleAddSms = (e: React.FormEvent) => {
    e.preventDefault();
    store.addSmsTemplate({ name: smsName, body: smsBody });
    showToast(`"${smsName}" created`);
    setSmsName(''); setSmsBody(''); setShowNewSms(false);
  };

  const handleNewClick = () => {
    if (activeType === 'email') setShowNewEmail(true);
    else if (activeType === 'sms') setShowNewSms(true);
    else if (activeType === 'webform') setShowNewWebForm(true);
  };

  const handleDeleteItem = (id: string) => {
    if (confirm(`Delete this ${labels.singular.toLowerCase()}?`)) {
      store.deleteTemplate(id, activeType);
      if (previewId === id) setPreviewId(null);
      showToast(`${labels.singular} deleted`);
    }
  };

  if (!hydrated) return null;

  const typeTabs = [
    { id: 'email', label: `Emails (${templates.email.length})` },
    { id: 'sms', label: `SMS (${templates.sms.length})` },
    { id: 'voice', label: `Calls (${templates.voice.length})` },
    { id: 'webform', label: `Forms (${templates.webform.length})` },
  ];

  // Preview item
  const previewItem = previewId
    ? (templates[activeType] as any[]).find((t: any) => getTplId(t) === previewId)
    : null;

  return (
    <>
      <div className="contacts-layout">
        {/* Mobile overlay */}
        {panelOpen && <div className="sp-mobile-overlay" onClick={() => setPanelOpen(false)} />}

        {/* Left: Folder panel */}
        <div className={`sp-wrapper ${panelOpen ? 'sp-mobile-open' : ''}`}>
          <TemplateFolderPanel
            activeFolderId={activeFolderId}
            activeType={activeType}
            onSelectFolder={(id) => { setActiveFolderId(id); setSearch(''); setPanelOpen(false); }}
          />
        </div>

        {/* Center: Content list */}
        <div className="contacts-content">
          <Toolbar
            title={viewTitle}
            count={displayItems.length}
            search={search}
            onSearchChange={setSearch}
            onTogglePanel={() => setPanelOpen((p) => !p)}
            panelOpen={panelOpen}
            searchPlaceholder={`Search ${labels.plural.toLowerCase()}...`}
            filters={
              <div className="tpl-type-tabs">
                {typeTabs.map((tab) => (
                  <button
                    key={tab.id}
                    className={`tpl-type-tab ${activeType === tab.id ? 'active' : ''}`}
                    onClick={() => { setActiveType(tab.id as ContentType); setSearch(''); setPreviewId(null); }}
                  >{tab.label}</button>
                ))}
              </div>
            }
            actions={
              <button className="btn btn-primary btn-sm" onClick={handleNewClick}>
                + New {labels.singular}
              </button>
            }
          />

          {/* Content list */}
          {displayItems.length === 0 ? (
            <EmptyState
              icon={labels.icon}
              title={search ? `No matching ${labels.plural.toLowerCase()}` : `No ${labels.plural.toLowerCase()}${activeFolder ? ` in "${activeFolder.name}"` : ''}`}
              description={search ? 'Try a different search term.' : `Create your first ${labels.singular.toLowerCase()}.`}
            >
              <button className="btn btn-primary" onClick={handleNewClick}>
                + New {labels.singular}
              </button>
            </EmptyState>
          ) : (
            <div className="table-wrapper">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    {activeType === 'email' && <th>Subject Line</th>}
                    {activeType === 'sms' && <th>Preview</th>}
                    {activeType === 'voice' && <th>Voice</th>}
                    {activeType === 'webform' && <th>Fields</th>}
                    <th>Folder</th>
                    <th>Updated</th>
                    <th style={{ width: '100px' }}></th>
                  </tr>
                </thead>
                <tbody>
                  {displayItems.map((item: any) => {
                    const id = getTplId(item);
                    const isActive = previewId === id;
                    return (
                      <tr
                        key={id}
                        className={`cc-clickable ${isActive ? 'cc-active-row' : ''}`}
                        onClick={() => setPreviewId(isActive ? null : id)}
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData('text/plain', id);
                          e.dataTransfer.effectAllowed = 'move';
                        }}
                      >
                        <td className="text-primary font-medium">{item.name}</td>
                        {activeType === 'email' && (
                          <td className="text-secondary">{item.subjectLine || <span className="text-tertiary">—</span>}</td>
                        )}
                        {activeType === 'sms' && (
                          <td>
                            <span className="tpl-sms-inline-preview">{item.body}</span>
                          </td>
                        )}
                        {activeType === 'voice' && (
                          <td className="text-secondary">{item.voiceId}</td>
                        )}
                        {activeType === 'webform' && (
                          <td className="text-secondary">{item.fields?.length || 0} field{(item.fields?.length || 0) !== 1 ? 's' : ''}</td>
                        )}
                        <td>
                          {item.folder ? (
                            <span className="badge badge-neutral">{item.folder}</span>
                          ) : (
                            <span className="text-tertiary">—</span>
                          )}
                        </td>
                        <td className="text-tertiary" style={{ fontSize: 'var(--text-xs)' }}>
                          {item.updatedAt
                            ? new Date(item.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                            : '—'}
                        </td>
                        <td onClick={(e) => e.stopPropagation()}>
                          <div className="flex gap-1">
                            {activeType === 'email' && (
                              <a href={`/email-builder?templateId=${id}`} className="btn btn-secondary btn-sm">Edit</a>
                            )}
                            <button className="btn btn-ghost btn-sm" onClick={() => handleDeleteItem(id)}>✕</button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Right: Preview drawer */}
        {previewItem && (
          <div className="tpl-preview-drawer">
            <div className="tpl-preview-header">
              <h3 className="tpl-preview-title">{previewItem.name}</h3>
              <button className="btn btn-ghost btn-sm" onClick={() => setPreviewId(null)}>✕</button>
            </div>
            <div className="tpl-preview-body">
              {activeType === 'email' && (
                <>
                  <div className="tpl-preview-field">
                    <span className="tpl-preview-label">Subject</span>
                    <span className="tpl-preview-value">{previewItem.subjectLine || '(none)'}</span>
                  </div>
                  <div className="tpl-preview-field">
                    <span className="tpl-preview-label">Updated</span>
                    <span className="tpl-preview-value">{new Date(previewItem.updatedAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</span>
                  </div>
                  {previewItem.folder && (
                    <div className="tpl-preview-field">
                      <span className="tpl-preview-label">Folder</span>
                      <span className="badge badge-neutral">{previewItem.folder}</span>
                    </div>
                  )}
                  <div className="tpl-preview-actions">
                    <a href={`/email-builder?templateId=${getTplId(previewItem)}`} className="btn btn-primary btn-sm" style={{ width: '100%' }}>Open in Editor</a>
                  </div>
                </>
              )}
              {activeType === 'sms' && (
                <>
                  <div className="tpl-preview-field">
                    <span className="tpl-preview-label">Message</span>
                  </div>
                  <div className="tpl-preview-sms-body">{previewItem.body}</div>
                  <div className="tpl-preview-field" style={{ marginTop: 'var(--space-3)' }}>
                    <span className="tpl-preview-label">Segments</span>
                    <span className="tpl-preview-value">{previewItem.estimatedSegments} SMS segment{previewItem.estimatedSegments > 1 ? 's' : ''}</span>
                  </div>
                  <div className="tpl-preview-field">
                    <span className="tpl-preview-label">Characters</span>
                    <span className="tpl-preview-value">{previewItem.body.length}/160</span>
                  </div>
                </>
              )}
              {activeType === 'voice' && (
                <>
                  <div className="tpl-preview-field">
                    <span className="tpl-preview-label">Voice ID</span>
                    <span className="tpl-preview-value">{previewItem.voiceId}</span>
                  </div>
                  <div className="tpl-preview-field">
                    <span className="tpl-preview-label">Updated</span>
                    <span className="tpl-preview-value">{new Date(previewItem.updatedAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</span>
                  </div>
                  <div className="tpl-preview-actions">
                    <button className="btn btn-secondary btn-sm" style={{ width: '100%' }}>▶ Preview Voice</button>
                  </div>
                </>
              )}
              {activeType === 'webform' && (
                <>
                  <div className="tpl-preview-field">
                    <span className="tpl-preview-label">Description</span>
                    <span className="tpl-preview-value">{previewItem.description || '(none)'}</span>
                  </div>
                  <div className="tpl-preview-field">
                    <span className="tpl-preview-label">Fields ({previewItem.fields?.length || 0})</span>
                  </div>
                  <div className="tpl-preview-form-fields">
                    {(previewItem.fields || []).map((f: any) => (
                      <div key={f.fieldId} className="tpl-preview-form-field-item">
                        <span>{f.label}</span>
                        <span className="text-tertiary" style={{ fontSize: 'var(--text-xs)' }}>{f.type}{f.required ? ' •' : ''}</span>
                      </div>
                    ))}
                  </div>
                  <div className="tpl-preview-field" style={{ marginTop: 'var(--space-3)' }}>
                    <span className="tpl-preview-label">Submit Button</span>
                    <span className="tpl-preview-value">{previewItem.submitLabel}</span>
                  </div>
                  <div className="tpl-preview-field">
                    <span className="tpl-preview-label">Updated</span>
                    <span className="tpl-preview-value">{new Date(previewItem.updatedAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</span>
                  </div>
                  <div className="tpl-preview-actions">
                    <a href={`/email-builder?formId=${previewItem.formId}&mode=form`} className="btn btn-primary btn-sm" style={{ width: '100%' }}>Edit in Form Builder</a>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ===== NEW EMAIL MODAL ===== */}
      <Modal isOpen={showNewEmail} onClose={() => setShowNewEmail(false)} title="New Email">
        <form onSubmit={handleAddEmail}>
          <FormField label="Name" required>
            <FormInput placeholder="e.g. Welcome Series — Day 1" required value={emailName} onChange={(e) => setEmailName(e.target.value)} />
          </FormField>
          <FormField label="Subject Line" required>
            <FormInput placeholder="e.g. Welcome to {{company}}!" required value={emailSubject} onChange={(e) => setEmailSubject(e.target.value)} />
          </FormField>
          <FormActions>
            <button type="button" className="btn btn-secondary" onClick={() => setShowNewEmail(false)}>Cancel</button>
            <button type="submit" className="btn btn-primary">Create & Open Editor</button>
          </FormActions>
        </form>
      </Modal>

      {/* ===== NEW SMS MODAL ===== */}
      <Modal isOpen={showNewSms} onClose={() => setShowNewSms(false)} title="New SMS Message">
        <form onSubmit={handleAddSms}>
          <FormField label="Name" required>
            <FormInput placeholder="e.g. Appointment Reminder" required value={smsName} onChange={(e) => setSmsName(e.target.value)} />
          </FormField>
          <FormField label="Message Body" required hint={`${smsBody.length}/160 characters · ${Math.ceil(smsBody.length / 160) || 1} SMS segment(s)`}>
            <FormTextarea placeholder="Hi {{first_name}}, this is a reminder..." required value={smsBody} onChange={(e) => setSmsBody(e.target.value)} style={{ minHeight: '120px' }} />
          </FormField>
          <div className="info-box" style={{ marginBottom: 'var(--space-5)', fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
            <strong>Merge tags:</strong> Use {'{{first_name}}'}, {'{{last_name}}'}, {'{{company}}'}, {'{{link}}'} for personalization.
          </div>
          <FormActions>
            <button type="button" className="btn btn-secondary" onClick={() => setShowNewSms(false)}>Cancel</button>
            <button type="submit" className="btn btn-primary">Save Message</button>
          </FormActions>
        </form>
      </Modal>

      {/* ===== NEW WEB FORM MODAL ===== */}
      <Modal isOpen={showNewWebForm} onClose={() => setShowNewWebForm(false)} title="New Web Form">
        <form onSubmit={(e) => {
          e.preventDefault();
          store.addWebForm({ name: webFormName, description: webFormDesc });
          showToast(`"${webFormName}" created`);
          setWebFormName(''); setWebFormDesc(''); setShowNewWebForm(false);
        }}>
          <FormField label="Form Name" required>
            <FormInput placeholder="e.g. Contact Us" required value={webFormName} onChange={(e) => setWebFormName(e.target.value)} />
          </FormField>
          <FormField label="Description">
            <FormTextarea placeholder="What is this form for?" value={webFormDesc} onChange={(e) => setWebFormDesc(e.target.value)} style={{ minHeight: '80px' }} />
          </FormField>
          <div className="info-box" style={{ marginBottom: 'var(--space-5)', fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
            A default form with Name, Email, and Message fields will be created. You can customize the fields after.
          </div>
          <FormActions>
            <button type="button" className="btn btn-secondary" onClick={() => setShowNewWebForm(false)}>Cancel</button>
            <button type="submit" className="btn btn-primary">Create Form</button>
          </FormActions>
        </form>
      </Modal>
    </>
  );
}
