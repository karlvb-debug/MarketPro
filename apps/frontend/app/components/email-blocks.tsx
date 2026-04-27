// ============================================
// Email Block Editor — Block Preview Renderers
// These render the in-editor preview of each block
// ============================================

'use client';

import { useRef, useCallback, useEffect } from 'react';
import type {
  EmailBlock,
  HeadingProps,
  TextProps,
  ImageProps,
  ButtonProps,
  DividerProps,
  ColumnsProps,
  SpacerProps,
  SocialProps,
  FooterProps,
  TableProps,
  FormTextInputProps,
  FormTextareaProps,
  FormSelectProps,
  FormCheckboxProps,
  FormRadioProps,
  FormSubmitProps,
  BlockType,
} from '../lib/email-templates';

// --- Block wrapper (handles selection, hover, toolbar) ---

interface BlockWrapperProps {
  block: EmailBlock;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDuplicate: () => void;
  isFirst: boolean;
  isLast: boolean;
  children: React.ReactNode;
  draggable?: boolean;
  onDragStart?: () => void;
  onDragEnd?: () => void;
}

export function BlockWrapper({
  block, selected, onSelect, onDelete, onMoveUp, onMoveDown, onDuplicate,
  isFirst, isLast, children, draggable, onDragStart, onDragEnd,
}: BlockWrapperProps) {
  const bgColor = (block.props as any)?.blockBgColor || undefined;
  const bgImage = (block.props as any)?.blockBgImage || undefined;
  const blockPadding = (block.props as any)?.blockPadding || undefined;
  const blockBorderWidth = (block.props as any)?.blockBorderWidth || undefined;
  const blockBorderColor = (block.props as any)?.blockBorderColor || undefined;
  const blockBorderRadius = (block.props as any)?.blockBorderRadius || undefined;
  const blockStyle: React.CSSProperties = {};
  if (bgColor) blockStyle.backgroundColor = bgColor;
  if (bgImage) {
    blockStyle.backgroundImage = `url(${bgImage})`;
    blockStyle.backgroundSize = 'cover';
    blockStyle.backgroundPosition = 'center';
    blockStyle.backgroundRepeat = 'no-repeat';
  }
  if (blockPadding) blockStyle.padding = blockPadding;
  if (blockBorderWidth && blockBorderWidth !== '0px') {
    blockStyle.border = `${blockBorderWidth} solid ${blockBorderColor || '#e2e8f0'}`;
  }
  if (blockBorderRadius && blockBorderRadius !== '0px') {
    blockStyle.borderRadius = blockBorderRadius;
    blockStyle.overflow = 'hidden';
  }
  return (
    <div
      className={`eb-block ${selected ? 'eb-block-selected' : ''}`}
      onClick={(e) => { e.stopPropagation(); onSelect(); }}
      data-block-id={block.id}
      style={Object.keys(blockStyle).length > 0 ? blockStyle : undefined}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); }}
    >
      {/* Handle row — grip on far left, action buttons between grip and content */}
      <div className="eb-block-handle">
        <span
          className="eb-block-handle-grip"
          title="Drag to reorder"
          draggable={draggable}
          onDragStart={(e) => {
            e.stopPropagation();
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', block.id);
            onDragStart?.();
          }}
          onDragEnd={onDragEnd}
        >⠿</span>
        {!isFirst && <button className="eb-block-handle-btn" onClick={(e) => { e.stopPropagation(); onMoveUp(); }} title="Move up">↑</button>}
        {!isLast && <button className="eb-block-handle-btn" onClick={(e) => { e.stopPropagation(); onMoveDown(); }} title="Move down">↓</button>}
        <button className="eb-block-handle-btn" onClick={(e) => { e.stopPropagation(); onDuplicate(); }} title="Duplicate">⧉</button>
        <button className="eb-block-handle-btn eb-block-handle-delete" onClick={(e) => { e.stopPropagation(); onDelete(); }} title="Delete">✕</button>
      </div>
      {children}
    </div>
  );
}

// --- Individual block renderers ---

const HEADING_SIZES: Record<string, string> = { h1: '28px', h2: '22px', h3: '18px' };

export function HeadingBlockPreview({ props, onUpdate, contentRef }: {
  props: HeadingProps;
  onUpdate: (p: Partial<HeadingProps>) => void;
  contentRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const localRef = useRef<HTMLDivElement>(null);
  const ref = contentRef || localRef;

  // Only set innerHTML on mount or when content changes externally (not while focused)
  useEffect(() => {
    if (ref.current && !ref.current.contains(document.activeElement)) {
      ref.current.innerHTML = props.text;
    }
  }, [props.text, ref]);

  const handleBlur = useCallback(() => {
    if (ref.current) onUpdate({ text: ref.current.innerHTML });
  }, [onUpdate, ref]);

  return (
    <div
      ref={ref}
      className="eb-block-heading"
      contentEditable
      suppressContentEditableWarning
      onBlur={handleBlur}
      style={{ fontSize: HEADING_SIZES[props.level], textAlign: props.align, color: props.color, fontWeight: 'bold' }}
    />
  );
}

export function TextBlockPreview({ props, onUpdate, contentRef }: {
  props: TextProps;
  onUpdate: (p: Partial<TextProps>) => void;
  contentRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const localRef = useRef<HTMLDivElement>(null);
  const ref = contentRef || localRef;

  useEffect(() => {
    if (ref.current && !ref.current.contains(document.activeElement)) {
      ref.current.innerHTML = props.html;
    }
  }, [props.html, ref]);

  const handleBlur = useCallback(() => {
    if (ref.current) onUpdate({ html: ref.current.innerHTML });
  }, [onUpdate, ref]);

  return (
    <div
      ref={ref}
      className="eb-block-text"
      contentEditable
      suppressContentEditableWarning
      onBlur={handleBlur}
      style={{ textAlign: props.align }}
    />
  );
}

export function ImageBlockPreview({ props }: { props: ImageProps }) {
  if (!props.src) {
    return (
      <div className="eb-block-image-placeholder">
        <span>▣</span>
        <span>Select this block to add an image URL</span>
      </div>
    );
  }
  return (
    <div className="eb-block-image" style={{ textAlign: 'center' }}>
      <img
        src={props.src}
        alt={props.alt}
        style={{ maxWidth: props.width === '100%' ? '100%' : props.width, height: 'auto', display: 'inline-block' }}
      />
    </div>
  );
}

export function ButtonBlockPreview({ props }: { props: ButtonProps }) {
  return (
    <div style={{ textAlign: props.align, padding: '8px 0' }}>
      <span
        className="eb-block-button"
        style={{
          backgroundColor: props.bgColor,
          color: props.textColor,
          borderRadius: props.borderRadius,
        }}
      >
        {props.label}
      </span>
    </div>
  );
}

export function DividerBlockPreview({ props }: { props: DividerProps }) {
  return (
    <div className="eb-block-divider">
      <hr style={{ borderTop: `${props.width} solid ${props.color}`, borderBottom: 'none', borderLeft: 'none', borderRight: 'none' }} />
    </div>
  );
}

export function SpacerBlockPreview({ props }: { props: SpacerProps }) {
  return (
    <div className="eb-block-spacer" style={{ height: props.height }}>
      <span className="eb-block-spacer-label">{props.height}</span>
    </div>
  );
}

export function ColumnsBlockPreview({ props, onUpdate, renderBlock, selectedBlockId, onSelectBlock, getColumnDropProps }: {
  props: ColumnsProps;
  onUpdate: (p: Partial<ColumnsProps>) => void;
  renderBlock: (block: EmailBlock, index: number, blocks: EmailBlock[], colIndex: number) => React.ReactNode;
  selectedBlockId: string | null;
  onSelectBlock: (id: string) => void;
  getColumnDropProps?: (colIndex: number) => { onDragOver: (e: React.DragEvent) => void; onDragLeave: () => void; onDrop: (e: React.DragEvent) => void; className: string };
}) {
  const widths: Record<string, string[]> = {
    '50-50': ['50%', '50%'],
    '33-33-33': ['33.3%', '33.3%', '33.3%'],
    '70-30': ['70%', '30%'],
    '30-70': ['30%', '70%'],
  };
  const colWidths = widths[props.layout] || ['50%', '50%'];

  return (
    <div className="eb-block-columns" style={{ display: 'flex', gap: '8px' }}>
      {props.columns.map((col, colIdx) => {
        const dropProps = getColumnDropProps?.(colIdx);
        return (
          <div
            key={colIdx}
            className={`eb-block-column ${dropProps?.className || ''}`}
            style={{ width: colWidths[colIdx], minHeight: '60px' }}
            onDragOver={dropProps?.onDragOver}
            onDragLeave={dropProps?.onDragLeave}
            onDrop={dropProps?.onDrop}
          >
            {col.blocks.length === 0 ? (
              <div className="eb-block-column-empty">Drop blocks here</div>
            ) : (
              col.blocks.map((block, i) => renderBlock(block, i, col.blocks, colIdx))
            )}
          </div>
        );
      })}
    </div>
  );
}

export function SocialBlockPreview({ props }: { props: SocialProps }) {
  const iconMap: Record<string, string> = {
    facebook: 'f',
    twitter: 't',
    instagram: 'ig',
    linkedin: 'in',
    youtube: '▶',
  };
  return (
    <div className="eb-block-social" style={{ textAlign: props.align }}>
      {props.networks.map((n, i) => (
        <span key={i} className="eb-block-social-icon" title={n.name}>
          {iconMap[n.icon] || '○'}
        </span>
      ))}
    </div>
  );
}

export function FooterBlockPreview({ props, onUpdate, contentRef }: {
  props: FooterProps;
  onUpdate: (p: Partial<FooterProps>) => void;
  contentRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const localRef = useRef<HTMLDivElement>(null);
  const ref = contentRef || localRef;

  useEffect(() => {
    if (ref.current && !ref.current.contains(document.activeElement)) {
      ref.current.innerHTML = props.text;
    }
  }, [props.text, ref]);

  const handleBlur = useCallback(() => {
    if (ref.current) onUpdate({ text: ref.current.innerHTML });
  }, [onUpdate, ref]);

  return (
    <div className="eb-block-footer" style={{ textAlign: props.align }}>
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        onBlur={handleBlur}
        style={{ fontSize: '12px', color: '#94a3b8', lineHeight: '1.5' }}
      />
      {props.showUnsubscribe && (
        <div style={{ fontSize: '12px', marginTop: '4px' }}>
          <span style={{ color: '#64748b', textDecoration: 'underline', cursor: 'default' }}>Unsubscribe</span>
        </div>
      )}
    </div>
  );
}

export function TableBlockPreview({ props, onUpdate }: {
  props: TableProps;
  onUpdate: (p: Partial<TableProps>) => void;
}) {
  const updateCell = useCallback((rowIndex: number, colIndex: number, value: string) => {
    const newRows = props.rows.map((row, ri) =>
      ri === rowIndex ? row.map((cell, ci) => (ci === colIndex ? value : cell)) : [...row]
    );
    onUpdate({ rows: newRows });
  }, [props.rows, onUpdate]);

  const updateHeader = useCallback((colIndex: number, value: string) => {
    const newHeaders = props.headers.map((h, i) => (i === colIndex ? value : h));
    onUpdate({ headers: newHeaders });
  }, [props.headers, onUpdate]);

  return (
    <div className="eb-block-table-wrap" style={{ textAlign: props.align }}>
      <table className="eb-block-table" style={{ borderColor: props.borderColor }}>
        <thead>
          <tr>
            {props.headers.map((h, ci) => (
              <th
                key={ci}
                contentEditable
                suppressContentEditableWarning
                onBlur={(e) => updateHeader(ci, e.currentTarget.textContent || '')}
                style={{ backgroundColor: props.headerBgColor, color: props.headerTextColor }}
              >{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row, ri) => (
            <tr key={ri} style={props.striped && ri % 2 === 1 ? { backgroundColor: 'rgba(0,0,0,0.03)' } : undefined}>
              {row.map((cell, ci) => (
                <td
                  key={ci}
                  contentEditable
                  suppressContentEditableWarning
                  onBlur={(e) => updateCell(ri, ci, e.currentTarget.textContent || '')}
                  style={{ borderColor: props.borderColor }}
                >{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --- Form Block Renderers ---

export function FormTextInputPreview({ props }: { props: FormTextInputProps }) {
  return (
    <div className="eb-form-field">
      <label className="eb-form-label">
        {props.label}
        {props.required && <span className="eb-form-required">*</span>}
      </label>
      <input
        type={props.inputType}
        className="eb-form-input"
        placeholder={props.placeholder}
        disabled
      />
    </div>
  );
}

export function FormTextareaPreview({ props }: { props: FormTextareaProps }) {
  return (
    <div className="eb-form-field">
      <label className="eb-form-label">
        {props.label}
        {props.required && <span className="eb-form-required">*</span>}
      </label>
      <textarea
        className="eb-form-textarea"
        placeholder={props.placeholder}
        rows={props.rows}
        disabled
      />
    </div>
  );
}

export function FormSelectPreview({ props }: { props: FormSelectProps }) {
  return (
    <div className="eb-form-field">
      <label className="eb-form-label">
        {props.label}
        {props.required && <span className="eb-form-required">*</span>}
      </label>
      <select className="eb-form-select" disabled>
        <option>{props.placeholder}</option>
        {props.options.map((opt, i) => (
          <option key={i}>{opt}</option>
        ))}
      </select>
    </div>
  );
}

export function FormCheckboxPreview({ props }: { props: FormCheckboxProps }) {
  return (
    <div className="eb-form-field">
      <label className="eb-form-checkbox-label">
        <input type="checkbox" checked={props.checkedByDefault} disabled />
        <span>{props.label}</span>
      </label>
    </div>
  );
}

export function FormRadioPreview({ props }: { props: FormRadioProps }) {
  return (
    <div className="eb-form-field">
      <label className="eb-form-label">
        {props.label}
        {props.required && <span className="eb-form-required">*</span>}
      </label>
      <div className="eb-form-radio-group">
        {props.options.map((opt, i) => (
          <label key={i} className="eb-form-radio-option">
            <input type="radio" name={`preview-${props.fieldName}`} disabled checked={i === 0} />
            <span>{opt}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

export function FormSubmitPreview({ props }: { props: FormSubmitProps }) {
  return (
    <div style={{ textAlign: props.align, padding: '8px 0' }}>
      <span
        className="eb-block-button"
        style={{
          backgroundColor: props.bgColor,
          color: props.textColor,
          borderRadius: props.borderRadius,
        }}
      >
        {props.label}
      </span>
    </div>
  );
}

// --- Master block renderer ---

export function renderBlockPreview(
  block: EmailBlock,
  onUpdate: (props: Partial<any>) => void,
  renderBlock?: (block: EmailBlock, index: number, blocks: EmailBlock[], colIndex: number) => React.ReactNode,
  selectedBlockId?: string | null,
  onSelectBlock?: (id: string) => void,
  getColumnDropProps?: (colIndex: number) => { onDragOver: (e: React.DragEvent) => void; onDragLeave: () => void; onDrop: (e: React.DragEvent) => void; className: string },
  textContentRef?: React.RefObject<HTMLDivElement | null>,
) {
  switch (block.type) {
    case 'heading': return <HeadingBlockPreview props={block.props as HeadingProps} onUpdate={onUpdate} contentRef={textContentRef} />;
    case 'text': return <TextBlockPreview props={block.props as TextProps} onUpdate={onUpdate} contentRef={textContentRef} />;
    case 'image': return <ImageBlockPreview props={block.props as ImageProps} />;
    case 'button': return <ButtonBlockPreview props={block.props as ButtonProps} />;
    case 'divider': return <DividerBlockPreview props={block.props as DividerProps} />;
    case 'spacer': return <SpacerBlockPreview props={block.props as SpacerProps} />;
    case 'columns': return <ColumnsBlockPreview props={block.props as ColumnsProps} onUpdate={onUpdate} renderBlock={renderBlock!} selectedBlockId={selectedBlockId || null} onSelectBlock={onSelectBlock!} getColumnDropProps={getColumnDropProps} />;
    case 'social': return <SocialBlockPreview props={block.props as SocialProps} />;
    case 'footer': return <FooterBlockPreview props={block.props as FooterProps} onUpdate={onUpdate} contentRef={textContentRef} />;
    case 'table': return <TableBlockPreview props={block.props as TableProps} onUpdate={onUpdate} />;
    case 'form-text-input': return <FormTextInputPreview props={block.props as FormTextInputProps} />;
    case 'form-textarea': return <FormTextareaPreview props={block.props as FormTextareaProps} />;
    case 'form-select': return <FormSelectPreview props={block.props as FormSelectProps} />;
    case 'form-checkbox': return <FormCheckboxPreview props={block.props as FormCheckboxProps} />;
    case 'form-radio': return <FormRadioPreview props={block.props as FormRadioProps} />;
    case 'form-submit': return <FormSubmitPreview props={block.props as FormSubmitProps} />;
    default: return <div className="text-tertiary">Unknown block</div>;
  }
}
