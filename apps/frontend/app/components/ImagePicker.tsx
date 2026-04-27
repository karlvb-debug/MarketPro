// ============================================
// Image Picker — Upload + browse from library
// Used in image block settings and background
// image selection.
// ============================================

'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import {
  loadImageLibrary,
  addImageToLibrary,
  removeImageFromLibrary,
  fileToLibraryImage,
  formatFileSize,
  type LibraryImage,
} from '../lib/image-library';

interface ImagePickerProps {
  value: string; // current image URL or data URL
  onChange: (url: string) => void;
  label?: string;
  compact?: boolean; // minimal mode for background image picker
}

export default function ImagePicker({ value, onChange, label, compact }: ImagePickerProps) {
  const [showLibrary, setShowLibrary] = useState(false);
  const [images, setImages] = useState<LibraryImage[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [urlInput, setUrlInput] = useState(value || '');
  const fileRef = useRef<HTMLInputElement>(null);

  const refreshLibrary = useCallback(() => {
    setImages(loadImageLibrary());
  }, []);

  useEffect(() => {
    if (showLibrary) refreshLibrary();
  }, [showLibrary, refreshLibrary]);

  // Sync external value → URL input
  useEffect(() => {
    setUrlInput(value || '');
  }, [value]);

  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError('');
    setUploading(true);

    try {
      const img = await fileToLibraryImage(file);
      addImageToLibrary(img);
      refreshLibrary();
      onChange(img.dataUrl);
      setUrlInput(img.dataUrl);
    } catch (err: any) {
      setError(err.message || 'Upload failed');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }, [onChange, refreshLibrary]);

  const handleUrlApply = useCallback(() => {
    if (urlInput.trim()) {
      onChange(urlInput.trim());
    }
  }, [urlInput, onChange]);

  const handleSelectFromLibrary = useCallback((img: LibraryImage) => {
    onChange(img.dataUrl);
    setUrlInput(img.dataUrl);
    setShowLibrary(false);
  }, [onChange]);

  const handleDelete = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    removeImageFromLibrary(id);
    refreshLibrary();
  }, [refreshLibrary]);

  const handleClear = useCallback(() => {
    onChange('');
    setUrlInput('');
  }, [onChange]);

  // Compact mode: just a small row
  if (compact) {
    return (
      <div className="img-picker-compact">
        {value ? (
          <div className="img-picker-compact-preview">
            <img src={value} alt="" className="img-picker-compact-thumb" />
            <button className="btn btn-ghost btn-sm" style={{ fontSize: 'var(--text-xs)', padding: '2px 6px' }} onClick={handleClear}>Remove</button>
            <button className="btn btn-ghost btn-sm" style={{ fontSize: 'var(--text-xs)', padding: '2px 6px' }} onClick={() => setShowLibrary(true)}>Change</button>
          </div>
        ) : (
          <div className="img-picker-compact-actions">
            <button className="btn btn-secondary btn-sm" style={{ fontSize: 'var(--text-xs)' }} onClick={() => fileRef.current?.click()}>
              Upload
            </button>
            <button className="btn btn-secondary btn-sm" style={{ fontSize: 'var(--text-xs)' }} onClick={() => setShowLibrary(true)}>
              Library
            </button>
          </div>
        )}
        <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleFileUpload} />

        {/* Library modal */}
        {showLibrary && (
          <div className="img-picker-overlay" onClick={() => setShowLibrary(false)}>
            <div className="img-picker-modal" onClick={(e) => e.stopPropagation()}>
              <ImageLibraryGrid
                images={images}
                onSelect={handleSelectFromLibrary}
                onDelete={handleDelete}
                onUpload={() => fileRef.current?.click()}
                uploading={uploading}
              />
            </div>
          </div>
        )}
      </div>
    );
  }

  // Full mode: URL input + upload + library
  return (
    <div className="img-picker">
      {label && <label className="eb-settings-label">{label}</label>}

      {/* Current preview */}
      {value && (
        <div className="img-picker-preview">
          <img src={value} alt="" className="img-picker-preview-img" />
          <button className="btn btn-ghost btn-sm" style={{ fontSize: 'var(--text-xs)' }} onClick={handleClear}>Remove</button>
        </div>
      )}

      {/* URL input */}
      <div className="img-picker-url-row">
        <input
          className="eb-settings-input"
          placeholder="https://... or upload below"
          value={urlInput.startsWith('data:') ? '(uploaded image)' : urlInput}
          onChange={(e) => { setUrlInput(e.target.value); }}
          onBlur={handleUrlApply}
          onKeyDown={(e) => { if (e.key === 'Enter') handleUrlApply(); }}
        />
      </div>

      {/* Action buttons */}
      <div className="img-picker-actions">
        <button className="btn btn-secondary btn-sm" onClick={() => fileRef.current?.click()} disabled={uploading}>
          {uploading ? 'Uploading…' : 'Upload Image'}
        </button>
        <button className="btn btn-secondary btn-sm" onClick={() => setShowLibrary(true)}>
          Browse Library {images.length > 0 ? `(${images.length})` : ''}
        </button>
      </div>
      <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleFileUpload} />

      {error && <p className="img-picker-error">{error}</p>}

      {/* Library modal */}
      {showLibrary && (
        <div className="img-picker-overlay" onClick={() => setShowLibrary(false)}>
          <div className="img-picker-modal" onClick={(e) => e.stopPropagation()}>
            <ImageLibraryGrid
              images={images}
              onSelect={handleSelectFromLibrary}
              onDelete={handleDelete}
              onUpload={() => fileRef.current?.click()}
              uploading={uploading}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// --- Image Library Grid (shared between modes) ---

function ImageLibraryGrid({
  images, onSelect, onDelete, onUpload, uploading,
}: {
  images: LibraryImage[];
  onSelect: (img: LibraryImage) => void;
  onDelete: (id: string, e: React.MouseEvent) => void;
  onUpload: () => void;
  uploading: boolean;
}) {
  return (
    <div className="img-lib">
      <div className="img-lib-header">
        <h4 className="img-lib-title">Image Library</h4>
        <button className="btn btn-primary btn-sm" onClick={onUpload} disabled={uploading}>
          {uploading ? 'Uploading…' : '+ Upload'}
        </button>
      </div>

      {images.length === 0 ? (
        <div className="img-lib-empty">
          <p>No images yet. Upload one to get started.</p>
          <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
            Max 5MB per image. Supports PNG, JPG, GIF, WebP.
          </p>
        </div>
      ) : (
        <div className="img-lib-grid">
          {images.map((img) => (
            <div key={img.id} className="img-lib-item" onClick={() => onSelect(img)}>
              <img src={img.dataUrl} alt={img.name} className="img-lib-thumb" />
              <div className="img-lib-meta">
                <span className="img-lib-name" title={img.name}>{img.name}</span>
                <span className="img-lib-size">{img.width}×{img.height} · {formatFileSize(img.size)}</span>
              </div>
              <button
                className="img-lib-delete"
                onClick={(e) => onDelete(img.id, e)}
                title="Delete from library"
              >✕</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
