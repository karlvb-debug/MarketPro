// ============================================
// UI Primitives — Barrel Export
// Import shared components from '@/components/ui'
// ============================================

// Core
export { default as Button } from './Button';
export type { ButtonProps, ButtonVariant, ButtonSize } from './Button';

export { default as IconButton } from './IconButton';
export type { IconButtonProps } from './IconButton';

// Overlay
export { default as Modal } from './Modal';
export type { ModalProps, ModalSize } from './Modal';

// Form
export { Field, Input, Select, Textarea, Checkbox, RadioCard, FormActions } from './Form';
export type { FieldProps, InputProps, SelectProps, TextareaProps, CheckboxProps, RadioCardProps } from './Form';

// Data Display
export { default as Badge } from './Badge';
export type { BadgeProps, BadgeTone } from './Badge';

export { default as Card } from './Card';
export type { CardProps } from './Card';

export { Table, TableHead, TableBody, TableRow, TableHeaderCell, TableCell } from './Table';
export type { TableProps, TableDensity } from './Table';

export { default as EmptyState } from './EmptyState';
export type { EmptyStateProps } from './EmptyState';

// Navigation
export { default as Tabs } from './Tabs';
export type { TabsProps, Tab } from './Tabs';

// Input
export { default as SearchInput } from './SearchInput';
export type { SearchInputProps } from './SearchInput';

// Feedback
export { showToast, ToastProvider } from './Toast';
