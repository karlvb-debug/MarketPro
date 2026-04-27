'use client';

import { useTheme } from '../lib/theme';

export default function ThemeToggle() {
  const { theme, toggle } = useTheme();

  return (
    <button
      id="theme-toggle"
      className="theme-toggle"
      onClick={toggle}
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
      title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
    >
      <span className="theme-toggle-track">
        <span className="theme-toggle-thumb">
          <span className="theme-toggle-icon">
            {theme === 'dark' ? '🌙' : '☀️'}
          </span>
        </span>
      </span>
      <span className="theme-toggle-label">
        {theme === 'dark' ? 'Dark' : 'Light'}
      </span>
    </button>
  );
}
