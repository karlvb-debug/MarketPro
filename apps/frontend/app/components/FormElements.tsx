'use client';

// ============================================
// Form Elements — extracted from Modal for reuse
// ============================================

import { ReactNode } from 'react';

/* Form Field wrapper with label, required indicator, and hint */
interface FormFieldProps {
  label: string;
  required?: boolean;
  children: ReactNode;
  hint?: string;
}

export function FormField({ label, required, children, hint }: FormFieldProps) {
  return (
    <div className="form-field">
      <label className="form-label">
        {label} {required && <span className="form-required">*</span>}
      </label>
      {children}
      {hint && <p className="form-hint">{hint}</p>}
    </div>
  );
}

/* Text input */
export function FormInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`form-input ${props.className || ''}`} />;
}

/* Select dropdown */
export function FormSelect(props: React.SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }) {
  return <select {...props} className={`form-select ${props.className || ''}`}>{props.children}</select>;
}

/* Textarea */
export function FormTextarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`form-textarea ${props.className || ''}`} />;
}

/* Checkbox group item */
interface CheckboxChipProps {
  label: string;
  checked: boolean;
  onChange: () => void;
}

export function CheckboxChip({ label, checked, onChange }: CheckboxChipProps) {
  return (
    <label className={`checkbox-chip ${checked ? 'checked' : ''}`}>
      <input type="checkbox" checked={checked} onChange={onChange} />
      {label}
    </label>
  );
}

/* Radio card for options like schedule type */
interface RadioCardProps {
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

/* Form actions row (Cancel + Submit) */
export function FormActions({ children }: { children: ReactNode }) {
  return <div className="form-actions">{children}</div>;
}
