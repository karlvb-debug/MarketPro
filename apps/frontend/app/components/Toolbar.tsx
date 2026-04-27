'use client';

import { ReactNode } from 'react';

/**
 * Unified Toolbar — compact single-row bar with title, search, filters, actions.
 * On mobile, wraps to two rows automatically via CSS.
 */

interface ToolbarProps {
  title: string;
  count?: number;
  search?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  filters?: ReactNode;
  actions?: ReactNode;
  bulkBar?: ReactNode;
  /** Mobile-only: toggle for segment panel drawer */
  onTogglePanel?: () => void;
  panelOpen?: boolean;
}

export default function Toolbar({
  title,
  count,
  search,
  onSearchChange,
  searchPlaceholder = 'Search...',
  filters,
  actions,
  bulkBar,
  onTogglePanel,
  panelOpen,
}: ToolbarProps) {
  return (
    <div className="toolbar-wrapper">
      <div className="toolbar">
        {/* Mobile panel toggle */}
        {onTogglePanel && (
          <button
            className="toolbar-panel-toggle"
            onClick={onTogglePanel}
            aria-label="Toggle segments"
            title="Segments"
          >
            {panelOpen ? '✕' : '☰'}
          </button>
        )}

        {/* Left: Title + count */}
        <div className="toolbar-title-group">
          <h2 className="toolbar-title">{title}</h2>
          {count !== undefined && <span className="toolbar-count">{count.toLocaleString()}</span>}
        </div>

        {/* Center: Search + filters */}
        <div className="toolbar-center">
          {onSearchChange && (
            <div className="toolbar-search">
              <span className="toolbar-search-icon">⌕</span>
              <input
                type="text"
                className="toolbar-search-input"
                placeholder={searchPlaceholder}
                value={search || ''}
                onChange={(e) => onSearchChange(e.target.value)}
              />
              {search && (
                <button className="toolbar-search-clear" onClick={() => onSearchChange('')}>×</button>
              )}
            </div>
          )}
          {filters && <div className="toolbar-filters">{filters}</div>}
        </div>

        {/* Right: Action buttons */}
        {actions && <div className="toolbar-actions">{actions}</div>}
      </div>

      {/* Bulk actions bar */}
      {bulkBar && <div className="toolbar-bulk">{bulkBar}</div>}
    </div>
  );
}
