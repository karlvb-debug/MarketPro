'use client';

import { ReactNode } from 'react';

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  children?: ReactNode; // Action buttons go here
}

export default function PageHeader({ title, subtitle, children }: PageHeaderProps) {
  return (
    <div className="page-header">
      <div className="page-header-row">
        <div>
          <h1 className="page-title">{title}</h1>
          {subtitle && <p className="page-subtitle">{subtitle}</p>}
        </div>
        {children && <div className="page-header-actions">{children}</div>}
      </div>
    </div>
  );
}
