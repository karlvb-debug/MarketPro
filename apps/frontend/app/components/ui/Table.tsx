'use client';

import { ReactNode, HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react';

// ============================================
// Table — lightweight compound component
// No data binding — just consistent markup + density
// ============================================

export type TableDensity = 'compact' | 'comfortable';

/* ---- Root ---- */

export interface TableProps extends HTMLAttributes<HTMLTableElement> {
  density?: TableDensity;
  children: ReactNode;
}

export function Table({ density = 'comfortable', children, className = '', ...rest }: TableProps) {
  return (
    <div className="table-scroll">
      <table className={`data-table ${density === 'compact' ? 'data-table-compact' : ''} ${className}`} {...rest}>
        {children}
      </table>
    </div>
  );
}

/* ---- Head ---- */

export function TableHead({ children, className = '', ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={className} {...rest}>{children}</thead>;
}

/* ---- Body ---- */

export function TableBody({ children, className = '', ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={className} {...rest}>{children}</tbody>;
}

/* ---- Row ---- */

export interface TableRowProps extends HTMLAttributes<HTMLTableRowElement> {
  selected?: boolean;
  children: ReactNode;
}

export function TableRow({ selected, children, className = '', ...rest }: TableRowProps) {
  return (
    <tr className={`${selected ? 'table-row-selected' : ''} ${className}`} {...rest}>
      {children}
    </tr>
  );
}

/* ---- Header Cell ---- */

export function TableHeaderCell({ children, className = '', ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th className={className} {...rest}>{children}</th>;
}

/* ---- Cell ---- */

export function TableCell({ children, className = '', ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={className} {...rest}>{children}</td>;
}

/* ---- Attach sub-components ---- */

Table.Head = TableHead;
Table.Body = TableBody;
Table.Row = TableRow;
Table.HeaderCell = TableHeaderCell;
Table.Cell = TableCell;
