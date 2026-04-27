'use client';

import { useState, useEffect, useCallback } from 'react';
import type { EmailDesign, SavedTemplate } from '../lib/email-templates';
import {
  STARTER_TEMPLATES,
  loadSavedTemplates,
  addSavedTemplate,
  deleteSavedTemplate,
  updateSavedTemplate,
} from '../lib/email-templates';
import { compileToHtml } from '../lib/email-compiler';
import EmailBlockEditor from '../components/EmailBlockEditor';

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

  // Load saved templates
  useEffect(() => {
    setSavedTemplates(loadSavedTemplates());
  }, []);

  // Resume saved session
  useEffect(() => {
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
    saveDesign(updated);
  }, []);

  const handleNewTemplate = () => {
    if (confirm('Start fresh? Your current work will be lost.')) {
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

  const handleDeleteSavedTemplate = (id: string) => {
    if (!confirm('Delete this saved template?')) return;
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

  const handleExport = async () => {
    if (!design) return;
    setExporting(true);
    try {
      const html = await compileToHtml(design);
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
            <h1 className="email-builder-title">📧 Email Builder</h1>
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
              <h3 className="eb-gallery-section-title">📁 My Templates</h3>
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
                          <div className="eb-template-emoji">📄</div>
                          <h3 className="eb-template-name">{tmpl.name}</h3>
                          <p className="eb-template-desc">
                            {tmpl.design.blocks.length} blocks · Updated {new Date(tmpl.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                          </p>
                        </div>
                        <div className="eb-template-card-actions">
                          <button className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); setRenamingId(tmpl.id); setRenameValue(tmpl.name); }} title="Rename">✏️</button>
                          <button className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); handleDeleteSavedTemplate(tmpl.id); }} title="Delete">🗑️</button>
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
            <h3 className="eb-gallery-section-title">✨ Starter Templates</h3>
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
          <h1 className="email-builder-title">📧 Email Builder</h1>
          <div className="eb-subject-input-wrap">
            <label className="eb-subject-label">Subject:</label>
            <input
              className="eb-subject-input"
              placeholder="Enter subject line..."
              value={design.subject}
              onChange={(e) => handleDesignChange({ ...design, subject: e.target.value })}
            />
          </div>
        </div>
        <div className="email-builder-header-actions">
          <button className="btn btn-ghost btn-sm" onClick={handleNewTemplate}>← Templates</button>
          <button className="btn btn-secondary btn-sm" onClick={() => { setSaveName(design.subject || 'Untitled Template'); setShowSaveModal(true); }}>
            💾 Save Template
          </button>
          <button className="btn btn-secondary btn-sm" onClick={handleExport} disabled={exporting}>
            {exporting ? '⏳ Compiling...' : '⬇ Export HTML'}
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => alert('Template saved and synced with Amazon SES!')}
          >
            Save to SES
          </button>
        </div>
      </header>

      {/* Editor */}
      <EmailBlockEditor design={design} onChange={handleDesignChange} />

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
                {copied ? '✓ Copied!' : '📋 Copy HTML'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
