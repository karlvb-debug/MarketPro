'use client';

import { InputHTMLAttributes, forwardRef } from 'react';

// ============================================
// SearchInput — search field with icon
// Extracted from repeated patterns across pages
// ============================================

export interface SearchInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Called when value changes */
  onValueChange?: (value: string) => void;
}

const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(
  ({ onValueChange, onChange, className = '', ...props }, ref) => {
    return (
      <div className={`search-input-wrapper ${className}`}>
        <span className="search-icon">⌕</span>
        <input
          ref={ref}
          type="search"
          className="search-input"
          onChange={(e) => {
            onChange?.(e);
            onValueChange?.(e.target.value);
          }}
          {...props}
        />
      </div>
    );
  },
);

SearchInput.displayName = 'SearchInput';
export default SearchInput;
