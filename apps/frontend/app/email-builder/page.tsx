'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import type { EmailDesign } from '../lib/email-templates';
import { STARTER_TEMPLATES } from '../lib/email-templates';
import { compileToHtml, validateEmailCompliance, applyMergeSamples } from '../lib/email-compiler';
import EmailBlockEditor from '../components/EmailBlockEditor';
import { useStore } from '../lib/store';
import { useAuth } from '../lib/auth';
import { api, ApiError } from '../lib/api-client';
import { useConfirm } from '../components/ConfirmDialog';
import { showToast } from '../components/ui/Toast';
import LoadingState from '../components/ui/LoadingState';

// Local draft autosave for crash/refresh recovery only — the server template
// is the system of record (see docs/plans/email-mvp.md E1).
const DRAFT_KEY = 'clq-email-design';

function loadDraft(): EmailDesign | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* corrupt draft — start fresh */ }
  return null;
}

function saveDraft(design: EmailDesign) {
  if (typeof window === 'undefined') return;
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(design)); } catch { /* quota — ignore */ }
}

function emptyEmailDesign(subject: string): EmailDesign {
  return {
    subject,
    previewText: '',
    bodyBackground: '#f0f2f5',
    contentBackground: '#ffffff',
    contentWidth: 600,
    blocks: [],
  };
}

export default function EmailBuilderPage() {
  const [view, setView] = useState<'gallery' | 'editor'>('gallery');
  const [design, setDesign] = useState<EmailDesign | null>(null);
  const [showExport, setShowExport] = useState(false);
  const [exportHtml, setExportHtml] = useState('');
  const [exporting, setExporting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);

  // Save modal (names a brand-new template before its first server save)
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [saveName, setSaveName] = useState('');

  // The server template this design is bound to (null = unsaved/new)
  const [currentTemplateId, setCurrentTemplateId] = useState<string | null>(null);

  // Preview modal (device width + sample-data merge toggle)
  const [showPreview, setShowPreview] = useState(false);
  const [previewDevice, setPreviewDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [previewSamples, setPreviewSamples] = useState(true);
  const [previewHtml, setPreviewHtml] = useState('');

  // Test-send modal
  const [showTestSend, setShowTestSend] = useState(false);
  const [testTo, setTestTo] = useState('');
  const [testSending, setTestSending] = useState(false);

  const { user } = useAuth();
  const searchParams = useSearchParams();
  const formId = searchParams.get('formId');
  const templateId = searchParams.get('templateId');
  const mode = searchParams.get('mode') === 'form' ? 'form' : 'email' as const;
  const store = useStore();
  const confirm = useConfirm();

  const linkedForm = (mode === 'form' && formId)
    ? store.templates.webform.find((f) => f.formId === formId)
    : null;

  // One-time migration: the old localStorage "saved templates" list is no
  // longer the source of truth (server templates are). Drop it cleanly.
  useEffect(() => {
    try { localStorage.removeItem('clq-saved-templates'); } catch { /* ignore */ }
  }, []);

  // Initialize the editing session: a server template (?templateId), a form,
  // or a recovered local draft. Waits for the store to hydrate when loading a
  // server template so its editor_json is available.
  const initializedRef = useRef(false);
  useEffect(() => {
    if (initializedRef.current) return;

    if (mode === 'form' && linkedForm) {
      initializedRef.current = true;
      setDesign(linkedForm.design ?? emptyEmailDesign(linkedForm.name || 'Contact Us'));
      setView('editor');
      return;
    }

    if (templateId) {
      if (!store.hydrated) return; // wait for templates to load, then re-run
      initializedRef.current = true;
      const tmpl = store.templates.email.find((t) => t.templateId === templateId);
      if (tmpl?.editorJson && Array.isArray(tmpl.editorJson.blocks)) {
        setDesign(tmpl.editorJson);
      } else {
        // Template exists but has no saved design yet (created name+subject only)
        setDesign(emptyEmailDesign(tmpl?.subjectLine || ''));
      }
      setCurrentTemplateId(templateId);
      setSaveName(tmpl?.name || '');
      setView('editor');
      return;
    }

    // No target: offer to resume a local draft.
    initializedRef.current = true;
    const draft = loadDraft();
    if (draft && draft.blocks?.length > 0) {
      setDesign(draft);
      setView('editor');
    }
  }, [mode, linkedForm, templateId, store.hydrated, store.templates.email]);

  const handlePickTemplate = (starterId: string) => {
    const tmpl = STARTER_TEMPLATES.find((t) => t.id === starterId);
    if (!tmpl) return;
    const newDesign = JSON.parse(JSON.stringify(tmpl.design));
    setCurrentTemplateId(null); // starting fresh — first save creates a template
    setDesign(newDesign);
    saveDraft(newDesign);
    setView('editor');
  };

  const handleOpenServerTemplate = (id: string) => {
    const tmpl = store.templates.email.find((t) => t.templateId === id);
    if (!tmpl) return;
    setDesign(tmpl.editorJson && Array.isArray(tmpl.editorJson.blocks)
      ? tmpl.editorJson
      : emptyEmailDesign(tmpl.subjectLine || ''));
    setCurrentTemplateId(id);
    setSaveName(tmpl.name);
    setView('editor');
  };

  const handleDesignChange = useCallback((updated: EmailDesign) => {
    setDesign(updated);
    if (mode === 'form' && formId) {
      const wf = store.templates.webform.find((f) => f.formId === formId);
      if (wf) wf.design = updated;
    } else {
      saveDraft(updated);
    }
  }, [mode, formId, store]);

  const getBusinessAddress = () => {
    const s = store.settings;
    const parts = [s.businessName, s.businessAddress, `${s.businessCity}${s.businessState ? ', ' + s.businessState : ''} ${s.businessZip}`.trim()].filter(Boolean);
    return parts.join(' | ');
  };

  // Compile + persist the design to the server (create or update).
  const persistToServer = useCallback(async (name: string) => {
    if (!design) return;
    setSaving(true);
    try {
      let html: string;
      try {
        html = await compileToHtml(design, getBusinessAddress());
      } catch {
        showToast('Could not compile the email — please review the design.', 'error');
        return;
      }
      if (currentTemplateId) {
        const ok = await store.saveEmailDesign(currentTemplateId, {
          name, subjectLine: design.subject, htmlContent: html, editorJson: design,
        });
        if (ok) showToast('Email saved');
      } else {
        const id = await store.addEmailTemplate({
          name, subjectLine: design.subject, htmlContent: html, editorJson: design,
        });
        if (id) { setCurrentTemplateId(id); showToast('Email saved'); }
      }
    } finally {
      setSaving(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [design, currentTemplateId, store]);

  // Warn on hard compliance errors before saving (mirrors the Export flow).
  const passesComplianceGate = useCallback(async (): Promise<boolean> => {
    if (!design) return false;
    const errors = validateEmailCompliance(design, getBusinessAddress()).filter((w) => w.severity === 'error');
    if (errors.length === 0) return true;
    return confirm(
      `⚠️ Compliance issues:\n\n${errors.map((e) => `• ${e.message}`).join('\n')}\n\nSave anyway?`,
      { title: 'Compliance Warning', variant: 'danger', confirmLabel: 'Save Anyway' },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [design, confirm]);

  // Header save: existing template saves directly; a new one names itself first.
  const handleSave = async () => {
    if (!design) return;
    if (!(await passesComplianceGate())) return;
    if (currentTemplateId) {
      void persistToServer(saveName || design.subject || 'Untitled Email');
    } else {
      setSaveName(design.subject || 'Untitled Email');
      setShowSaveModal(true);
    }
  };

  // Build the preview HTML (optionally with sample merge values resolved).
  const openPreview = async () => {
    if (!design) return;
    setShowPreview(true);
    setPreviewHtml('');
    try {
      let html = await compileToHtml(design, getBusinessAddress());
      if (previewSamples) html = applyMergeSamples(html);
      setPreviewHtml(html);
    } catch {
      setPreviewHtml('<p style="padding:1rem;font-family:sans-serif">Could not render preview.</p>');
    }
  };

  // Re-render when the sample toggle flips while the preview is open.
  useEffect(() => {
    if (!showPreview || !design) return;
    let cancelled = false;
    (async () => {
      try {
        let html = await compileToHtml(design, getBusinessAddress());
        if (previewSamples) html = applyMergeSamples(html);
        if (!cancelled) setPreviewHtml(html);
      } catch { /* keep prior */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewSamples]);

  const openTestSend = () => {
    if (!currentTemplateId) {
      showToast('Save the email first, then send a test.', 'info');
      return;
    }
    setTestTo(user?.email || '');
    setShowTestSend(true);
  };

  const handleSendTest = async () => {
    if (!currentTemplateId || !testTo.trim()) return;
    setTestSending(true);
    try {
      await api.email.testSend({ templateId: currentTemplateId, to: testTo.trim() });
      showToast(`Test sent to ${testTo.trim()}`);
      setShowTestSend(false);
    } catch (err) {
      showToast((err as Partial<ApiError> | null)?.message || 'Failed to send test email.', 'error');
    } finally {
      setTestSending(false);
    }
  };

  const handleConfirmSaveNew = async () => {
    if (!saveName.trim()) return;
    setShowSaveModal(false);
    await persistToServer(saveName.trim());
  };

  const handleExport = async () => {
    if (!design) return;
    const addr = getBusinessAddress();
    const warnings = validateEmailCompliance(design, addr);
    const errors = warnings.filter((w) => w.severity === 'error');
    if (errors.length > 0) {
      const proceed = await confirm(
        `⚠️ Compliance Issues Detected:\n\n${errors.map((e) => `• ${e.message}`).join('\n')}\n\nExport anyway?`,
        { title: 'Compliance Warning', variant: 'danger', confirmLabel: 'Export Anyway' },
      );
      if (!proceed) return;
    } else if (warnings.length > 0) {
      await confirm(
        `📝 Compliance Notes:\n\n${warnings.map((w) => `• ${w.message}`).join('\n')}`,
        { title: 'Compliance Notes', confirmLabel: 'OK' },
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

  // Loading a server template that hasn't hydrated yet.
  if (templateId && !store.hydrated && view === 'gallery' && !design) {
    return <LoadingState />;
  }

  // ========== GALLERY VIEW ==========
  if (view === 'gallery') {
    const serverTemplates = [...store.templates.email].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
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
            <p className="eb-gallery-subtitle">Pick a starter or open one of your saved emails</p>
          </div>

          {/* My Templates — server-backed */}
          {serverTemplates.length > 0 && (
            <div className="eb-gallery-section">
              <h3 className="eb-gallery-section-title">My Templates</h3>
              <div className="eb-gallery-grid">
                {serverTemplates.map((tmpl) => (
                  <button
                    key={tmpl.templateId}
                    className="eb-template-card eb-template-card-saved"
                    onClick={() => handleOpenServerTemplate(tmpl.templateId)}
                  >
                    <div className="eb-template-emoji">◇</div>
                    <h3 className="eb-template-name">{tmpl.name}</h3>
                    <p className="eb-template-desc">
                      {tmpl.editorJson?.blocks?.length
                        ? `${tmpl.editorJson.blocks.length} blocks`
                        : 'No design yet'}
                      {tmpl.updatedAt ? ` · Updated ${new Date(tmpl.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : ''}
                    </p>
                  </button>
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
  if (!design) return <LoadingState />;

  return (
    <div className="email-builder-container">
      <header className="email-builder-header">
        <div className="email-builder-header-left">
          <h1 className="email-builder-title">{mode === 'form' ? 'Form Builder' : 'Email Builder'}</h1>
          {mode !== 'form' && (
            <div className="eb-subject-input-wrap">
              <label className="eb-subject-label" htmlFor="eb-subject">Subject:</label>
              <input
                id="eb-subject"
                className="eb-subject-input"
                placeholder="Enter subject line..."
                value={design.subject}
                onChange={(e) => handleDesignChange({ ...design, subject: e.target.value })}
              />
              <label className="eb-subject-label" htmlFor="eb-preheader">Preview:</label>
              <input
                id="eb-preheader"
                className="eb-subject-input"
                placeholder="Inbox preview text…"
                title="Shown as the inbox preview snippet after the subject."
                value={design.previewText}
                onChange={(e) => handleDesignChange({ ...design, previewText: e.target.value })}
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
              <button className="btn btn-ghost btn-sm" onClick={openPreview}>Preview</button>
              <button className="btn btn-ghost btn-sm" onClick={openTestSend} title={currentTemplateId ? 'Send a test email' : 'Save first to send a test'}>
                Send test
              </button>
              <button className="btn btn-secondary btn-sm" onClick={handleExport} disabled={exporting}>
                {exporting ? 'Compiling…' : 'Export HTML'}
              </button>
              <button className="btn btn-primary btn-sm" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </>
          )}
          {mode === 'form' && (
            <button
              className="btn btn-primary btn-sm"
              onClick={() => showToast('Form saved.')}
            >
              Save Form
            </button>
          )}
        </div>
      </header>

      {/* Editor */}
      <EmailBlockEditor design={design} onChange={handleDesignChange} mode={mode} />

      {/* Name-and-save modal (first save of a new email) */}
      {showSaveModal && (
        <>
          <div className="modal-overlay" onClick={() => setShowSaveModal(false)} />
          <div className="modal-content" role="dialog" aria-modal="true" aria-label="Save email" style={{ maxWidth: '400px' }}>
            <div className="modal-header">
              <h2 className="modal-title">Save Email</h2>
              <button onClick={() => setShowSaveModal(false)} className="btn btn-ghost btn-icon modal-close" aria-label="Close dialog">✕</button>
            </div>
            <div className="modal-body">
              <p className="text-secondary" style={{ fontSize: 'var(--text-sm)', marginBottom: 'var(--space-3)' }}>
                Save this email to your templates. You can build campaigns from it and edit it later.
              </p>
              <label className="eb-settings-label" htmlFor="eb-save-name">Template Name</label>
              <input
                id="eb-save-name"
                className="eb-settings-input"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleConfirmSaveNew(); }}
                placeholder="e.g. Monthly Newsletter"
                autoFocus
              />
            </div>
            <div style={{ padding: 'var(--space-4) var(--space-6)', borderTop: '1px solid var(--border-primary)', display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-3)' }}>
              <button className="btn btn-secondary" onClick={() => setShowSaveModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleConfirmSaveNew} disabled={!saveName.trim() || saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </>
      )}

      {/* Preview Modal (device width + sample-data toggle) */}
      {showPreview && (
        <>
          <div className="modal-overlay" onClick={() => setShowPreview(false)} />
          <div className="modal-content" role="dialog" aria-modal="true" aria-label="Email preview" style={{ maxWidth: '860px', maxHeight: '88vh', display: 'flex', flexDirection: 'column' }}>
            <div className="modal-header">
              <h2 className="modal-title">Preview</h2>
              <button onClick={() => setShowPreview(false)} className="btn btn-ghost btn-icon modal-close" aria-label="Close dialog">✕</button>
            </div>
            <div style={{ display: 'flex', gap: 'var(--space-2)', padding: 'var(--space-3) var(--space-6)', borderBottom: '1px solid var(--border-primary)', alignItems: 'center' }}>
              <div role="group" aria-label="Preview device" style={{ display: 'flex', gap: 'var(--space-1)' }}>
                <button className={`btn btn-sm ${previewDevice === 'desktop' ? 'btn-secondary' : 'btn-ghost'}`} aria-pressed={previewDevice === 'desktop'} onClick={() => setPreviewDevice('desktop')}>Desktop</button>
                <button className={`btn btn-sm ${previewDevice === 'mobile' ? 'btn-secondary' : 'btn-ghost'}`} aria-pressed={previewDevice === 'mobile'} onClick={() => setPreviewDevice('mobile')}>Mobile</button>
              </div>
              <label style={{ marginLeft: 'auto', display: 'flex', gap: 'var(--space-2)', alignItems: 'center', fontSize: 'var(--text-sm)' }}>
                <input type="checkbox" checked={previewSamples} onChange={(e) => setPreviewSamples(e.target.checked)} />
                Preview with sample data
              </label>
            </div>
            <div className="modal-body" style={{ flex: 1, overflow: 'auto', display: 'flex', justifyContent: 'center', background: 'var(--bg-primary)' }}>
              {previewHtml ? (
                <iframe
                  title="Email preview"
                  srcDoc={previewHtml}
                  style={{ width: previewDevice === 'mobile' ? '375px' : `${design.contentWidth}px`, maxWidth: '100%', height: '60vh', border: '1px solid var(--border-primary)', borderRadius: 'var(--radius-md)', background: '#fff' }}
                />
              ) : <LoadingState label="Rendering…" />}
            </div>
          </div>
        </>
      )}

      {/* Test-send Modal */}
      {showTestSend && (
        <>
          <div className="modal-overlay" onClick={() => setShowTestSend(false)} />
          <div className="modal-content" role="dialog" aria-modal="true" aria-label="Send test email" style={{ maxWidth: '420px' }}>
            <div className="modal-header">
              <h2 className="modal-title">Send Test Email</h2>
              <button onClick={() => setShowTestSend(false)} className="btn btn-ghost btn-icon modal-close" aria-label="Close dialog">✕</button>
            </div>
            <div className="modal-body">
              <p className="text-secondary" style={{ fontSize: 'var(--text-sm)', marginBottom: 'var(--space-3)' }}>
                Sends the <strong>saved</strong> version of this email, with sample merge values, to one address. It doesn&apos;t touch your audience or billing.
              </p>
              <label className="eb-settings-label" htmlFor="eb-test-to">Recipient</label>
              <input
                id="eb-test-to"
                type="email"
                className="eb-settings-input"
                value={testTo}
                onChange={(e) => setTestTo(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSendTest(); }}
                placeholder="you@example.com"
                autoFocus
              />
            </div>
            <div style={{ padding: 'var(--space-4) var(--space-6)', borderTop: '1px solid var(--border-primary)', display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-3)' }}>
              <button className="btn btn-secondary" onClick={() => setShowTestSend(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSendTest} disabled={!testTo.trim() || testSending}>
                {testSending ? 'Sending…' : 'Send test'}
              </button>
            </div>
          </div>
        </>
      )}

      {/* Export Modal */}
      {showExport && (
        <>
          <div className="modal-overlay" onClick={() => setShowExport(false)} />
          <div className="modal-content" role="dialog" aria-modal="true" aria-label="Compiled email HTML" style={{ maxWidth: '720px', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
            <div className="modal-header">
              <h2 className="modal-title">Compiled Email HTML</h2>
              <button onClick={() => setShowExport(false)} className="btn btn-ghost btn-icon modal-close" aria-label="Close dialog">✕</button>
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
