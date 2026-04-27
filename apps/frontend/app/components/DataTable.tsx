'use client';

import { ReactNode } from 'react';

// ============================================
// DataTable — wrapper with consistent styling
// ============================================

interface DataTableProps {
  headers: string[];
  children: ReactNode;
  noBorder?: boolean;
}

export default function DataTable({ headers, children, noBorder }: DataTableProps) {
  return (
    <div className="table-wrapper" style={noBorder ? { border: 'none' } : undefined}>
      <table className="data-table">
        <thead>
          <tr>
            {headers.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {children}
        </tbody>
      </table>
    </div>
  );
}

// ============================================
// Card — glassmorphism container
// ============================================

interface CardProps {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  noPadding?: boolean;
  className?: string;
}

export function Card({ title, action, children, noPadding, className }: CardProps) {
  return (
    <div className={`card ${className || ''}`} style={noPadding ? { padding: 0 } : undefined}>
      {(title || action) && (
        <div className="card-header">
          {title && <h2 className="card-title">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </div>
  );
}
