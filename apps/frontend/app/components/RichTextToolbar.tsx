// ============================================
// Rich Text Toolbar — Inline formatting controls
// Renders as a flat row designed to sit inside
// the block toolbar (blue handle bar).
// ============================================

'use client';

import { useState, useCallback, useEffect, useRef } from 'react';

// --- Email-safe font stacks ---
const FONT_OPTIONS = [
  { label: 'Default', value: 'Helvetica, Arial, sans-serif' },
  { label: 'Arial', value: 'Arial, Helvetica, sans-serif' },
  { label: 'Georgia', value: 'Georgia, serif' },
  { label: 'Times', value: "'Times New Roman', Times, serif" },
  { label: 'Courier', value: "'Courier New', Courier, monospace" },
  { label: 'Verdana', value: 'Verdana, Geneva, sans-serif' },
  { label: 'Trebuchet', value: "'Trebuchet MS', Helvetica, sans-serif" },
  { label: 'Tahoma', value: 'Tahoma, Geneva, sans-serif' },
];

const FONT_SIZES = [
  { label: '12', value: '1' },
  { label: '14', value: '2' },
  { label: '16', value: '3' },
  { label: '18', value: '4' },
  { label: '22', value: '5' },
  { label: '26', value: '6' },
  { label: '32', value: '7' },
];

// --- Toolbar button (blue bar style) ---
function Btn({
  active,
  onClick,
  title,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`rtt-btn ${active ? 'rtt-btn-active' : ''}`}
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
      title={title}
      type="button"
    >
      {children}
    </button>
  );
}

function Sep() {
  return <span className="rtt-sep" />;
}

// --- Main toolbar (single row, designed for blue bar) ---
export default function RichTextToolbar({
  containerRef,
  onContentChange,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  onContentChange: () => void;
}) {
  const [fmt, setFmt] = useState({
    bold: false,
    italic: false,
    underline: false,
    strikeThrough: false,
    orderedList: false,
    unorderedList: false,
  });
  const [showLink, setShowLink] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const linkRef = useRef<HTMLInputElement>(null);
  const savedRange = useRef<Range | null>(null);

  const poll = useCallback(() => {
    setFmt({
      bold: document.queryCommandState('bold'),
      italic: document.queryCommandState('italic'),
      underline: document.queryCommandState('underline'),
      strikeThrough: document.queryCommandState('strikeThrough'),
      orderedList: document.queryCommandState('insertOrderedList'),
      unorderedList: document.queryCommandState('insertUnorderedList'),
    });
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener('keyup', poll);
    el.addEventListener('mouseup', poll);
    document.addEventListener('selectionchange', poll);
    return () => {
      el.removeEventListener('keyup', poll);
      el.removeEventListener('mouseup', poll);
      document.removeEventListener('selectionchange', poll);
    };
  }, [containerRef, poll]);

  const exec = useCallback((cmd: string, val?: string) => {
    document.execCommand(cmd, false, val);
    onContentChange();
    poll();
  }, [onContentChange, poll]);

  const saveSel = useCallback(() => {
    const s = window.getSelection();
    if (s && s.rangeCount > 0) savedRange.current = s.getRangeAt(0).cloneRange();
  }, []);

  const restoreSel = useCallback(() => {
    const r = savedRange.current;
    if (r) { const s = window.getSelection(); s?.removeAllRanges(); s?.addRange(r); }
  }, []);

  const openLink = useCallback(() => {
    saveSel();
    const s = window.getSelection();
    const a = s?.anchorNode?.parentElement?.closest('a');
    setLinkUrl(a?.getAttribute('href') || 'https://');
    setShowLink(true);
    setTimeout(() => linkRef.current?.focus(), 50);
  }, [saveSel]);

  const applyLink = useCallback(() => {
    restoreSel();
    if (linkUrl && linkUrl !== 'https://') exec('createLink', linkUrl);
    setShowLink(false);
    setLinkUrl('');
  }, [linkUrl, exec, restoreSel]);

  const removeLink = useCallback(() => {
    restoreSel();
    exec('unlink');
    setShowLink(false);
  }, [exec, restoreSel]);

  return (
    <>
      {/* All controls in a single flat row — prevent focus loss */}
      <div className="rtt-inline" onMouseDown={(e) => { if ((e.target as HTMLElement).tagName !== 'SELECT' && (e.target as HTMLElement).tagName !== 'INPUT') e.preventDefault(); }}>
        <select
          className="rtt-sel"
          onChange={(e) => { restoreSel(); exec('fontName', e.target.value); }}
          onFocus={saveSel}
          onMouseDown={(e) => e.stopPropagation()}
          defaultValue=""
          title="Font"
        >
          <option value="" disabled>Font</option>
          {FONT_OPTIONS.map((f) => (
            <option key={f.value} value={f.value}>{f.label}</option>
          ))}
        </select>

        <select
          className="rtt-sel rtt-sel-sm"
          onChange={(e) => { restoreSel(); exec('fontSize', e.target.value); }}
          onFocus={saveSel}
          onMouseDown={(e) => e.stopPropagation()}
          defaultValue=""
          title="Size"
        >
          <option value="" disabled>Sz</option>
          {FONT_SIZES.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>

        <Sep />

        <Btn active={fmt.bold} onClick={() => exec('bold')} title="Bold"><strong>B</strong></Btn>
        <Btn active={fmt.italic} onClick={() => exec('italic')} title="Italic"><em>I</em></Btn>
        <Btn active={fmt.underline} onClick={() => exec('underline')} title="Underline"><span style={{ textDecoration: 'underline' }}>U</span></Btn>
        <Btn active={fmt.strikeThrough} onClick={() => exec('strikeThrough')} title="Strikethrough"><span style={{ textDecoration: 'line-through' }}>S</span></Btn>

        <Sep />

        <label className="rtt-clr" title="Text color" onMouseDown={(e) => { saveSel(); }}>
          <span className="rtt-clr-icon">A</span>
          <input type="color" className="rtt-clr-input" onChange={(e) => { restoreSel(); exec('foreColor', e.target.value); }} defaultValue="#334155" />
        </label>

        <Sep />

        <Btn active={fmt.unorderedList} onClick={() => exec('insertUnorderedList')} title="Bullets">≡</Btn>
        <Btn active={fmt.orderedList} onClick={() => exec('insertOrderedList')} title="Numbers">1.</Btn>

        <Sep />

        <Btn onClick={() => exec('justifyLeft')} title="Align left">
          <span className="rtt-align-icon" style={{ textAlign: 'left' }}><span /><span /><span style={{ width: '60%' }} /></span>
        </Btn>
        <Btn onClick={() => exec('justifyCenter')} title="Align center">
          <span className="rtt-align-icon" style={{ textAlign: 'center' }}><span /><span style={{ width: '60%' }} /><span /></span>
        </Btn>
        <Btn onClick={() => exec('justifyRight')} title="Align right">
          <span className="rtt-align-icon" style={{ textAlign: 'right' }}><span /><span /><span style={{ width: '60%' }} /></span>
        </Btn>

        <Sep />

        <Btn onClick={openLink} title="Link">⌗</Btn>
        <Btn onClick={() => exec('removeFormat')} title="Clear">✕</Btn>
      </div>

      {/* Link input (drops below the toolbar bar) */}
      {showLink && (
        <div className="rtt-link-bar">
          <input
            ref={linkRef}
            className="rtt-link-input"
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') applyLink(); if (e.key === 'Escape') setShowLink(false); }}
            placeholder="https://example.com"
          />
          <button className="rtt-link-btn rtt-link-apply" onMouseDown={(e) => { e.preventDefault(); applyLink(); }} type="button">Apply</button>
          <button className="rtt-link-btn" onMouseDown={(e) => { e.preventDefault(); removeLink(); }} type="button">Unlink</button>
          <button className="rtt-link-btn" onMouseDown={(e) => { e.preventDefault(); setShowLink(false); }} type="button">✕</button>
        </div>
      )}
    </>
  );
}
