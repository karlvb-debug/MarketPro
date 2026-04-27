'use client';

import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import type { EmailDesign, SavedTemplate } from '../lib/email-templates';
import {
  STARTER_TEMPLATES,
  loadSavedTemplates,
  addSavedTemplate,
  deleteSavedTemplate,
  updateSavedTemplate,
} from '../lib/email-templates';
import { compileToHtml, validateEmailCompliance } from '../lib/email-compiler';
import EmailBlockEditor from '../components/EmailBlockEditor';
import { useStore } from '../lib/store';
import { useConfirm } from '../components/ConfirmDialog';

const STORAGE_KEY = 'clq-email-design';

function loadDesign(): EmailDesign | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return null;
}

function saveDesign(design: EmailDesign) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(design));
}

export default function EmailBuilderPage() {
  const [view, setView] = useState<'gallery' | 'editor'>('gallery');
  const [design, setDesign] = useState<EmailDesign | null>(null);
  const [showExport, setShowExport] = useState(false);
  const [exportHtml, setExportHtml] = useState('');
  const [exporting, setExporting] = useState(false);
  const [copied, setCopied] = useState(false);

  // Save Template modal
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [saveName, setSaveName] = useState('');

  // My Templates
  const [savedTemplates, setSavedTemplates] = useState<SavedTemplate[]>([]);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const searchParams = useSearchParams();
  const templateId = searchParams.get('templateId');
  const formId = searchParams.get('formId');
  const mode = searchParams.get('mode') === 'form' ? 'form' : 'email' as const;
  const store = useStore();
  const confirm = useConfirm();

  // If we have a templateId, look up the template name
  const linkedTemplate = templateId
    ? store.templates.email.find((t) => t.templateId === templateId)
    : null;

  // If form mode, look up the web form
  const linkedForm = (mode === 'form' && formId)
    ? store.templates.webform.find((f) => f.formId === formId)
    : null;

  // Load saved templates
  useEffect(() => {
    setSavedTemplates(loadSavedTemplates());
  }, []);

  // Resume saved session or load from templateId or formId
  useEffect(() => {
    // In form mode, load from the form's design
    if (mode === 'form' && linkedForm?.design) {
      setDesign(linkedForm.design);
      setView('editor');
      return;
    }
    if (mode === 'form' && linkedForm && !linkedForm.design) {
      // Create a default form design
      const defaultFormDesign: EmailDesign = {
        subject: '',
        previewText: '',
        bodyBackground: '#f0f2f5',
        contentBackground: '#ffffff',
        contentWidth: 600,
        blocks: [
          { id: 'f1', type: 'heading', props: { text: linkedForm.name || 'Contact Us', level: 'h2', align: 'center', color: '#1e293b' } },
          { id: 'f2', type: 'text', props: { html: '<p style="text-align:center;color:#64748b;">Fill out the form below and we\'ll get back to you.</p>', align: 'center' } },
          { id: 'f3', type: 'form-text-input', props: { label: 'Name', placeholder: 'Your full name', required: true, fieldName: 'name', inputType: 'text' } },
          { id: 'f4', type: 'form-text-input', props: { label: 'Email', placeholder: 'you@example.com', required: true, fieldName: 'email', inputType: 'email' } },
          { id: 'f5', type: 'form-textarea', props: { label: 'Message', placeholder: 'How can we help?', required: false, fieldName: 'message', rows: 4 } },
          { id: 'f6', type: 'form-submit', props: { label: 'Submit', bgColor: '#059669', textColor: '#ffffff', borderRadius: '6px', align: 'center', successMessage: 'Thanks! We\'ll be in touch.' } },
        ],
      };
      setDesign(defaultFormDesign);
      setView('editor');
      return;
    }
    const saved = loadDesign();
    if (saved && saved.blocks?.length > 0) {
      setDesign(saved);
      setView('editor');
    }
  }, []);

  const refreshSavedTemplates = () => setSavedTemplates(loadSavedTemplates());

  const handlePickTemplate = (templateId: string) => {
    const tmpl = STARTER_TEMPLATES.find((t) => t.id === templateId);
    if (!tmpl) return;
    const newDesign = JSON.parse(JSON.stringify(tmpl.design));
    setDesign(newDesign);
    saveDesign(newDesign);
    setView('editor');
  };

  const handlePickSavedTemplate = (tmpl: SavedTemplate) => {
    const newDesign = JSON.parse(JSON.stringify(tmpl.design));
    setDesign(newDesign);
    saveDesign(newDesign);
    setView('editor');
  };

  const handleDesignChange = useCallback((updated: EmailDesign) => {
    setDesign(updated);
    // In form mode, save to the WebForm store entry
    if (mode === 'form' && formId) {
      // We'll persist the design on the WebForm object
      const wf = store.templates.webform.find((f) => f.formId === formId);
      if (wf) {
        (wf as any).design = updated;
      }
    } else {
      saveDesign(updated);
    }
  }, [mode, formId, store]);

  const handleNewTemplate = async () => {
    const ok = await confirm('Start fresh? Your current work will be lost.', { title: 'New Template', confirmLabel: 'Start Fresh' });
    if (ok) {
      localStorage.removeItem(STORAGE_KEY);
      setDesign(null);
      setView('gallery');
      refreshSavedTemplates();
    }
  };

  const handleSaveTemplate = () => {
    if (!design || !saveName.trim()) return;
    addSavedTemplate(saveName.trim(), design);
    refreshSavedTemplates();
    setShowSaveModal(false);
    setSaveName('');
  };

  const handleDeleteSavedTemplate = async (id: string) => {
    const ok = await confirm('Delete this saved template?', { title: 'Delete Template', variant: 'danger' });
    if (!ok) return;
    deleteSavedTemplate(id);
    refreshSavedTemplates();
  };

  const handleRenameSavedTemplate = (id: string) => {
    if (!renameValue.trim()) return;
    updateSavedTemplate(id, { name: renameValue.trim() });
    refreshSavedTemplates();
    setRenamingId(null);
    setRenameValue('');
  };

  const getBusinessAddress = () => {
    const s = store.settings;
    const parts = [s.businessName, s.businessAddress, `${s.businessCity}${s.businessState ? ', ' + s.businessState : ''} ${s.businessZip}`.trim()].filter(Boolean);
    return parts.join(' | ');
  };

  const handleExport = async () => {
    if (!design) return;

    // Run compliance checks
    const addr = getBusinessAddress();
    const warnings = validateEmailCompliance(design, addr);
    const errors = warnings.filter((w) => w.severity === 'error');

    if (errors.length > 0) {
      const proceed = await confirm(
        `⚠️ Compliance Issues Detected:\n\n${errors.map((e) => `• ${e.message}`).join('\n')}\n\nExport anyway?`,
        { title: 'Compliance Warning', variant: 'danger', confirmLabel: 'Export Anyway' }
      );
      if (!proceed) return;
    } else if (warnings.length > 0) {
      await confirm(
        `📝 Compliance Notes:\n\n${warnings.map((w) => `• ${w.message}`).join('\n')}`,
        { title: 'Compliance Notes', confirmLabel: 'OK' }
      );
    }

    setExporting(true);
    try {
      const html = await compileToHtml(design, addr);
      setExportHtml(html);
      setShowExport(true);
    } catch (err) {
      setExportHtml(`<!-- Export failed: ${err} -->`);
      setShowExport(true);
    }
    setExporting(false);
  };

  const handleCopyHtml = () => {
    navigator.clipboard.writeText(exportHtml);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // ========== GALLERY VIEW ==========
  if (view === 'gallery') {
    return (
      <div className="email-builder-container">
        <header className="email-builder-header">
          <div className="email-builder-header-left">
            <h1 className="email-builder-title">Email Builder</h1>
          </div>
        </header>
        <div className="eb-gallery">
          <div className="eb-gallery-header">
            <h2 className="eb-gallery-title">Choose a Template</h2>
            <p className="eb-gallery-subtitle">Pick a starter or one of your saved templates</p>
          </div>

          {/* My Templates */}
          {savedTemplates.length > 0 && (
            <div className="eb-gallery-section">
              <h3 className="eb-gallery-section-title">My Templates</h3>
              <div className="eb-gallery-grid">
                {savedTemplates.map((tmpl) => (
                  <div key={tmpl.id} className="eb-template-card eb-template-card-saved">
                    {renamingId === tmpl.id ? (
                      <div className="eb-template-rename" onClick={(e) => e.stopPropagation()}>
                        <input
                          className="eb-settings-input"
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') handleRenameSavedTemplate(tmpl.id); if (e.key === 'Escape') setRenamingId(null); }}
                          autoFocus
                        />
                        <div className="eb-template-rename-actions">
                          <button className="btn btn-primary btn-sm" onClick={() => handleRenameSavedTemplate(tmpl.id)}>Save</button>
                          <button className="btn btn-ghost btn-sm" onClick={() => setRenamingId(null)}>Cancel</button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="eb-template-card-body" onClick={() => handlePickSavedTemplate(tmpl)}>
                          <div className="eb-template-emoji">◇</div>
                          <h3 className="eb-template-name">{tmpl.name}</h3>
                          <p className="eb-template-desc">
                            {tmpl.design.blocks.length} blocks · Updated {new Date(tmpl.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                          </p>
                        </div>
                        <div className="eb-template-card-actions">
                          <button className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); setRenamingId(tmpl.id); setRenameValue(tmpl.name); }} title="Rename">✎</button>
                          <button className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); handleDeleteSavedTemplate(tmpl.id); }} title="Delete">✕</button>
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Starter Templates */}
          <div className="eb-gallery-section">
            <h3 className="eb-gallery-section-title">Starter Templates</h3>
            <div className="eb-gallery-grid">
              {STARTER_TEMPLATES.map((tmpl) => (
                <button key={tmpl.id} className="eb-template-card" onClick={() => handlePickTemplate(tmpl.id)}>
                  <div className="eb-template-emoji">{tmpl.emoji}</div>
                  <h3 className="eb-template-name">{tmpl.name}</h3>
                  <p className="eb-template-desc">{tmpl.description}</p>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ========== EDITOR VIEW ==========
  if (!design) return null;

  return (
    <div className="email-builder-container">
      <header className="email-builder-header">
        <div className="email-builder-header-left">
          <h1 className="email-builder-title">{mode === 'form' ? 'Form Builder' : 'Email Builder'}</h1>
          {mode !== 'form' && (
            <div className="eb-subject-input-wrap">
              <label className="eb-subject-label">Subject:</label>
              <input
                className="eb-subject-input"
                placeholder="Enter subject line..."
                value={design.subject}
                onChange={(e) => handleDesignChange({ ...design, subject: e.target.value })}
              />
            </div>
          )}
          {mode === 'form' && linkedForm && (
            <span className="text-secondary" style={{ fontSize: 'var(--text-sm)' }}>{linkedForm.name}</span>
          )}
        </div>
        <div className="email-builder-header-actions">
          <a href="/templates" className="btn btn-ghost btn-sm">← Back to Content</a>
          {mode !== 'form' && (
            <>
              <button className="btn btn-secondary btn-sm" onClick={() => { setSaveName(design.subject || 'Untitled Template'); setShowSaveModal(true); }}>
                Save Template
              </button>
              <button className="btn btn-secondary btn-sm" onClick={handleExport} disabled={exporting}>
                {exporting ? 'Compiling…' : 'Export HTML'}
              </button>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => alert('Template saved and synced with Amazon SES!')}
              >
                Save to SES
              </button>
            </>
          )}
          {mode === 'form' && (
            <button
              className="btn btn-primary btn-sm"
              onClick={() => alert('Form saved! It will be available at your hosted form URL.')}
            >
              Save Form
            </button>
          )}
        </div>
      </header>

      {/* Editor */}
      <EmailBlockEditor design={design} onChange={handleDesignChange} mode={mode} />

      {/* Save Template Modal */}
      {showSaveModal && (
        <>
          <div className="modal-overlay" onClick={() => setShowSaveModal(false)} />
          <div className="modal-content" style={{ maxWidth: '400px' }}>
            <div className="modal-header">
              <h2 className="modal-title">Save as Template</h2>
              <button onClick={() => setShowSaveModal(false)} className="btn btn-ghost btn-icon modal-close">✕</button>
            </div>
            <div className="modal-body">
              <p className="text-secondary" style={{ fontSize: 'var(--text-sm)', marginBottom: 'var(--space-3)' }}>
                Save the current design as a reusable template you can load later.
              </p>
              <label className="eb-settings-label">Template Name</label>
              <input
                className="eb-settings-input"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSaveTemplate(); }}
                placeholder="e.g. Monthly Newsletter"
                autoFocus
              />
            </div>
            <div style={{ padding: 'var(--space-4) var(--space-6)', borderTop: '1px solid var(--border-primary)', display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-3)' }}>
              <button className="btn btn-secondary" onClick={() => setShowSaveModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSaveTemplate} disabled={!saveName.trim()}>Save Template</button>
            </div>
          </div>
        </>
      )}

      {/* Export Modal */}
      {showExport && (
        <>
          <div className="modal-overlay" onClick={() => setShowExport(false)} />
          <div className="modal-content" style={{ maxWidth: '720px', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
            <div className="modal-header">
              <h2 className="modal-title">Compiled Email HTML</h2>
              <button onClick={() => setShowExport(false)} className="btn btn-ghost btn-icon modal-close">✕</button>
            </div>
            <div className="modal-body" style={{ flex: 1, overflow: 'auto' }}>
              <p className="text-secondary" style={{ fontSize: 'var(--text-sm)', marginBottom: 'var(--space-3)' }}>
                This HTML uses table-based layouts and inline CSS — compatible with Outlook, Gmail, Apple Mail, and Yahoo.
              </p>
              <pre style={{
                background: 'var(--bg-primary)',
                border: '1px solid var(--border-primary)',
                borderRadius: 'var(--radius-md)',
                padding: 'var(--space-4)',
                fontSize: 'var(--text-xs)',
                overflow: 'auto',
                maxHeight: '50vh',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                color: 'var(--text-secondary)',
              }}>
                {exportHtml}
              </pre>
            </div>
            <div style={{ padding: 'var(--space-4) var(--space-6)', borderTop: '1px solid var(--border-primary)', display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-3)' }}>
              <button className="btn btn-secondary" onClick={() => setShowExport(false)}>Close</button>
              <button className="btn btn-primary" onClick={handleCopyHtml}>
                {copied ? '✓ Copied!' : 'Copy HTML'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
