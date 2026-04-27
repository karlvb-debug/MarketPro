// ============================================
// Email Block Editor — Main Component
// Three-panel editor: Sidebar | Canvas | Settings
// ============================================

'use client';

import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import type {
  EmailDesign,
  EmailBlock,
  BlockType,
  BlockPreset,
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
} from '../lib/email-templates';
import {
  createBlock,
  createBlockFromPreset,
  BLOCK_PALETTE,
  FORM_PALETTE,
  loadBlockPresets,
  addBlockPreset,
  deleteBlockPreset,
} from '../lib/email-templates';
import { BlockWrapper, renderBlockPreview } from './email-blocks';
import ImagePicker from './ImagePicker';
import RichTextToolbar from './RichTextToolbar';

// Block types that support style presets
const PRESET_TYPES: BlockType[] = ['heading', 'text', 'button', 'divider', 'social', 'footer'];

interface EmailBlockEditorProps {
  design: EmailDesign;
  onChange: (design: EmailDesign) => void;
  mode?: 'email' | 'form';
}

export default function EmailBlockEditor({ design, onChange, mode = 'email' }: EmailBlockEditorProps) {
  const activePalette = mode === 'form' ? FORM_PALETTE : BLOCK_PALETTE;
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [history, setHistory] = useState<EmailDesign[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const canvasRef = useRef<HTMLDivElement>(null);
  const textContentRef = useRef<HTMLDivElement>(null);

  // Block presets
  const [presets, setPresets] = useState<BlockPreset[]>([]);
  const [showPresetSave, setShowPresetSave] = useState(false);
  const [presetName, setPresetName] = useState('');
  const [sidebarTab, setSidebarTab] = useState<'blocks' | 'presets'>('blocks');

  // Drag-and-drop state
  const [dragSource, setDragSource] = useState<{ type: 'palette'; blockType: BlockType } | { type: 'canvas'; blockId: string } | null>(null);
  const [dropTarget, setDropTarget] = useState<{ index: number; colKey?: string } | null>(null);

  useEffect(() => { setPresets(loadBlockPresets()); }, []);
  const refreshPresets = () => setPresets(loadBlockPresets());

  // Push to history on design changes
  const pushHistory = useCallback((newDesign: EmailDesign) => {
    setHistory((prev) => {
      const trimmed = prev.slice(0, historyIndex + 1);
      return [...trimmed, newDesign].slice(-30); // max 30 states
    });
    setHistoryIndex((i) => i + 1);
  }, [historyIndex]);

  const updateDesign = useCallback((patch: Partial<EmailDesign>) => {
    const updated = { ...design, ...patch };
    pushHistory(updated);
    onChange(updated);
  }, [design, onChange, pushHistory]);

  const updateBlocks = useCallback((blocks: EmailBlock[]) => {
    updateDesign({ blocks });
  }, [updateDesign]);

  // Undo/Redo keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        if (historyIndex > 0) {
          setHistoryIndex((i) => i - 1);
          const prev = history[historyIndex - 1];
          if (prev) onChange(prev);
        }
      }
      if ((e.metaKey || e.ctrlKey) && ((e.key === 'z' && e.shiftKey) || e.key === 'y')) {
        e.preventDefault();
        if (historyIndex < history.length - 1) {
          setHistoryIndex((i) => i + 1);
          const next = history[historyIndex + 1];
          if (next) onChange(next);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [history, historyIndex, onChange]);

  const selectedBlock = design.blocks.find((b) => b.id === selectedBlockId) || null;

  // Find the currently selected rich-text block (could be top-level or inside columns)
  const RICH_TEXT_TYPES = ['text', 'heading', 'footer'];
  const selectedRichTextBlock = useMemo(() => {
    if (!selectedBlockId) return null;
    const topLevel = design.blocks.find(b => b.id === selectedBlockId && RICH_TEXT_TYPES.includes(b.type));
    if (topLevel) return { block: topLevel, parentId: null as string | null };
    for (const parent of design.blocks) {
      if (parent.type !== 'columns') continue;
      const cols = (parent.props as ColumnsProps).columns;
      for (const col of cols) {
        const child = col.blocks.find(b => b.id === selectedBlockId && RICH_TEXT_TYPES.includes(b.type));
        if (child) return { block: child, parentId: parent.id };
      }
    }
    return null;
  }, [selectedBlockId, design.blocks]);


  // --- Block operations ---
  const addBlock = useCallback((type: BlockType) => {
    const block = createBlock(type);
    const blocks = [...design.blocks, block];
    updateBlocks(blocks);
    setSelectedBlockId(block.id);
  }, [design.blocks, updateBlocks]);

  const addFromPreset = useCallback((preset: BlockPreset) => {
    const block = createBlockFromPreset(preset);
    const blocks = [...design.blocks, block];
    updateBlocks(blocks);
    setSelectedBlockId(block.id);
  }, [design.blocks, updateBlocks]);

  const handleSavePreset = useCallback(() => {
    if (!selectedBlock || !presetName.trim()) return;
    addBlockPreset(presetName.trim(), selectedBlock.type, selectedBlock.props);
    refreshPresets();
    setShowPresetSave(false);
    setPresetName('');
  }, [selectedBlock, presetName]);

  const handleDeletePreset = useCallback((id: string) => {
    deleteBlockPreset(id);
    refreshPresets();
  }, []);

  const deleteBlock = useCallback((id: string) => {
    updateBlocks(design.blocks.filter((b) => b.id !== id));
    if (selectedBlockId === id) setSelectedBlockId(null);
  }, [design.blocks, updateBlocks, selectedBlockId]);

  const moveBlock = useCallback((id: string, direction: -1 | 1) => {
    const idx = design.blocks.findIndex((b) => b.id === id);
    if (idx < 0) return;
    const newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= design.blocks.length) return;
    const blocks = [...design.blocks];
    [blocks[idx], blocks[newIdx]] = [blocks[newIdx]!, blocks[idx]!];
    updateBlocks(blocks);
  }, [design.blocks, updateBlocks]);

  const duplicateBlock = useCallback((id: string) => {
    const idx = design.blocks.findIndex((b) => b.id === id);
    if (idx < 0) return;
    const original = design.blocks[idx];
    const clone: EmailBlock = {
      ...JSON.parse(JSON.stringify(original)),
      id: `blk_${Date.now()}_dup`,
    };
    const blocks = [...design.blocks];
    blocks.splice(idx + 1, 0, clone);
    updateBlocks(blocks);
    setSelectedBlockId(clone.id);
  }, [design.blocks, updateBlocks]);

  const updateBlockProps = useCallback((id: string, propsPatch: Partial<any>) => {
    const blocks = design.blocks.map((b) =>
      b.id === id ? { ...b, props: { ...b.props, ...propsPatch } } : b
    );
    updateBlocks(blocks);
  }, [design.blocks, updateBlocks]);

  const handleRichTextChange = useCallback(() => {
    if (!textContentRef.current || !selectedRichTextBlock) return;
    const { block, parentId } = selectedRichTextBlock;
    const propKey = block.type === 'text' ? 'html' : 'text';
    const html = textContentRef.current.innerHTML;
    if (parentId) {
      const parent = design.blocks.find(b => b.id === parentId);
      if (!parent) return;
      const colProps = parent.props as ColumnsProps;
      const newCols = colProps.columns.map((col) => ({
        blocks: col.blocks.map((b) => b.id === block.id ? { ...b, props: { ...b.props, [propKey]: html } } : b),
      }));
      updateBlockProps(parentId, { columns: newCols });
    } else {
      updateBlockProps(block.id, { [propKey]: html });
    }
  }, [selectedRichTextBlock, design.blocks, updateBlockProps]);

  // --- Insert block at a specific index ---
  const insertBlockAt = useCallback((type: BlockType, index: number) => {
    const block = createBlock(type);
    const blocks = [...design.blocks];
    blocks.splice(index, 0, block);
    updateBlocks(blocks);
    setSelectedBlockId(block.id);
  }, [design.blocks, updateBlocks]);

  // --- Move block to a specific index ---
  const moveBlockTo = useCallback((blockId: string, toIndex: number) => {
    const fromIndex = design.blocks.findIndex((b) => b.id === blockId);
    if (fromIndex < 0 || fromIndex === toIndex) return;
    const blocks = [...design.blocks];
    const [moved] = blocks.splice(fromIndex, 1);
    // Adjust target index after removal
    const adjustedIndex = toIndex > fromIndex ? toIndex - 1 : toIndex;
    blocks.splice(adjustedIndex, 0, moved!);
    updateBlocks(blocks);
  }, [design.blocks, updateBlocks]);

  // --- Drop block into a column ---
  const dropIntoColumn = useCallback((columnsBlockId: string, colIndex: number, source: typeof dragSource) => {
    if (!source) return;
    const colBlock = design.blocks.find((b) => b.id === columnsBlockId);
    if (!colBlock || colBlock.type !== 'columns') return;
    const colProps = colBlock.props as ColumnsProps;

    let newBlock: EmailBlock;
    let newTopBlocks = design.blocks;

    if (source.type === 'palette') {
      newBlock = createBlock(source.blockType);
    } else {
      // Moving an existing block into the column
      const existingIdx = design.blocks.findIndex((b) => b.id === source.blockId);
      if (existingIdx < 0) return;
      newBlock = design.blocks[existingIdx]!;
      newTopBlocks = design.blocks.filter((b) => b.id !== source.blockId);
    }

    const newColumns = colProps.columns.map((col, ci) => {
      if (ci === colIndex) {
        return { blocks: [...col.blocks, newBlock] };
      }
      return col;
    });

    const blocks = newTopBlocks.map((b) =>
      b.id === columnsBlockId ? { ...b, props: { ...b.props, columns: newColumns } } : b
    );
    updateBlocks(blocks);
    setSelectedBlockId(newBlock.id);
  }, [design.blocks, updateBlocks]);

  // --- Drag handlers ---
  const handleDragEnd = useCallback(() => {
    setDragSource(null);
    setDropTarget(null);
  }, []);

  const handleCanvasDrop = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.stopPropagation();
    if (!dragSource) return;

    if (dragSource.type === 'palette') {
      insertBlockAt(dragSource.blockType, index);
    } else if (dragSource.type === 'canvas') {
      moveBlockTo(dragSource.blockId, index);
    }
    setDragSource(null);
    setDropTarget(null);
  }, [dragSource, insertBlockAt, moveBlockTo]);

  const handleColumnDrop = useCallback((e: React.DragEvent, columnsBlockId: string, colIndex: number) => {
    e.preventDefault();
    e.stopPropagation();
    dropIntoColumn(columnsBlockId, colIndex, dragSource);
    setDragSource(null);
    setDropTarget(null);
  }, [dragSource, dropIntoColumn]);


  // Click outside canvas clears selection
  const handleCanvasClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) setSelectedBlockId(null);
  }, []);

  return (
    <div className="eb-editor">
      {/* ===== LEFT: Block Palette ===== */}
      <div className="eb-sidebar">
        <div className="eb-sidebar-tabs">
          <button className={`eb-sidebar-tab ${sidebarTab === 'blocks' ? 'active' : ''}`} onClick={() => setSidebarTab('blocks')}>Blocks</button>
          <button className={`eb-sidebar-tab ${sidebarTab === 'presets' ? 'active' : ''}`} onClick={() => setSidebarTab('presets')}>
            Styles {presets.length > 0 && <span className="eb-sidebar-tab-count">{presets.length}</span>}
          </button>
        </div>

        {sidebarTab === 'blocks' ? (
          <>
            <div className="eb-sidebar-blocks">
              {activePalette.map((item) => (
                <button
                  key={item.type}
                  className="eb-sidebar-block"
                  onClick={() => addBlock(item.type)}
                  title={item.description}
                  draggable
                  onDragStart={(e) => {
                    setDragSource({ type: 'palette', blockType: item.type });
                    e.dataTransfer.effectAllowed = 'copy';
                    e.dataTransfer.setData('text/plain', item.type);
                  }}
                  onDragEnd={handleDragEnd}
                >
                  <span className="eb-sidebar-block-icon">{item.icon}</span>
                  <span className="eb-sidebar-block-label">{item.label}</span>
                </button>
              ))}
            </div>
            <div className="eb-sidebar-help">
              <p>Drag a block to the canvas or click to append.</p>
              <p>Click blocks in the preview to edit them.</p>
            </div>
          </>
        ) : (
          <div className="eb-sidebar-presets">
            {presets.length === 0 ? (
              <div className="eb-sidebar-presets-empty">
                <p>No saved styles yet.</p>
                <p>Select a block and click "Save Style" in the settings panel to create one.</p>
              </div>
            ) : (
              presets.map((preset) => (
                <div key={preset.id} className="eb-sidebar-preset">
                  <button
                    className="eb-sidebar-preset-body"
                    onClick={() => addFromPreset(preset)}
                    title={`Add ${preset.name} (${preset.type})`}
                  >
                    <span className="eb-sidebar-preset-type">{preset.type}</span>
                    <span className="eb-sidebar-preset-name">{preset.name}</span>
                  </button>
                  <button
                    className="eb-sidebar-preset-delete"
                    onClick={() => handleDeletePreset(preset.id)}
                    title="Delete style"
                  >✕</button>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* ===== CENTER: Canvas ===== */}
      <div className="eb-canvas-area">
        {/* Fixed formatting toolbar — always visible, never steals focus */}
        <div className="eb-format-toolbar" onMouseDown={(e) => { if ((e.target as HTMLElement).tagName !== 'SELECT' && (e.target as HTMLElement).tagName !== 'INPUT') e.preventDefault(); }}>
          <RichTextToolbar containerRef={textContentRef} onContentChange={handleRichTextChange} />
        </div>

        <div
          className="eb-canvas"
          ref={canvasRef}
          onClick={handleCanvasClick}
          style={{ backgroundColor: design.bodyBackground, maxWidth: `${design.contentWidth + 80}px` }}
        >
          <div
            className={`eb-canvas-inner ${dragSource ? 'eb-dragging' : ''}`}
            style={{ backgroundColor: design.contentBackground, maxWidth: `${design.contentWidth}px` }}
          >
            {design.blocks.length === 0 ? (
              <div
                className={`eb-canvas-empty ${dragSource ? 'eb-canvas-empty-droppable' : ''}`}
                onDragOver={(e) => { e.preventDefault(); setDropTarget({ index: 0 }); }}
                onDragLeave={() => setDropTarget(null)}
                onDrop={(e) => handleCanvasDrop(e, 0)}
              >
                <p>{dragSource ? 'Drop here to add' : 'Click a block from the sidebar to get started'}</p>
              </div>
            ) : (
              <>
                {/* Top drop zone */}
                <div
                  className={`eb-drop-zone ${dropTarget?.index === 0 && !dropTarget?.colKey ? 'eb-drop-zone-active' : ''}`}
                  onDragOver={(e) => { e.preventDefault(); setDropTarget({ index: 0 }); }}
                  onDragLeave={() => setDropTarget(null)}
                  onDrop={(e) => handleCanvasDrop(e, 0)}
                />
                {design.blocks.map((block, index) => {
                  const isRichText = (block.type === 'text' || block.type === 'heading' || block.type === 'footer') && block.id === selectedBlockId;

                  return (
                  <React.Fragment key={block.id}>
                    <BlockWrapper
                      block={block}
                      selected={block.id === selectedBlockId}
                      onSelect={() => setSelectedBlockId(block.id)}
                      onDelete={() => deleteBlock(block.id)}
                      onMoveUp={() => moveBlock(block.id, -1)}
                      onMoveDown={() => moveBlock(block.id, 1)}
                      onDuplicate={() => duplicateBlock(block.id)}
                      isFirst={index === 0}
                      isLast={index === design.blocks.length - 1}
                      draggable
                      onDragStart={() => setDragSource({ type: 'canvas', blockId: block.id })}
                      onDragEnd={handleDragEnd}
                    >
                      {renderBlockPreview(
                        block,
                        (patch) => updateBlockProps(block.id, patch),
                        // renderBlock callback for columns — simple child rendering
                        (childBlock, _i, _blocks, _colIdx) => {
                          const updateChildProps = (p: Record<string, any>) => {
                            const colProps = block.props as ColumnsProps;
                            const newCols = colProps.columns.map((col) => ({
                              blocks: col.blocks.map((b) => b.id === childBlock.id ? { ...b, props: { ...b.props, ...p } } : b),
                            }));
                            updateBlockProps(block.id, { columns: newCols });
                          };
                          return (
                            <div
                              key={childBlock.id}
                              className={`eb-block ${childBlock.id === selectedBlockId ? 'eb-block-selected' : ''}`}
                              onClick={(e) => { e.stopPropagation(); setSelectedBlockId(childBlock.id); }}
                            >
                              {renderBlockPreview(
                                childBlock,
                                updateChildProps,
                                undefined, undefined, undefined, undefined,
                                childBlock.id === selectedBlockId ? textContentRef : undefined,
                              )}
                            </div>
                          );
                        },
                        selectedBlockId,
                        (id) => setSelectedBlockId(id),
                        // Column drop handler
                        dragSource ? (colIndex: number) => ({
                          onDragOver: (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setDropTarget({ index, colKey: `${block.id}-${colIndex}` }); },
                          onDragLeave: () => setDropTarget(null),
                          onDrop: (e: React.DragEvent) => handleColumnDrop(e, block.id, colIndex),
                          className: dropTarget?.colKey === `${block.id}-${colIndex}` ? 'eb-block-column-droppable' : '',
                        }) : undefined,
                        // Pass content ref for the selected rich-text block
                        isRichText ? textContentRef : undefined,
                      )}
                    </BlockWrapper>
                    {/* Drop zone between blocks */}
                    <div
                      className={`eb-drop-zone ${dropTarget?.index === index + 1 && !dropTarget?.colKey ? 'eb-drop-zone-active' : ''}`}
                      onDragOver={(e) => { e.preventDefault(); setDropTarget({ index: index + 1 }); }}
                      onDragLeave={() => setDropTarget(null)}
                      onDrop={(e) => handleCanvasDrop(e, index + 1)}
                    />
                  </React.Fragment>
                  );
                })}
              </>
            )}
          </div>
        </div>
      </div>

      {/* ===== RIGHT: Settings Panel ===== */}
      <div className={`eb-settings ${selectedBlock ? 'eb-settings-open' : ''}`}>
        {selectedBlock ? (
          <>
            <div className="eb-settings-header">
              <h3 className="eb-settings-title">{selectedBlock.type} Settings</h3>
              <button className="btn btn-ghost btn-sm" onClick={() => setSelectedBlockId(null)}>✕</button>
            </div>
            <div className="eb-settings-body">
              <SettingsPanel
                block={selectedBlock}
                onUpdate={(patch) => updateBlockProps(selectedBlock.id, patch)}
                presets={presets.filter((p) => p.type === selectedBlock.type)}
                onApplyPreset={(preset) => updateBlockProps(selectedBlock.id, preset.props)}
              />

              {/* Save / Apply Preset */}
              {PRESET_TYPES.includes(selectedBlock.type) && (
                <div className="eb-settings-preset-section">
                  <div className="eb-settings-preset-divider" />
                  {showPresetSave ? (
                    <div className="eb-settings-preset-save">
                      <input
                        className="eb-settings-input"
                        placeholder="Style name..."
                        value={presetName}
                        onChange={(e) => setPresetName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') handleSavePreset(); if (e.key === 'Escape') setShowPresetSave(false); }}
                        autoFocus
                      />
                      <div className="eb-settings-preset-save-actions">
                        <button className="btn btn-primary btn-sm" onClick={handleSavePreset} disabled={!presetName.trim()}>Save</button>
                        <button className="btn btn-ghost btn-sm" onClick={() => setShowPresetSave(false)}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <button className="btn btn-secondary btn-sm" style={{ width: '100%' }} onClick={() => { setPresetName(''); setShowPresetSave(true); }}>
                      Save as Style
                    </button>
                  )}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="eb-settings-empty">
            <h3 className="eb-settings-title">{mode === 'form' ? 'Form' : 'Email'} Settings</h3>
            <div className="eb-settings-body">
              <label className="eb-settings-label">Background</label>
              <input type="color" value={design.bodyBackground} onChange={(e) => updateDesign({ bodyBackground: e.target.value })} className="eb-settings-color" />
              <label className="eb-settings-label">Content Background</label>
              <input type="color" value={design.contentBackground} onChange={(e) => updateDesign({ contentBackground: e.target.value })} className="eb-settings-color" />
              <label className="eb-settings-label">Content Width</label>
              <select value={design.contentWidth} onChange={(e) => updateDesign({ contentWidth: Number(e.target.value) })} className="eb-settings-select">
                <option value={480}>480px (narrow)</option>
                <option value={540}>540px</option>
                <option value={600}>600px (standard)</option>
                <option value={640}>640px (wide)</option>
              </select>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================
// Settings Panel — per-block controls
// ============================================

function SettingsPanel({ block, onUpdate, presets, onApplyPreset }: {
  block: EmailBlock;
  onUpdate: (patch: Partial<any>) => void;
  presets?: BlockPreset[];
  onApplyPreset?: (preset: BlockPreset) => void;
}) {
  const matchingPresets = presets?.filter((p) => p.type === block.type) || [];

  // Parse blockPadding into individual values
  const parsePadding = (padding?: string) => {
    if (!padding) return { top: 0, right: 0, bottom: 0, left: 0 };
    const parts = padding.replace(/px/g, '').trim().split(/\s+/).map(Number);
    if (parts.length === 1) return { top: parts[0], right: parts[0], bottom: parts[0], left: parts[0] };
    if (parts.length === 2) return { top: parts[0], right: parts[1], bottom: parts[0], left: parts[1] };
    if (parts.length === 3) return { top: parts[0], right: parts[1], bottom: parts[2], left: parts[1] };
    return { top: parts[0], right: parts[1], bottom: parts[2], left: parts[3] };
  };

  const pad = parsePadding((block.props as any).blockPadding);
  const [linkPadding, setLinkPadding] = useState(pad.top === pad.right && pad.right === pad.bottom && pad.bottom === pad.left);

  const updatePadding = (side: string, value: number) => {
    const p = { ...pad, [side]: value };
    if (linkPadding) {
      onUpdate({ blockPadding: value === 0 ? undefined : `${value}px` });
    } else {
      const str = `${p.top}px ${p.right}px ${p.bottom}px ${p.left}px`;
      onUpdate({ blockPadding: str === '0px 0px 0px 0px' ? undefined : str });
    }
  };

  // Parse blockBorder
  const borderWidth = parseInt((block.props as any).blockBorderWidth || '0', 10);
  const borderColor = (block.props as any).blockBorderColor || '#e2e8f0';
  const borderRadius = parseInt((block.props as any).blockBorderRadius || '0', 10);

  return (
    <>
      {/* Preset picker at top */}
      {matchingPresets.length > 0 && onApplyPreset && (
        <div className="eb-settings-preset-picker">
          <label className="eb-settings-label">Apply Saved Style</label>
          <select
            className="eb-settings-select"
            value=""
            onChange={(e) => {
              const preset = matchingPresets.find((p) => p.id === e.target.value);
              if (preset) onApplyPreset(preset);
            }}
          >
            <option value="" disabled>Choose a style...</option>
            {matchingPresets.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
      )}

      {/* Block-specific settings */}
      <SettingsPanelInner block={block} onUpdate={onUpdate} />

      {/* ===== Universal: Block Style ===== */}
      <div className="eb-settings-divider" />
      <h4 className="eb-settings-section-title">Block Style</h4>

      {/* Background Color */}
      <label className="eb-settings-label">Background Color</label>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <input
          type="color"
          className="eb-settings-color eb-settings-color-compact"
          value={(block.props as any).blockBgColor || '#ffffff'}
          onChange={(e) => onUpdate({ blockBgColor: e.target.value })}
        />
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
          {(block.props as any).blockBgColor || 'none'}
        </span>
        {(block.props as any).blockBgColor && (
          <button
            className="btn btn-ghost btn-sm"
            style={{ fontSize: 'var(--text-xs)', padding: '2px 6px' }}
            onClick={() => onUpdate({ blockBgColor: undefined })}
          >
            Reset
          </button>
        )}
      </div>

      {/* Background Image */}
      <label className="eb-settings-label">Background Image</label>
      <ImagePicker
        value={(block.props as any).blockBgImage || ''}
        onChange={(url) => onUpdate({ blockBgImage: url || undefined })}
        compact
      />

      {/* Padding — numeric inputs */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 'var(--space-3)' }}>
        <label className="eb-settings-label" style={{ margin: 0 }}>Padding</label>
        <button
          className={`btn btn-ghost btn-sm ${linkPadding ? 'active' : ''}`}
          style={{ fontSize: '10px', padding: '2px 6px' }}
          onClick={() => setLinkPadding(!linkPadding)}
          title={linkPadding ? 'Unlink sides' : 'Link all sides'}
        >{linkPadding ? '🔗' : '⛓️‍💥'}</button>
      </div>
      {linkPadding ? (
        <div className="eb-settings-padding-row">
          <div className="eb-settings-padding-field">
            <label>All</label>
            <input type="number" min={0} max={100} value={pad.top} onChange={(e) => updatePadding('top', Number(e.target.value))} />
            <span>px</span>
          </div>
        </div>
      ) : (
        <div className="eb-settings-padding-grid">
          <div className="eb-settings-padding-field">
            <label>Top</label>
            <input type="number" min={0} max={100} value={pad.top} onChange={(e) => updatePadding('top', Number(e.target.value))} />
            <span>px</span>
          </div>
          <div className="eb-settings-padding-field">
            <label>Right</label>
            <input type="number" min={0} max={100} value={pad.right} onChange={(e) => updatePadding('right', Number(e.target.value))} />
            <span>px</span>
          </div>
          <div className="eb-settings-padding-field">
            <label>Bottom</label>
            <input type="number" min={0} max={100} value={pad.bottom} onChange={(e) => updatePadding('bottom', Number(e.target.value))} />
            <span>px</span>
          </div>
          <div className="eb-settings-padding-field">
            <label>Left</label>
            <input type="number" min={0} max={100} value={pad.left} onChange={(e) => updatePadding('left', Number(e.target.value))} />
            <span>px</span>
          </div>
        </div>
      )}

      {/* Border Radius */}
      <label className="eb-settings-label">Corner Radius</label>
      <div className="eb-settings-padding-row">
        <div className="eb-settings-padding-field">
          <input type="number" min={0} max={50} value={borderRadius} onChange={(e) => onUpdate({ blockBorderRadius: `${e.target.value}px` })} />
          <span>px</span>
        </div>
      </div>

      {/* Border */}
      <label className="eb-settings-label">Border</label>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <div className="eb-settings-padding-field" style={{ flex: 'none' }}>
          <input type="number" min={0} max={10} value={borderWidth} onChange={(e) => onUpdate({ blockBorderWidth: `${e.target.value}px` })} />
          <span>px</span>
        </div>
        <input
          type="color"
          className="eb-settings-color eb-settings-color-compact"
          value={borderColor}
          onChange={(e) => onUpdate({ blockBorderColor: e.target.value })}
        />
        {borderWidth > 0 && (
          <button className="btn btn-ghost btn-sm" style={{ fontSize: 'var(--text-xs)', padding: '2px 6px' }}
            onClick={() => onUpdate({ blockBorderWidth: '0px', blockBorderColor: undefined })}
          >Reset</button>
        )}
      </div>
    </>
  );
}

function SettingsPanelInner({ block, onUpdate }: { block: EmailBlock; onUpdate: (patch: Partial<any>) => void }) {
  switch (block.type) {
    case 'heading':
      return null;
    case 'text':
      return null;
    case 'image': {
      const p = block.props as ImageProps;
      return (
        <>
          <label className="eb-settings-label">Image</label>
          <ImagePicker value={p.src} onChange={(src) => onUpdate({ src })} />
          <label className="eb-settings-label">Alt Text</label>
          <input className="eb-settings-input" value={p.alt} onChange={(e) => onUpdate({ alt: e.target.value })} />
          <label className="eb-settings-label">Link URL (optional)</label>
          <input className="eb-settings-input" placeholder="https://..." value={p.href} onChange={(e) => onUpdate({ href: e.target.value })} />
          <label className="eb-settings-label">Width</label>
          <select className="eb-settings-select" value={p.width} onChange={(e) => onUpdate({ width: e.target.value })}>
            <option value="100%">Full width</option>
            <option value="300px">300px</option>
            <option value="200px">200px</option>
            <option value="150px">150px</option>
          </select>
        </>
      );
    }
    case 'button': {
      const p = block.props as ButtonProps;
      return (
        <>
          <label className="eb-settings-label">Label</label>
          <input className="eb-settings-input" value={p.label} onChange={(e) => onUpdate({ label: e.target.value })} />
          <label className="eb-settings-label">URL</label>
          <input className="eb-settings-input" placeholder="https://..." value={p.url} onChange={(e) => onUpdate({ url: e.target.value })} />
          <label className="eb-settings-label">Button Color</label>
          <input type="color" className="eb-settings-color" value={p.bgColor} onChange={(e) => onUpdate({ bgColor: e.target.value })} />
          <label className="eb-settings-label">Text Color</label>
          <input type="color" className="eb-settings-color" value={p.textColor} onChange={(e) => onUpdate({ textColor: e.target.value })} />
          <label className="eb-settings-label">Corner Radius</label>
          <select className="eb-settings-select" value={p.borderRadius} onChange={(e) => onUpdate({ borderRadius: e.target.value })}>
            <option value="0">Square</option>
            <option value="4px">Slightly rounded</option>
            <option value="6px">Rounded</option>
            <option value="20px">Pill</option>
          </select>
          <label className="eb-settings-label">Alignment</label>
          <AlignPicker value={p.align} onChange={(align) => onUpdate({ align })} />
        </>
      );
    }
    case 'divider': {
      const p = block.props as DividerProps;
      return (
        <>
          <label className="eb-settings-label">Color</label>
          <input type="color" className="eb-settings-color" value={p.color} onChange={(e) => onUpdate({ color: e.target.value })} />
          <label className="eb-settings-label">Thickness</label>
          <select className="eb-settings-select" value={p.width} onChange={(e) => onUpdate({ width: e.target.value })}>
            <option value="1px">Thin (1px)</option>
            <option value="2px">Medium (2px)</option>
            <option value="3px">Thick (3px)</option>
          </select>
        </>
      );
    }
    case 'spacer': {
      const p = block.props as SpacerProps;
      return (
        <>
          <label className="eb-settings-label">Height</label>
          <select className="eb-settings-select" value={p.height} onChange={(e) => onUpdate({ height: e.target.value })}>
            <option value="8px">Extra Small (8px)</option>
            <option value="16px">Small (16px)</option>
            <option value="20px">Medium (20px)</option>
            <option value="32px">Large (32px)</option>
            <option value="48px">Extra Large (48px)</option>
          </select>
        </>
      );
    }
    case 'columns': {
      const p = block.props as ColumnsProps;
      return (
        <>
          <label className="eb-settings-label">Layout</label>
          <select className="eb-settings-select" value={p.layout} onChange={(e) => {
            const layout = e.target.value as ColumnsProps['layout'];
            const colCount = layout === '33-33-33' ? 3 : 2;
            const columns = Array.from({ length: colCount }, (_, i) => p.columns[i] || { blocks: [] });
            onUpdate({ layout, columns });
          }}>
            <option value="50-50">50 / 50</option>
            <option value="70-30">70 / 30</option>
            <option value="30-70">30 / 70</option>
            <option value="33-33-33">33 / 33 / 33</option>
          </select>
          <p className="eb-settings-hint">Drag blocks into columns to populate them.</p>
        </>
      );
    }
    case 'social': {
      const p = block.props as SocialProps;
      return (
        <>
          <label className="eb-settings-label">Alignment</label>
          <AlignPicker value={p.align} onChange={(align) => onUpdate({ align })} />
          {p.networks.map((n, i) => (
            <div key={i} className="eb-settings-social-row">
              <select className="eb-settings-select" value={n.icon} onChange={(e) => {
                const networks = [...p.networks];
                networks[i] = { ...n, icon: e.target.value, name: e.target.value.charAt(0).toUpperCase() + e.target.value.slice(1) };
                onUpdate({ networks });
              }}>
                <option value="facebook">Facebook</option>
                <option value="twitter">Twitter</option>
                <option value="instagram">Instagram</option>
                <option value="linkedin">LinkedIn</option>
                <option value="youtube">YouTube</option>
              </select>
              <input className="eb-settings-input" placeholder="URL" value={n.url} onChange={(e) => {
                const networks = [...p.networks];
                networks[i] = { ...n, url: e.target.value };
                onUpdate({ networks });
              }} />
              <button className="btn btn-ghost btn-sm" onClick={() => {
                const networks = p.networks.filter((_, j) => j !== i);
                onUpdate({ networks });
              }}>✕</button>
            </div>
          ))}
          <button className="btn btn-secondary btn-sm" style={{ marginTop: 'var(--space-2)' }} onClick={() => {
            onUpdate({ networks: [...p.networks, { name: 'Facebook', url: '#', icon: 'facebook' }] });
          }}>+ Add Network</button>
        </>
      );
    }
    case 'footer': {
      const p = block.props as FooterProps;
      return (
        <>
          <label className="eb-settings-label">
            <input type="checkbox" checked={p.showUnsubscribe} onChange={(e) => onUpdate({ showUnsubscribe: e.target.checked })} style={{ marginRight: '8px' }} />
            Show unsubscribe link
          </label>
        </>
      );
    }
    case 'table': {
      const p = block.props as TableProps;
      return (
        <>
          <label className="eb-settings-label">Header Background</label>
          <input type="color" className="eb-settings-color" value={p.headerBgColor} onChange={(e) => onUpdate({ headerBgColor: e.target.value })} />
          <label className="eb-settings-label">Header Text Color</label>
          <input type="color" className="eb-settings-color" value={p.headerTextColor} onChange={(e) => onUpdate({ headerTextColor: e.target.value })} />
          <label className="eb-settings-label">Border Color</label>
          <input type="color" className="eb-settings-color" value={p.borderColor} onChange={(e) => onUpdate({ borderColor: e.target.value })} />
          <label className="eb-settings-label">
            <input type="checkbox" checked={p.striped} onChange={(e) => onUpdate({ striped: e.target.checked })} style={{ marginRight: '8px' }} />
            Striped rows
          </label>
          <label className="eb-settings-label">Alignment</label>
          <AlignPicker value={p.align} onChange={(align) => onUpdate({ align })} />

          <div className="eb-settings-divider" />
          <label className="eb-settings-label">Rows &amp; Columns</label>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            <button className="btn btn-secondary btn-sm" onClick={() => {
              const newRow = new Array(p.headers.length).fill('');
              onUpdate({ rows: [...p.rows, newRow] });
            }}>+ Row</button>
            <button className="btn btn-secondary btn-sm" onClick={() => {
              if (p.rows.length > 1) onUpdate({ rows: p.rows.slice(0, -1) });
            }}>− Row</button>
            <button className="btn btn-secondary btn-sm" onClick={() => {
              onUpdate({
                headers: [...p.headers, `Col ${p.headers.length + 1}`],
                rows: p.rows.map(row => [...row, '']),
              });
            }}>+ Column</button>
            <button className="btn btn-secondary btn-sm" onClick={() => {
              if (p.headers.length > 1) {
                onUpdate({
                  headers: p.headers.slice(0, -1),
                  rows: p.rows.map(row => row.slice(0, -1)),
                });
              }
            }}>− Column</button>
          </div>
        </>
      );
    }
    case 'form-text-input': {
      const p = block.props as FormTextInputProps;
      return (
        <>
          <label className="eb-settings-label">Label</label>
          <input className="eb-settings-input" value={p.label} onChange={(e) => onUpdate({ label: e.target.value })} />
          <label className="eb-settings-label">Placeholder</label>
          <input className="eb-settings-input" value={p.placeholder} onChange={(e) => onUpdate({ placeholder: e.target.value })} />
          <label className="eb-settings-label">Field Name</label>
          <input className="eb-settings-input" value={p.fieldName} onChange={(e) => onUpdate({ fieldName: e.target.value })} />
          <label className="eb-settings-label">Input Type</label>
          <select className="eb-settings-select" value={p.inputType} onChange={(e) => onUpdate({ inputType: e.target.value })}>
            <option value="text">Text</option>
            <option value="email">Email</option>
            <option value="tel">Phone</option>
            <option value="url">URL</option>
            <option value="number">Number</option>
          </select>
          <label className="eb-settings-label">
            <input type="checkbox" checked={p.required} onChange={(e) => onUpdate({ required: e.target.checked })} style={{ marginRight: '8px' }} />
            Required
          </label>
        </>
      );
    }
    case 'form-textarea': {
      const p = block.props as FormTextareaProps;
      return (
        <>
          <label className="eb-settings-label">Label</label>
          <input className="eb-settings-input" value={p.label} onChange={(e) => onUpdate({ label: e.target.value })} />
          <label className="eb-settings-label">Placeholder</label>
          <input className="eb-settings-input" value={p.placeholder} onChange={(e) => onUpdate({ placeholder: e.target.value })} />
          <label className="eb-settings-label">Field Name</label>
          <input className="eb-settings-input" value={p.fieldName} onChange={(e) => onUpdate({ fieldName: e.target.value })} />
          <label className="eb-settings-label">Rows</label>
          <input type="number" className="eb-settings-input" value={p.rows} min={2} max={20} onChange={(e) => onUpdate({ rows: Number(e.target.value) })} />
          <label className="eb-settings-label">
            <input type="checkbox" checked={p.required} onChange={(e) => onUpdate({ required: e.target.checked })} style={{ marginRight: '8px' }} />
            Required
          </label>
        </>
      );
    }
    case 'form-select': {
      const p = block.props as FormSelectProps;
      return (
        <>
          <label className="eb-settings-label">Label</label>
          <input className="eb-settings-input" value={p.label} onChange={(e) => onUpdate({ label: e.target.value })} />
          <label className="eb-settings-label">Placeholder</label>
          <input className="eb-settings-input" value={p.placeholder} onChange={(e) => onUpdate({ placeholder: e.target.value })} />
          <label className="eb-settings-label">Field Name</label>
          <input className="eb-settings-input" value={p.fieldName} onChange={(e) => onUpdate({ fieldName: e.target.value })} />
          <label className="eb-settings-label">
            <input type="checkbox" checked={p.required} onChange={(e) => onUpdate({ required: e.target.checked })} style={{ marginRight: '8px' }} />
            Required
          </label>
          <div className="eb-settings-divider" />
          <label className="eb-settings-label">Options</label>
          {p.options.map((opt, i) => (
            <div key={i} style={{ display: 'flex', gap: '4px', marginBottom: '4px' }}>
              <input className="eb-settings-input" value={opt} onChange={(e) => {
                const newOpts = [...p.options];
                newOpts[i] = e.target.value;
                onUpdate({ options: newOpts });
              }} style={{ flex: 1 }} />
              <button className="btn btn-ghost btn-sm" onClick={() => onUpdate({ options: p.options.filter((_, j) => j !== i) })} title="Remove">✕</button>
            </div>
          ))}
          <button className="btn btn-secondary btn-sm" onClick={() => onUpdate({ options: [...p.options, `Option ${p.options.length + 1}`] })}>+ Add Option</button>
        </>
      );
    }
    case 'form-checkbox': {
      const p = block.props as FormCheckboxProps;
      return (
        <>
          <label className="eb-settings-label">Label</label>
          <input className="eb-settings-input" value={p.label} onChange={(e) => onUpdate({ label: e.target.value })} />
          <label className="eb-settings-label">Field Name</label>
          <input className="eb-settings-input" value={p.fieldName} onChange={(e) => onUpdate({ fieldName: e.target.value })} />
          <label className="eb-settings-label">
            <input type="checkbox" checked={p.checkedByDefault} onChange={(e) => onUpdate({ checkedByDefault: e.target.checked })} style={{ marginRight: '8px' }} />
            Checked by default
          </label>
          {p.checkedByDefault && (
            <div style={{ padding: '8px 10px', borderRadius: '6px', background: 'rgba(217, 119, 6, 0.1)', border: '1px solid rgba(217, 119, 6, 0.3)', marginTop: '6px' }}>
              <p style={{ fontSize: '11px', color: '#d97706', fontWeight: 600, margin: 0 }}>⚠ Compliance Warning</p>
              <p style={{ fontSize: '11px', color: '#92400e', margin: '4px 0 0' }}>
                Pre-checked consent boxes may not satisfy TCPA requirements for Prior Express Written Consent. Users must actively check the box.
              </p>
            </div>
          )}
        </>
      );
    }
    case 'form-radio': {
      const p = block.props as FormRadioProps;
      return (
        <>
          <label className="eb-settings-label">Label</label>
          <input className="eb-settings-input" value={p.label} onChange={(e) => onUpdate({ label: e.target.value })} />
          <label className="eb-settings-label">Field Name</label>
          <input className="eb-settings-input" value={p.fieldName} onChange={(e) => onUpdate({ fieldName: e.target.value })} />
          <label className="eb-settings-label">
            <input type="checkbox" checked={p.required} onChange={(e) => onUpdate({ required: e.target.checked })} style={{ marginRight: '8px' }} />
            Required
          </label>
          <div className="eb-settings-divider" />
          <label className="eb-settings-label">Options</label>
          {p.options.map((opt, i) => (
            <div key={i} style={{ display: 'flex', gap: '4px', marginBottom: '4px' }}>
              <input className="eb-settings-input" value={opt} onChange={(e) => {
                const newOpts = [...p.options];
                newOpts[i] = e.target.value;
                onUpdate({ options: newOpts });
              }} style={{ flex: 1 }} />
              <button className="btn btn-ghost btn-sm" onClick={() => onUpdate({ options: p.options.filter((_, j) => j !== i) })} title="Remove">✕</button>
            </div>
          ))}
          <button className="btn btn-secondary btn-sm" onClick={() => onUpdate({ options: [...p.options, `Option ${p.options.length + 1}`] })}>+ Add Option</button>
        </>
      );
    }
    case 'form-submit': {
      const p = block.props as FormSubmitProps;
      return (
        <>
          <label className="eb-settings-label">Button Label</label>
          <input className="eb-settings-input" value={p.label} onChange={(e) => onUpdate({ label: e.target.value })} />
          <label className="eb-settings-label">Background Color</label>
          <input type="color" className="eb-settings-color" value={p.bgColor} onChange={(e) => onUpdate({ bgColor: e.target.value })} />
          <label className="eb-settings-label">Text Color</label>
          <input type="color" className="eb-settings-color" value={p.textColor} onChange={(e) => onUpdate({ textColor: e.target.value })} />
          <label className="eb-settings-label">Border Radius</label>
          <input className="eb-settings-input" value={p.borderRadius} onChange={(e) => onUpdate({ borderRadius: e.target.value })} />
          <label className="eb-settings-label">Alignment</label>
          <AlignPicker value={p.align} onChange={(align) => onUpdate({ align })} />
          <div className="eb-settings-divider" />
          <label className="eb-settings-label">Success Message</label>
          <input className="eb-settings-input" value={p.successMessage} onChange={(e) => onUpdate({ successMessage: e.target.value })} />
        </>
      );
    }
    default:
      return <p className="text-tertiary">No settings for this block.</p>;
  }
}

// --- Alignment picker ---

function AlignPicker({ value, onChange }: { value: string; onChange: (v: 'left' | 'center' | 'right') => void }) {
  return (
    <div className="eb-settings-align">
      {(['left', 'center', 'right'] as const).map((a) => (
        <button
          key={a}
          className={`eb-settings-align-btn ${value === a ? 'active' : ''}`}
          onClick={() => onChange(a)}
          title={a}
        >
          {a === 'left' ? '⬅' : a === 'center' ? '⬛' : '➡'}
        </button>
      ))}
    </div>
  );
}
