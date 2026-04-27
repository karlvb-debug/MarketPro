'use client';

import { ReactNode } from 'react';

// ============================================
// Tabs — tabbed navigation
// ============================================

interface Tab {
  id: string;
  label: string;
  count?: number;
  icon?: string;
}

interface TabsProps {
  tabs: Tab[];
  activeTab: string;
  onTabChange: (tabId: string) => void;
}

export default function Tabs({ tabs, activeTab, onTabChange }: TabsProps) {
  return (
    <div className="tabs">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          className={`tab ${activeTab === tab.id ? 'active' : ''}`}
          onClick={() => onTabChange(tab.id)}
        >
          {tab.icon && <span>{tab.icon} </span>}
          {tab.label}
          {tab.count !== undefined && ` (${tab.count})`}
        </button>
      ))}
    </div>
  );
}

// ============================================
// SearchInput — search field with icon
// ============================================

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  fullWidth?: boolean;
}

export function SearchInput({ value, onChange, placeholder = 'Search...', fullWidth }: SearchInputProps) {
  return (
    <div className="search-input-wrapper" style={fullWidth ? { maxWidth: '100%' } : undefined}>
      <span className="search-input-icon">⌕</span>
      <input
        type="text"
        className="search-input"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={fullWidth ? { width: '100%' } : undefined}
      />
    </div>
  );
}
