'use client';

import { useState, useRef } from 'react';
import { useStore, Segment, SegmentFolder } from '../lib/store';
import { showToast } from './Toast';

interface SegmentPanelProps {
  activeSegmentId: string | null; // null = "All Contacts"
  onSelectSegment: (segmentId: string | null) => void;
}

export default function SegmentPanel({ activeSegmentId, onSelectSegment }: SegmentPanelProps) {
  const store = useStore();
  const { segments, segmentFolders, contacts } = store;

  const [search, setSearch] = useState('');
  const [creatingIn, setCreatingIn] = useState<string | false>(false); // folder name or '' for uncategorized
  const [newName, setNewName] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);

  // Filter segments by search
  const filteredSegments = search
    ? segments.filter((s) => s.name.toLowerCase().includes(search.toLowerCase()))
    : segments;

  // Group by folder
  const uncategorized = filteredSegments.filter((s) => !s.folder).sort((a, b) => a.order - b.order);
  const folders = (segmentFolders || []).sort((a, b) => a.order - b.order);

  const handleCreateSegment = (folder: string) => {
    if (!newName.trim()) return;
    store.addSegment(newName.trim(), '', folder);
    showToast(`Segment "${newName.trim()}" created`);
    setNewName('');
    setCreatingIn(false);
  };

  const handleCreateFolder = () => {
    if (!newFolderName.trim()) return;
    store.addSegmentFolder(newFolderName.trim());
    showToast(`Folder "${newFolderName.trim()}" created`);
    setNewFolderName('');
    setCreatingFolder(false);
  };

  const handleRename = (segmentId: string) => {
    if (!editName.trim()) { setEditingId(null); return; }
    store.renameSegment(segmentId, editName.trim());
    setEditingId(null);
  };

  // Drag & Drop
  const handleDragStart = (segmentId: string) => setDragId(segmentId);
  const handleDragEnd = () => { setDragId(null); setDragOverFolder(null); };

  const handleDropOnFolder = (folderName: string) => {
    if (dragId) {
      store.moveSegmentToFolder(dragId, folderName);
      showToast('Segment moved');
    }
    setDragId(null);
    setDragOverFolder(null);
  };

  // Segment item renderer
  const renderSegmentItem = (seg: Segment) => {
    const isActive = activeSegmentId === seg.segmentId;
    const isEditing = editingId === seg.segmentId;
    const count = seg.count;

    return (
      <div
        key={seg.segmentId}
        className={`sp-item ${isActive ? 'active' : ''} ${dragId === seg.segmentId ? 'dragging' : ''}`}
        onClick={() => !isEditing && onSelectSegment(seg.segmentId)}
        draggable
        onDragStart={() => handleDragStart(seg.segmentId)}
        onDragEnd={handleDragEnd}
      >
        {isEditing ? (
          <input
            className="sp-inline-input"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleRename(seg.segmentId); if (e.key === 'Escape') setEditingId(null); }}
            onBlur={() => handleRename(seg.segmentId)}
            autoFocus
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <>
            <span className="sp-item-name">{seg.name}</span>
            <span className="sp-item-count">{count}</span>
          </>
        )}
        <div className="sp-item-actions" onClick={(e) => e.stopPropagation()}>
          <button
            className="sp-action-btn"
            title="Rename"
            onClick={() => { setEditingId(seg.segmentId); setEditName(seg.name); }}
          >✎</button>
          <button
            className="sp-action-btn"
            title="Delete"
            onClick={() => {
              if (confirm(`Delete "${seg.name}"? Contacts won't be deleted.`)) {
                store.deleteSegment(seg.segmentId);
                if (activeSegmentId === seg.segmentId) onSelectSegment(null);
                showToast(`Segment "${seg.name}" deleted`);
              }
            }}
          >✕</button>
        </div>
      </div>
    );
  };

  // Inline create input
  const renderCreateInput = (folder: string) => (
    <div className="sp-create-input">
      <input
        ref={inputRef}
        className="sp-inline-input"
        placeholder="Segment name..."
        value={newName}
        onChange={(e) => setNewName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') handleCreateSegment(folder); if (e.key === 'Escape') setCreatingIn(false); }}
        onBlur={() => { if (!newName.trim()) setCreatingIn(false); }}
        autoFocus
      />
    </div>
  );

  return (
    <div className="sp">
      {/* Header */}
      <div className="sp-header">
        <span className="sp-title">SEGMENTS</span>
        <div className="sp-header-actions">
          <button className="sp-header-btn" title="New Folder" onClick={() => setCreatingFolder(true)}>+</button>
          <button className="sp-header-btn" title="New Segment" onClick={() => { setCreatingIn(''); setTimeout(() => inputRef.current?.focus(), 50); }}>+</button>
        </div>
      </div>

      {/* Search */}
      <div className="sp-search">
        <input
          className="sp-search-input"
          placeholder="Search segments..."
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

      {/* All Contacts */}
      <div
        className={`sp-item sp-all ${activeSegmentId === null ? 'active' : ''}`}
        onClick={() => onSelectSegment(null)}
      >
        <span className="sp-item-name">All Contacts</span>
        <span className="sp-item-count">{contacts.length}</span>
      </div>

      <div className="sp-list">
        {/* Folders */}
        {folders.map((folder) => {
          const folderSegments = filteredSegments
            .filter((s) => s.folder === folder.name)
            .sort((a, b) => a.order - b.order);

          return (
            <div key={folder.folderId} className="sp-folder">
              <div
                className={`sp-folder-header ${dragOverFolder === folder.name ? 'drag-over' : ''}`}
                onClick={() => store.toggleFolderExpanded(folder.folderId)}
                onDragOver={(e) => { e.preventDefault(); setDragOverFolder(folder.name); }}
                onDragLeave={() => setDragOverFolder(null)}
                onDrop={(e) => { e.preventDefault(); handleDropOnFolder(folder.name); }}
              >
                <span className="sp-folder-chevron">{folder.isExpanded ? '▼' : '▶'}</span>
                <span className="sp-folder-name">{folder.name}</span>
                <div className="sp-item-actions" onClick={(e) => e.stopPropagation()}>
                  <button className="sp-action-btn" title="Add segment" onClick={() => { setCreatingIn(folder.name); }}>+</button>
                  <button className="sp-action-btn" title="Delete folder" onClick={() => {
                    if (confirm(`Delete folder "${folder.name}"? Segments inside will become uncategorized.`)) {
                      store.deleteSegmentFolder(folder.folderId);
                      showToast(`Folder "${folder.name}" deleted`);
                    }
                  }}>✕</button>
                </div>
              </div>
              {folder.isExpanded && (
                <div className="sp-folder-items">
                  {folderSegments.map(renderSegmentItem)}
                  {creatingIn === folder.name && renderCreateInput(folder.name)}
                  {folderSegments.length === 0 && creatingIn !== folder.name && (
                    <div className="sp-empty">Drop segments here</div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {/* Uncategorized */}
        {(uncategorized.length > 0 || creatingIn === '') && (
          <div className="sp-folder">
            {folders.length > 0 && (
              <div
                className={`sp-folder-header ${dragOverFolder === '' ? 'drag-over' : ''}`}
                onDragOver={(e) => { e.preventDefault(); setDragOverFolder(''); }}
                onDragLeave={() => setDragOverFolder(null)}
                onDrop={(e) => { e.preventDefault(); handleDropOnFolder(''); }}
              >
                <span className="sp-folder-chevron">▼</span>
                <span className="sp-folder-name">Uncategorized</span>
              </div>
            )}
            <div className={folders.length > 0 ? 'sp-folder-items' : ''}>
              {uncategorized.map(renderSegmentItem)}
              {creatingIn === '' && renderCreateInput('')}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
