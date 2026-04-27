'use client';

import { useState, useRef } from 'react';
import { useStore, TemplateFolder, EmailTemplate, SmsTemplate, VoiceScript, WebForm } from '../lib/store';
import { showToast } from './Toast';

interface TemplateFolderPanelProps {
  activeFolderId: string | null; // null = "All Templates"
  activeType: 'email' | 'sms' | 'voice' | 'webform';
  onSelectFolder: (folderId: string | null) => void;
}

// Get the template ID from any template type
function getTemplateId(t: any): string {
  return t.templateId || t.scriptId || t.formId;
}

export default function TemplateFolderPanel({ activeFolderId, activeType, onSelectFolder }: TemplateFolderPanelProps) {
  const store = useStore();
  const { templates, templateFolders } = store;

  const [search, setSearch] = useState('');
  const [creatingIn, setCreatingIn] = useState<string | false>(false);
  const [newName, setNewName] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);

  // Get all templates for the active type
  const allTemplates = templates[activeType] as any[];
  const totalCount = allTemplates.length;

  // Group by folder
  const folders = (templateFolders || []).sort((a, b) => a.order - b.order);

  // Count templates per folder for the active type
  const countInFolder = (folderName: string) =>
    allTemplates.filter((t: any) => (t.folder || '') === folderName).length;

  const handleCreateFolder = () => {
    if (!newFolderName.trim()) return;
    store.addTemplateFolder(newFolderName.trim());
    showToast(`Folder "${newFolderName.trim()}" created`);
    setNewFolderName('');
    setCreatingFolder(false);
  };

  // Drag & Drop
  const handleDragStart = (templateId: string) => setDragId(templateId);
  const handleDragEnd = () => { setDragId(null); setDragOverFolder(null); };

  const handleDropOnFolder = (folderName: string) => {
    if (dragId) {
      store.moveTemplateToFolder(dragId, activeType, folderName);
      showToast('Template moved');
    }
    setDragId(null);
    setDragOverFolder(null);
  };

  // Folder item with count
  const renderFolderItem = (folder: TemplateFolder) => {
    const count = countInFolder(folder.name);
    const isActive = activeFolderId === folder.folderId;

    return (
      <div key={folder.folderId} className="sp-folder">
        <div
          className={`sp-folder-header ${dragOverFolder === folder.name ? 'drag-over' : ''} ${isActive ? 'active' : ''}`}
          onClick={() => onSelectFolder(folder.folderId)}
          onDragOver={(e) => { e.preventDefault(); setDragOverFolder(folder.name); }}
          onDragLeave={() => setDragOverFolder(null)}
          onDrop={(e) => { e.preventDefault(); handleDropOnFolder(folder.name); }}
        >
          <span
            className="sp-folder-chevron"
            onClick={(e) => { e.stopPropagation(); store.toggleTemplateFolderExpanded(folder.folderId); }}
          >{folder.isExpanded ? '▼' : '▶'}</span>
          <span className="sp-folder-name">{folder.name}</span>
          <span className="sp-item-count">{count}</span>
          <div className="sp-item-actions" onClick={(e) => e.stopPropagation()}>
            <button className="sp-action-btn" title="Delete folder" onClick={() => {
              if (confirm(`Delete folder "${folder.name}"? Templates inside will become uncategorized.`)) {
                store.deleteTemplateFolder(folder.folderId);
                if (activeFolderId === folder.folderId) onSelectFolder(null);
                showToast(`Folder "${folder.name}" deleted`);
              }
            }}>✕</button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="sp">
      {/* Header */}
      <div className="sp-header">
        <span className="sp-title">FOLDERS</span>
        <div className="sp-header-actions">
          <button className="sp-header-btn" title="New Folder" onClick={() => setCreatingFolder(true)}>+</button>
        </div>
      </div>

      {/* Search */}
      <div className="sp-search">
        <input
          className="sp-search-input"
          placeholder="Search folders..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* Create folder inline */}
      {creatingFolder && (
        <div className="sp-create-input" style={{ padding: '0 var(--space-3)', marginBottom: 'var(--space-2)' }}>
          <input
            className="sp-inline-input"
            placeholder="Folder name..."
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleCreateFolder(); if (e.key === 'Escape') setCreatingFolder(false); }}
            onBlur={() => { if (!newFolderName.trim()) setCreatingFolder(false); }}
            autoFocus
          />
        </div>
      )}

      {/* All Templates */}
      <div
        className={`sp-item sp-all ${activeFolderId === null ? 'active' : ''}`}
        onClick={() => onSelectFolder(null)}
        onDragOver={(e) => { e.preventDefault(); setDragOverFolder('__all__'); }}
        onDragLeave={() => setDragOverFolder(null)}
        onDrop={(e) => { e.preventDefault(); handleDropOnFolder(''); }}
      >
        <span className="sp-item-name">All Templates</span>
        <span className="sp-item-count">{totalCount}</span>
      </div>

      <div className="sp-list">
        {/* Folders */}
        {folders
          .filter((f) => !search || f.name.toLowerCase().includes(search.toLowerCase()))
          .map(renderFolderItem)}

        {/* Uncategorized count */}
        {folders.length > 0 && (
          <div
            className={`sp-item ${activeFolderId === '__uncategorized__' ? 'active' : ''}`}
            onClick={() => onSelectFolder('__uncategorized__')}
            onDragOver={(e) => { e.preventDefault(); setDragOverFolder(''); }}
            onDragLeave={() => setDragOverFolder(null)}
            onDrop={(e) => { e.preventDefault(); handleDropOnFolder(''); }}
          >
            <span className="sp-item-name" style={{ color: 'var(--text-tertiary)' }}>Uncategorized</span>
            <span className="sp-item-count">{countInFolder('')}</span>
          </div>
        )}
      </div>
    </div>
  );
}
