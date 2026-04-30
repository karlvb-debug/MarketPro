'use client';

import { useState, useRef, useMemo, useCallback } from 'react';
import Modal from './Modal';
import { FormSelect } from './FormElements';
import { showToast } from './Toast';
import {
  parseCsv,
  parseXlsx,
  guessColumnMapping,
  processImportRow,
  SYSTEM_FIELDS,
  SystemFieldKey,
  ProcessedContact,
  isBlankRow,
} from '../lib/contact-utils';
import type { Contact } from '../lib/store';
import { api } from '../lib/api-client';

// ============================================
// Types
// ============================================

type ImportStep = 'upload' | 'map' | 'preview' | 'confirm';

interface ImportWizardProps {
  isOpen: boolean;
  onClose: () => void;
  activeSegmentName?: string;
  importContacts: (
    contacts: Omit<Contact, 'contactId' | 'createdAt' | 'compliance'>[]
  ) => { added: number; updated: number; skipped: number; blankSkipped?: number };
}

const STEPS: { key: ImportStep; label: string }[] = [
  { key: 'upload', label: 'Upload' },
  { key: 'map', label: 'Map Columns' },
  { key: 'preview', label: 'Preview' },
  { key: 'confirm', label: 'Import' },
];

// ============================================
// Component
// ============================================

export default function ImportWizard({
  isOpen,
  onClose,
  activeSegmentName,
  importContacts,
}: ImportWizardProps) {
  // Step state
  const [step, setStep] = useState<ImportStep>('upload');
  const [result, setResult] = useState<{ added: number; updated: number; skipped: number; blankSkipped: number; noIdSkipped: number; background?: boolean } | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  // Upload state
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [isDragging, setIsDragging] = useState(false);

  // CSV data
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvRows, setCsvRows] = useState<string[][]>([]);

  // Column mapping: csvHeader → systemFieldKey (or '')
  const [mapping, setMapping] = useState<Record<string, SystemFieldKey | ''>>({});

  // Processed preview data
  const [processedContacts, setProcessedContacts] = useState<ProcessedContact[]>([]);
  const [blankRowCount, setBlankRowCount] = useState(0);

  // Consent source (compliance step)
  const [consentSource, setConsentSource] = useState<string>('');

  // ---- Reset ----
  const resetWizard = useCallback(() => {
    setStep('upload');
    setResult(null);
    setFileName('');
    setCsvHeaders([]);
    setCsvRows([]);
    setMapping({});
    setProcessedContacts([]);
    setBlankRowCount(0);
    setIsDragging(false);
    setConsentSource('');
    setIsUploading(false);
    // Reset file input
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  const handleClose = () => {
    resetWizard();
    onClose();
  };

  // ---- Step 1: Upload ----
  const handleFile = (file: File) => {
    const isXlsx = file.name.endsWith('.xlsx') || file.name.endsWith('.xls');
    const isCsv = file.name.endsWith('.csv');

    if (!isXlsx && !isCsv) {
      showToast('Please upload a CSV or Excel (.xlsx) file', 'error');
      return;
    }
    setFileName(file.name);

    if (isXlsx) {
      // XLSX path — read as ArrayBuffer
      const reader = new FileReader();
      reader.onload = async (evt) => {
        const buffer = evt.target?.result as ArrayBuffer;
        try {
          const { headers, rows } = await parseXlsx(buffer);
          if (headers.length === 0 || rows.length === 0) {
            showToast('Spreadsheet is empty or has no data rows.', 'error');
            return;
          }
          setCsvHeaders(headers);
          setCsvRows(rows);
          const autoMapping = guessColumnMapping(headers);
          setMapping(autoMapping as Record<string, SystemFieldKey | ''>);
          setStep('map');
        } catch {
          showToast('Failed to read Excel file. Please try saving as .xlsx and re-uploading.', 'error');
        }
      };
      reader.readAsArrayBuffer(file);
    } else {
      // CSV path — read as text
      const reader = new FileReader();
      reader.onload = (evt) => {
        const text = evt.target?.result as string;
        const { headers, rows } = parseCsv(text);
        if (headers.length === 0 || rows.length === 0) {
          showToast('CSV file is empty or has no data rows.', 'error');
          return;
        }
        setCsvHeaders(headers);
        setCsvRows(rows);
        const autoMapping = guessColumnMapping(headers);
        setMapping(autoMapping as Record<string, SystemFieldKey | ''>);
        setStep('map');
      };
      reader.readAsText(file);
    }
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  // ---- Step 2: Map Columns ----
  const handleMappingChange = (csvHeader: string, fieldKey: SystemFieldKey | '') => {
    setMapping((prev) => {
      const next = { ...prev };
      // If the field was already assigned to another header, unset it
      if (fieldKey) {
        for (const key of Object.keys(next)) {
          if (next[key] === fieldKey) {
            next[key] = '';
          }
        }
      }
      next[csvHeader] = fieldKey;
      return next;
    });
  };

  const mappedFieldCount = Object.values(mapping).filter(Boolean).length;

  // Sample preview rows for the mapping step (first 3)
  const sampleRows = csvRows.slice(0, 3);

  // ---- Step 3: Preview ----
  const runPreview = () => {
    let blanks = 0;
    const processed: ProcessedContact[] = [];

    for (const row of csvRows) {
      // Check if the raw row is completely blank
      const rawObj: Record<string, string> = {};
      csvHeaders.forEach((h, i) => { rawObj[h] = row[i] || ''; });
      if (isBlankRow(rawObj)) {
        blanks++;
        continue;
      }

      const result = processImportRow(row, mapping);
      if (result === null) {
        blanks++;
        continue;
      }
      processed.push(result);
    }

    setBlankRowCount(blanks);
    setProcessedContacts(processed);
    setStep('preview');
  };

  // Preview stats
  const previewStats = useMemo(() => {
    let valid = 0;
    let withFixes = 0;
    let withWarnings = 0;
    let withErrors = 0;

    for (const c of processedContacts) {
      const hasError = c.issues.some((i) => i.type === 'error');
      const hasWarning = c.issues.some((i) => i.type === 'warning');
      const hasFix = c.issues.some((i) => i.type === 'fixed');

      if (hasError) withErrors++;
      else if (hasWarning) withWarnings++;
      else if (hasFix) withFixes++;
      else valid++;
    }

    return { valid, withFixes, withWarnings, withErrors, total: processedContacts.length, noIdentifier: processedContacts.filter((c) => c.skippedReason).length };
  }, [processedContacts]);

  // Contacts that are actually importable (have at least email or phone)
  const importableContacts = useMemo(() =>
    processedContacts.filter((c) => !c.skippedReason),
  [processedContacts]);

  // ---- Step 4: Confirm Import ----
  const handleImport = async () => {
    setIsUploading(true);
    
    // Check if we need to use the background bulk uploader (> 1000 rows)
    if (importableContacts.length > 1000) {
      try {
        // 1. Convert processedContacts to CSV string
        const headerRow = ['firstName', 'lastName', 'email', 'phone', 'company', 'state', 'timezone'];
        const csvRowsData = importableContacts.map(c => [
          c.firstName, c.lastName, c.email, c.phone, c.company, c.state, c.timezone
        ].map(val => `"${(val || '').replace(/"/g, '""')}"`).join(','));
        const csvString = [headerRow.join(','), ...csvRowsData].join('\n');

        // 2. Get Presigned URL
        const { url } = await api.contacts.getImportUrl();

        // 3. Upload to S3
        const response = await fetch(url, {
          method: 'PUT',
          body: csvString,
          headers: {
            'Content-Type': 'text/csv'
          }
        });

        if (!response.ok) {
          throw new Error('S3 Upload Failed');
        }

        setResult({
          added: importableContacts.length,
          updated: 0,
          skipped: 0,
          blankSkipped: blankRowCount,
          noIdSkipped: previewStats.noIdentifier,
          background: true,
        });
        setStep('confirm');
      } catch (error) {
        console.error(error);
        showToast('Failed to upload bulk import file', 'error');
      } finally {
        setIsUploading(false);
      }
      return;
    }

    // Synchronous local/API import (<= 1000 rows)
    const contactsToImport = importableContacts.map((c) => ({
      firstName: c.firstName,
      lastName: c.lastName,
      email: c.email,
      phone: c.phone,
      company: c.company,
      state: c.state,
      timezone: c.timezone,
      segments: activeSegmentName ? [activeSegmentName] : ([] as string[]),
      source: 'csv_import',
      consentSource: (consentSource || 'unknown') as Contact['consentSource'],
    }));

    const importResult = importContacts(contactsToImport);
    setResult({
      added: importResult.added,
      updated: importResult.updated,
      skipped: importResult.skipped,
      blankSkipped: blankRowCount,
      noIdSkipped: previewStats.noIdentifier,
    });
    setStep('confirm');
    setIsUploading(false);
  };

  // ---- Step index for wizard indicator ----
  const stepIndex = STEPS.findIndex((s) => s.key === step);

  // ============================================
  // Render
  // ============================================

  const modalTitle = result
    ? 'Import Complete'
    : activeSegmentName
      ? `Import into "${activeSegmentName}"`
      : 'Import Contacts';

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title={modalTitle} width="740px">
      {/* ---- Success Screen ---- */}
      {result ? (
        <div className="import-success">
          <div className="import-success-icon">✓</div>
          <p className="import-success-title">
            {result.background ? 'Upload Complete!' : 'Import Complete!'}
          </p>
          {result.background && (
            <p className="text-secondary mb-4" style={{ textAlign: 'center' }}>
              Your file of {result.added} contacts has been uploaded securely and is processing in the background. It may take a few minutes for all contacts to appear.
            </p>
          )}
          <div className="import-success-stats">
            <div className="import-stat-card import-stat-added">
              <span className="import-stat-num">{result.added}</span>
              <span className="import-stat-label">Imported</span>
            </div>
            {result.skipped > 0 && (
              <div className="import-stat-card import-stat-skipped">
                <span className="import-stat-num">{result.skipped}</span>
                <span className="import-stat-label">Duplicates Skipped</span>
              </div>
            )}
            {result.updated > 0 && (
              <div className="import-stat-card import-stat-fixed">
                <span className="import-stat-num">{result.updated}</span>
                <span className="import-stat-label">Records Updated</span>
              </div>
            )}
            {result.blankSkipped > 0 && (
              <div className="import-stat-card import-stat-blank">
                <span className="import-stat-num">{result.blankSkipped}</span>
                <span className="import-stat-label">Blank Rows Excluded</span>
              </div>
            )}
            {result.noIdSkipped > 0 && (
              <div className="import-stat-card import-stat-skipped">
                <span className="import-stat-num">{result.noIdSkipped}</span>
                <span className="import-stat-label">No Valid Identifier</span>
              </div>
            )}
          </div>
          {activeSegmentName && (
            <p className="import-success-segment">
              Added to segment <strong>{activeSegmentName}</strong>
            </p>
          )}
          <button className="btn btn-primary" onClick={handleClose}>
            Done
          </button>
        </div>
      ) : (
        <>
          {/* ---- Wizard Step Indicator ---- */}
          <div className="wizard-steps">
            {STEPS.map((s, i) => (
              <div className="wizard-step" key={s.key}>
                <div
                  className={`wizard-step-circle ${
                    i < stepIndex ? 'completed' : i === stepIndex ? 'active' : 'inactive'
                  }`}
                >
                  {i < stepIndex ? '✓' : i + 1}
                </div>
                <span
                  className={`wizard-step-label ${
                    i <= stepIndex ? 'active' : 'inactive'
                  }`}
                >
                  {s.label}
                </span>
                {i < STEPS.length - 1 && <div className="wizard-step-line" />}
              </div>
            ))}
          </div>

          {/* ---- Step 1: Upload ---- */}
          {step === 'upload' && (
            <>
              {activeSegmentName && (
                <div className="info-box mb-5" style={{ fontSize: 'var(--text-sm)' }}>
                  Imported contacts will be added to the master list and automatically assigned to{' '}
                  <strong>{activeSegmentName}</strong>.
                </div>
              )}
              <div
                className={`drop-zone ${isDragging ? 'active' : ''}`}
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={handleDrop}
                style={{ marginBottom: 'var(--space-6)' }}
              >
                <div style={{ fontSize: '2.5rem', marginBottom: 'var(--space-3)' }}>▣</div>
                <p
                  className="text-primary font-medium"
                  style={{ marginBottom: 'var(--space-2)' }}
                >
                  {isDragging ? 'Drop your CSV here' : 'Drop your CSV file here'}
                </p>
                <p
                  className="text-tertiary"
                  style={{ fontSize: 'var(--text-sm)', marginBottom: 'var(--space-4)' }}
                >
                  or click to browse
                </p>
                <button type="button" className="btn btn-secondary btn-sm">
                  Browse Files
                </button>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.xlsx,.xls"
                style={{ display: 'none' }}
                onChange={handleFileInput}
              />
              <div className="info-box">
                <p
                  className="font-medium text-primary"
                  style={{ fontSize: 'var(--text-sm)', marginBottom: 'var(--space-2)' }}
                >
                  CSV and Excel files supported
                </p>
                <p
                  className="text-secondary"
                  style={{ fontSize: 'var(--text-xs)', lineHeight: 1.8 }}
                >
                  Upload a <strong>.csv</strong> or <strong>.xlsx</strong> file. You&apos;ll map
                  your columns to contact fields in the next step. We&apos;ll auto-detect common
                  headers like &quot;First Name&quot;, &quot;Email&quot;, &quot;Phone&quot;, etc.
                  Multi-sheet workbooks will import from the first sheet.
                </p>
              </div>
            </>
          )}

          {/* ---- Step 2: Map Columns ---- */}
          {step === 'map' && (
            <>
              <div className="import-map-header">
                <div className="import-map-file">
                  <span className="import-map-file-icon">▣</span>
                  <div>
                    <span className="text-primary font-medium" style={{ fontSize: 'var(--text-sm)' }}>
                      {fileName}
                    </span>
                    <span className="text-tertiary" style={{ fontSize: 'var(--text-xs)', marginLeft: 'var(--space-3)' }}>
                      {csvRows.length} rows · {csvHeaders.length} columns
                    </span>
                  </div>
                </div>
                <span className="import-map-badge">
                  {mappedFieldCount} of {SYSTEM_FIELDS.length} mapped
                </span>
              </div>

              <div className="import-mapping-table">
                <div className="import-mapping-row import-mapping-header-row">
                  <div className="import-mapping-cell import-mapping-label">System Field</div>
                  <div className="import-mapping-cell" style={{ flex: '0 0 36px', textAlign: 'center' }}>→</div>
                  <div className="import-mapping-cell import-mapping-label">CSV Column</div>
                  <div className="import-mapping-cell import-mapping-label import-mapping-preview-col">Preview</div>
                </div>

                {SYSTEM_FIELDS.map((field) => {
                  const assignedHeader = Object.entries(mapping).find(
                    ([, v]) => v === field.key
                  )?.[0];
                  // Get a preview value from the first non-empty row
                  const previewIdx = assignedHeader ? csvHeaders.indexOf(assignedHeader) : -1;
                  const previewVal =
                    previewIdx >= 0
                      ? sampleRows.find((r) => r[previewIdx]?.trim())?.[previewIdx] || '—'
                      : '—';

                  return (
                    <div className="import-mapping-row" key={field.key}>
                      <div className="import-mapping-cell import-mapping-field">
                        <span className="import-mapping-icon">{field.icon}</span>
                        <span>{field.label}</span>
                      </div>
                      <div className="import-mapping-cell" style={{ flex: '0 0 36px', textAlign: 'center' }}>
                        <span className="text-tertiary" style={{ fontSize: 'var(--text-xs)' }}>←</span>
                      </div>
                      <div className="import-mapping-cell">
                        <FormSelect
                          value={assignedHeader || ''}
                          onChange={(e) => {
                            // Unset the old assignment for this field
                            if (assignedHeader) {
                              handleMappingChange(assignedHeader, '');
                            }
                            if (e.target.value) {
                              handleMappingChange(e.target.value, field.key);
                            }
                          }}
                          style={{ fontSize: 'var(--text-xs)', padding: '6px 8px' }}
                        >
                          <option value="">— Skip —</option>
                          {csvHeaders.map((h) => (
                            <option key={h} value={h} disabled={!!mapping[h] && mapping[h] !== field.key}>
                              {h} {mapping[h] && mapping[h] !== field.key ? '(mapped)' : ''}
                            </option>
                          ))}
                        </FormSelect>
                      </div>
                      <div className="import-mapping-cell import-mapping-preview-col">
                        <span className="import-mapping-preview-val">{previewVal}</span>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="form-actions">
                <button
                  className="btn btn-secondary"
                  onClick={() => { setStep('upload'); resetFileState(); }}
                >
                  ← Back
                </button>
                <button
                  className="btn btn-primary"
                  onClick={runPreview}
                  disabled={mappedFieldCount === 0}
                >
                  Preview Data →
                </button>
              </div>
            </>
          )}

          {/* ---- Step 3: Preview ---- */}
          {step === 'preview' && (
            <>
              {/* Summary badges */}
              <div className="import-preview-summary">
                <div className="import-preview-stat">
                  <span className="import-badge import-badge-clean">✓</span>
                  <span className="text-primary" style={{ fontSize: 'var(--text-sm)' }}>
                    {previewStats.valid} clean
                  </span>
                </div>
                <div className="import-preview-stat">
                  <span className="import-badge import-badge-fixed">↻</span>
                  <span className="text-primary" style={{ fontSize: 'var(--text-sm)' }}>
                    {previewStats.withFixes} auto-fixed
                  </span>
                </div>
                {previewStats.withWarnings > 0 && (
                  <div className="import-preview-stat">
                    <span className="import-badge import-badge-warning">!</span>
                    <span className="text-primary" style={{ fontSize: 'var(--text-sm)' }}>
                      {previewStats.withWarnings} warnings
                    </span>
                  </div>
                )}
                {previewStats.withErrors > 0 && (
                  <div className="import-preview-stat">
                    <span className="import-badge import-badge-error">✕</span>
                    <span className="text-primary" style={{ fontSize: 'var(--text-sm)' }}>
                      {previewStats.withErrors} errors
                    </span>
                  </div>
                )}
                {blankRowCount > 0 && (
                  <div className="import-preview-stat">
                    <span className="import-badge import-badge-blank">∅</span>
                    <span className="text-tertiary" style={{ fontSize: 'var(--text-sm)' }}>
                      {blankRowCount} blank excluded
                    </span>
                  </div>
                )}
                {previewStats.noIdentifier > 0 && (
                  <div className="import-preview-stat">
                    <span className="import-badge import-badge-error">⊘</span>
                    <span className="text-primary" style={{ fontSize: 'var(--text-sm)' }}>
                      {previewStats.noIdentifier} no identifier (skipped)
                    </span>
                  </div>
                )}
              </div>

              {/* Preview table */}
              <div className="import-preview-scroll">
                <table className="import-preview-table">
                  <thead>
                    <tr>
                      <th style={{ width: 32 }}>#</th>
                      <th>First Name</th>
                      <th>Last Name</th>
                      <th>Email</th>
                      <th>Phone</th>
                      <th>Company</th>
                      <th style={{ width: 60 }}>State</th>
                      <th style={{ width: 40 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {processedContacts.slice(0, 50).map((c, i) => {
                      const hasError = c.issues.some((iss) => iss.type === 'error');
                      const hasWarning = c.issues.some((iss) => iss.type === 'warning');
                      const hasFix = c.issues.some((iss) => iss.type === 'fixed');
                      const isSkipped = !!c.skippedReason;

                      return (
                        <tr
                          key={i}
                          className={
                            isSkipped
                              ? 'import-row-skipped'
                              : hasError
                                ? 'import-row-error'
                                : hasWarning
                                  ? 'import-row-warning'
                                  : hasFix
                                    ? 'import-row-fixed'
                                    : ''
                          }
                        >
                          <td className="text-tertiary" style={{ fontSize: 'var(--text-xs)' }}>
                            {i + 1}
                          </td>
                          <td>{renderCell(c.firstName, c.issues, 'firstName')}</td>
                          <td>{renderCell(c.lastName, c.issues, 'lastName')}</td>
                          <td>{renderCell(c.email, c.issues, 'email')}</td>
                          <td className="font-mono">{renderCell(c.phone, c.issues, 'phone')}</td>
                          <td>{c.company || <span className="text-tertiary">—</span>}</td>
                          <td className="font-mono" style={{ fontSize: 'var(--text-xs)' }}>{c.state || <span className="text-tertiary">—</span>}</td>
                          <td>
                            {isSkipped ? (
                              <span
                                className="import-badge import-badge-error"
                                title={c.skippedReason}
                              >
                                SKIP
                              </span>
                            ) : c.issues.length > 0 ? (
                              <span
                                className={`import-badge ${
                                  hasError
                                    ? 'import-badge-error'
                                    : hasWarning
                                      ? 'import-badge-warning'
                                      : 'import-badge-fixed'
                                }`}
                                title={c.issues.map((i) => i.message).join('\n')}
                              >
                                {hasError ? '✕' : hasWarning ? '!' : '↻'}
                              </span>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {processedContacts.length > 50 && (
                <p
                  className="text-tertiary"
                  style={{
                    fontSize: 'var(--text-xs)',
                    textAlign: 'center',
                    marginTop: 'var(--space-3)',
                  }}
                >
                  Showing first 50 of {processedContacts.length} rows
                </p>
              )}

              <div className="form-actions">
                <button className="btn btn-secondary" onClick={() => setStep('map')} disabled={isUploading}>
                  ← Back
                </button>
                <button 
                  className="btn btn-primary" 
                  disabled={!consentSource || importableContacts.length === 0 || isUploading}
                  onClick={handleImport}
                >
                  {isUploading ? 'Uploading...' : `Import ${importableContacts.length} Contact${importableContacts.length !== 1 ? 's' : ''} →`}
                </button>
              </div>

              {/* Consent source selection (inline, before import) */}
              {!consentSource && (
                <div className="info-box" style={{ marginTop: 'var(--space-4)', borderColor: 'var(--accent-primary)', borderWidth: '2px' }}>
                  <p className="font-medium text-primary" style={{ fontSize: 'var(--text-sm)', marginBottom: 'var(--space-3)' }}>
                    How did you obtain consent from these contacts?
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                    {[
                      { value: 'collected_by_us' as const, label: 'We collected consent directly', desc: 'Via our own website forms, in-person sign-ups, or other direct methods' },
                      { value: 'partner_with_proof' as const, label: 'Third-party with proof', desc: 'Partner/vendor provided TrustedForm, Jornaya, or equivalent consent certificates' },
                      { value: 'existing_customers' as const, label: 'Existing customers (EBR)', desc: 'Established business relationship — purchased/inquired within 18 months' },
                      { value: 'purchased_list' as const, label: 'Purchased list', desc: 'Contacts were purchased from a data vendor' },
                    ].map((opt) => (
                      <label key={opt.value} style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--space-2)', cursor: 'pointer' }}>
                        <input
                          type="radio"
                          name="consent_source"
                          value={opt.value}
                          checked={consentSource === opt.value}
                          onChange={() => setConsentSource(opt.value)}
                          style={{ marginTop: 3, accentColor: 'var(--accent-primary)' }}
                        />
                        <div>
                          <span className="text-primary font-medium" style={{ fontSize: 'var(--text-sm)' }}>{opt.label}</span>
                          <p className="text-tertiary" style={{ fontSize: 'var(--text-xs)', marginTop: 2 }}>{opt.desc}</p>
                        </div>
                      </label>
                    ))}
                  </div>
                  {consentSource === 'purchased_list' && (
                    <div className="info-box info-box-warning" style={{ marginTop: 'var(--space-3)' }}>
                      <p className="font-medium" style={{ fontSize: 'var(--text-sm)', color: '#d97706' }}>
                        ⚠️ Purchased lists do not transfer consent under TCPA
                      </p>
                      <p className="text-tertiary" style={{ fontSize: 'var(--text-xs)', marginTop: 'var(--space-1)' }}>
                        SMS and Voice campaigns to these contacts may violate federal law. These contacts will be imported with email-only consent. Consult legal counsel before sending SMS or making calls.
                      </p>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}
    </Modal>
  );

  // Helper: reset file-related state when going back to upload
  function resetFileState() {
    setFileName('');
    setCsvHeaders([]);
    setCsvRows([]);
    setMapping({});
    setProcessedContacts([]);
    setBlankRowCount(0);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }
}

// ============================================
// Cell renderer with issue indicators
// ============================================

function renderCell(
  value: string,
  issues: ProcessedContact['issues'],
  fieldName: string
) {
  const fieldIssues = issues.filter((i) => i.field === fieldName);

  if (!value && fieldIssues.length === 0) {
    return <span className="text-tertiary">—</span>;
  }

  if (fieldIssues.length === 0) {
    return <span>{value}</span>;
  }

  const issue = fieldIssues[0]!;
  return (
    <span className="import-cell-with-issue">
      <span>{value}</span>
      <span
        className={`import-cell-indicator ${
          issue.type === 'error'
            ? 'import-cell-error'
            : issue.type === 'warning'
              ? 'import-cell-warning'
              : 'import-cell-fixed'
        }`}
        title={issue.message}
      >
        {issue.type === 'error' ? '✕' : issue.type === 'warning' ? '⚠' : '✓'}
      </span>
    </span>
  );
}
