'use client';

import { ReactNode } from 'react';

// ============================================
// Form Primitives — split from FormElements.tsx
// ============================================

/* ---- Field (label + input wrapper) ---- */

export interface FieldProps {
  label: string;
  required?: boolean;
  children: ReactNode;
  hint?: string;
  error?: string;
}

export function Field({ label, required, children, hint, error }: FieldProps) {
  return (
    <div className="form-field">
      <label className="form-label">
        {label} {required && <span className="form-required">*</span>}
      </label>
      {children}
      {error && <p className="form-error">{error}</p>}
      {!error && hint && <p className="form-hint">{hint}</p>}
    </div>
  );
}

/* ---- Input ---- */

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  error?: boolean;
}

export function Input({ error, className = '', ...props }: InputProps) {
  return (
    <input
      {...props}
      className={`form-input ${error ? 'form-input-error' : ''} ${className}`}
    />
  );
}

/* ---- Select ---- */

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  children: ReactNode;
  error?: boolean;
}

export function Select({ error, className = '', children, ...props }: SelectProps) {
  return (
    <select
      {...props}
      className={`form-select ${error ? 'form-select-error' : ''} ${className}`}
    >
      {children}
    </select>
  );
}

/* ---- Textarea ---- */

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  error?: boolean;
}

export function Textarea({ error, className = '', ...props }: TextareaProps) {
  return (
    <textarea
      {...props}
      className={`form-textarea ${error ? 'form-textarea-error' : ''} ${className}`}
    />
  );
}

/* ---- Checkbox (chip style) ---- */

export interface CheckboxProps {
  label: string;
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
}

export function Checkbox({ label, checked, onChange, disabled }: CheckboxProps) {
  return (
    <label className={`checkbox-chip ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}`}>
      <input type="checkbox" checked={checked} onChange={onChange} disabled={disabled} />
      {label}
    </label>
  );
}

/* ---- RadioCard ---- */

export interface RadioCardProps {
  label: string;
  description: string;
  checked: boolean;
  onChange: () => void;
  name: string;
}

export function RadioCard({ label, description, checked, onChange, name }: RadioCardProps) {
  return (
    <label className={`radio-card ${checked ? 'checked' : ''}`}>
      <input type="radio" name={name} checked={checked} onChange={onChange} />
      <div>
        <div className="radio-card-label">{label}</div>
        <div className="radio-card-desc">{description}</div>
      </div>
    </label>
  );
}

/* ---- FormActions (button row) ---- */

export function FormActions({ children }: { children: ReactNode }) {
  return <div className="form-actions">{children}</div>;
}
