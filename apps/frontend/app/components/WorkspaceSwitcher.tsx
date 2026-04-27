'use client';

import { useState, useRef, useEffect } from 'react';
import { useWorkspace } from '../lib/workspace';
import { showToast } from './Toast';

export default function WorkspaceSwitcher() {
  const { workspaces, activeWorkspace, switchWorkspace, createWorkspace, hydrated } = useWorkspace();
  const [isOpen, setIsOpen] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setIsOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleCreate = () => {
    if (!newName.trim()) return;
    createWorkspace(newName.trim());
    showToast(`Workspace "${newName.trim()}" created`);
    setNewName('');
    setShowCreate(false);
    setIsOpen(false);
  };

  const handleSwitch = (id: string) => {
    switchWorkspace(id);
    setIsOpen(false);
  };

  if (!hydrated) return null;

  // Generate avatar initials
  const initials = activeWorkspace.name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();

  return (
    <div className="ws-switcher" ref={menuRef}>
      {/* Current workspace button */}
      <button className="ws-switcher-btn" onClick={() => setIsOpen(!isOpen)}>
        <div className="ws-avatar">{initials}</div>
        <div className="ws-info">
          <span className="ws-name">MarketPro</span>
          <span className="ws-workspace">{activeWorkspace.name}</span>
        </div>
        <span className="ws-chevron">{isOpen ? '▲' : '▼'}</span>
      </button>

      {/* Dropdown menu */}
      {isOpen && (
        <div className="ws-dropdown">
          <div className="ws-dropdown-label">Workspaces</div>
          {workspaces.map((ws) => (
            <button
              key={ws.workspaceId}
              className={`ws-dropdown-item ${ws.workspaceId === activeWorkspace.workspaceId ? 'active' : ''}`}
              onClick={() => handleSwitch(ws.workspaceId)}
            >
              <div className="ws-dropdown-avatar">
                {ws.name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase()}
              </div>
              <span>{ws.name}</span>
              {ws.workspaceId === activeWorkspace.workspaceId && <span className="ws-check">✓</span>}
            </button>
          ))}

          <div className="ws-dropdown-divider" />

          {showCreate ? (
            <div className="ws-create-form">
              <input
                className="form-input"
                placeholder="Workspace name..."
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                autoFocus
              />
              <div className="ws-create-actions">
                <button className="btn btn-ghost btn-sm" onClick={() => { setShowCreate(false); setNewName(''); }}>Cancel</button>
                <button className="btn btn-primary btn-sm" onClick={handleCreate} disabled={!newName.trim()}>Create</button>
              </div>
            </div>
          ) : (
            <button className="ws-dropdown-item ws-create-btn" onClick={() => setShowCreate(true)}>
              <span className="ws-create-icon">+</span>
              <span>Create workspace</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
