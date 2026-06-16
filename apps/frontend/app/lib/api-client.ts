// ============================================
// API Client — Centralized HTTP layer
// Auto-attaches auth token + workspace headers
// ============================================

import { config } from './config';

// Token getter — set by AuthProvider
let getAuthToken: (() => Promise<string | null>) | null = null;
let currentWorkspaceId: string | null = null;
let onAuthExpired: (() => void) | null = null;

/** Called by AuthProvider to wire up token resolution */
export function setAuthTokenGetter(getter: () => Promise<string | null>) {
  getAuthToken = getter;
}

/** Called by AuthProvider to wire up sign-out on expired sessions */
export function setAuthExpiredHandler(handler: () => void) {
  onAuthExpired = handler;
}

/** Called by WorkspaceProvider when active workspace changes */
export function setActiveWorkspaceId(id: string) {
  currentWorkspaceId = id;
}

// ============================================
// Types
// ============================================

export interface ApiError {
  status: number;
  message: string;
  code?: string;
  /** Per-key custom-field validation errors (POST /contacts 400) */
  fieldErrors?: Record<string, string>;
  /** Required custom-field keys missing a value (POST /contacts 400) */
  missingRequired?: string[];
  /** Unique custom-field keys whose values are already in use (POST /contacts 409) */
  fields?: string[];
}

export interface ApiResponse<T> {
  data: T;
  meta?: {
    total?: number;
    page?: number;
    pageSize?: number;
    nextCursor?: string | null;
    hasMore?: boolean;
  };
}

/** A cluster of 2+ contacts sharing a normalized email or phone (GET /contacts/duplicates). */
export interface DuplicateCluster {
  keyType: 'email' | 'phone';
  key: string;
  contactIds: string[];
}

/** Result of POST /contacts/merge. */
export interface MergeResult {
  survivorId: string;
  mergedCount: number;
}

/**
 * Selection for a bulk action: either explicit ids ("the N rows I checked")
 * or a rule tree ("everything matching the active filters").
 */
export type BulkSelection = { contactIds: string[] } | { rules: unknown };

/**
 * Selection scope for an export job. Mirrors the backend Selection union
 * (lambda/lib/bulk.ts): explicit ids, a rule tree, or the entire workspace.
 */
export type ExportSelection = { contactIds: string[] } | { rules: unknown } | { all: true };

/**
 * Server-side saved view (GET/POST/PUT /views). `definition` is opaque JSON
 * the frontend owns — for contacts it holds the active filter chips + segment
 * (and optionally a column list). `userId` is the owner; `shared` exposes it
 * to the whole workspace.
 */
export interface SavedView {
  viewId: string;
  name: string;
  definition: unknown;
  shared: boolean;
  userId: string;
  createdAt: string;
  updatedAt: string;
}

/** Status of an async CSV export job (GET /contacts/export/{jobId}). */
export interface ExportJobStatus {
  status: 'pending' | 'running' | 'complete' | 'failed';
  rowCount: number | null;
  error: string | null;
  /** Presigned download URL — present only when status === 'complete'. */
  downloadUrl: string | null;
}

/** A bulk action applied to the selection (POST /contacts/bulk). */
export type BulkAction =
  | { type: 'add_segment'; segmentId: string }
  | { type: 'remove_segment'; segmentId: string }
  | { type: 'set_custom_field'; key: string; value: unknown }
  | { type: 'unsubscribe' }
  | { type: 'delete' };

// ============================================
// Core fetch wrapper
// ============================================

async function apiFetch<T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  retries = 2,
): Promise<T> {
  if (!config.apiUrl) {
    throw { status: 0, message: 'API not configured. Set NEXT_PUBLIC_API_URL in .env.local.' } as ApiError;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  // Attach auth token
  let hadToken = false;
  if (getAuthToken) {
    const token = await getAuthToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
      hadToken = true;
    }
  }

  // Attach workspace isolation header
  // API Gateway Request Authorizer requires X-Workspace-Id as an Identity Source to cache properly.
  // If we don't have a workspace yet, or we're in offline mode ('ws_acme'), send the global UUID.
  if (currentWorkspaceId && currentWorkspaceId !== 'ws_acme') {
    headers['X-Workspace-Id'] = currentWorkspaceId;
  } else {
    headers['X-Workspace-Id'] = '00000000-0000-0000-0000-000000000000';
  }

  const url = `${config.apiUrl}${path}`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });

      // Handle auth failures — only redirect to login if we actually had a token
      // (expired session). If no token was present, just throw — the user is
      // on the login page or unauthenticated.
      if (res.status === 401) {
        if (hadToken && onAuthExpired) {
          onAuthExpired();
        }
        throw { status: 401, message: 'Session expired. Please sign in again.' } as ApiError;
      }

      if (res.status === 403) {
        throw { status: 403, message: 'Access denied to this workspace.' } as ApiError;
      }

      // Handle client errors (4xx) — no retry
      if (res.status >= 400 && res.status < 500) {
        const errorBody = await res.json().catch(() => ({}));
        throw {
          status: res.status,
          message: errorBody.message || `Request failed with status ${res.status}`,
          code: errorBody.code,
          fieldErrors: errorBody.fieldErrors,
          missingRequired: errorBody.missingRequired,
          fields: errorBody.fields,
        } as ApiError;
      }

      // Handle server errors (5xx) — retry with backoff for idempotent methods only
      // NEVER auto-retry POST — it can cause duplicate campaign sends, double charges, etc.
      if (res.status >= 500) {
        const isIdempotent = ['GET', 'PUT', 'DELETE'].includes(method);
        if (isIdempotent && attempt < retries) {
          await delay(Math.pow(2, attempt) * 500);
          continue;
        }
        throw { status: res.status, message: 'Server error. Please try again.' } as ApiError;
      }

      // 204 No Content
      if (res.status === 204) {
        return undefined as T;
      }

      return await res.json() as T;
    } catch (err) {
      // Rethrow ApiErrors
      if ((err as ApiError).status !== undefined) throw err;

      // Network errors — retry
      if (attempt < retries) {
        await delay(Math.pow(2, attempt) * 500);
        continue;
      }

      throw { status: 0, message: 'Network error. Check your connection.' } as ApiError;
    }
  }

  throw { status: 0, message: 'Request failed after retries.' } as ApiError;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================
// Public API methods
// ============================================

export const apiClient = {
  get: <T>(path: string) => apiFetch<T>('GET', path),
  post: <T>(path: string, body?: unknown) => apiFetch<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => apiFetch<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => apiFetch<T>('PATCH', path, body),
  delete: <T = void>(path: string, body?: unknown) => apiFetch<T>('DELETE', path, body),
};

// ============================================
// Endpoint helpers — typed API calls
// ============================================

// These will be populated as backend endpoints are built.
// Each maps to a specific API Gateway route.

export const api = {
  // Health check
  health: () => apiClient.get<{ status: string }>('/health'),

  // Workspaces
  workspaces: {
    list: () => apiClient.get<ApiResponse<{ workspaceId: string; name: string; createdAt: string }[]>>('/workspaces'),
    create: (name: string) => apiClient.post<{ workspaceId: string; name: string }>('/workspaces', { name }),
    update: (id: string, name: string) => apiClient.put(`/workspaces/${id}`, { name }),
    delete: (id: string) => apiClient.delete(`/workspaces/${id}`),
  },

  // Contacts
  contacts: {
    list: (params?: { pageSize?: number; cursor?: string; search?: string; status?: string; segmentId?: string }) =>
      apiClient.get<ApiResponse<unknown[]>>(`/contacts${toQuery(params)}`),
    get: (id: string) => apiClient.get<unknown>(`/contacts/${id}`),
    /** Unified, paginated per-contact activity history (campaign sends, consent, inbound) */
    timeline: (id: string, params?: { cursor?: string | null; pageSize?: number }) =>
      apiClient.get<ApiResponse<unknown[]>>(`/contacts/${id}/timeline${toQuery(params)}`),
    /** Real per-channel consent state + evidence ledger (TCPA audit trail) */
    consent: (id: string) => apiClient.get<unknown>(`/contacts/${id}/consent`),
    create: (data: unknown) => apiClient.post<unknown>('/contacts', data),
    update: (id: string, data: unknown) => apiClient.put<unknown>(`/contacts/${id}`, data),
    delete: (id: string) => apiClient.delete(`/contacts/${id}`),
    bulkDelete: (ids: string[]) => apiClient.delete<{ deleted: number }>('/contacts', { ids }),
    import: (contacts: unknown[], segmentId?: string) => apiClient.post<{ added: number; updated: number; skipped: number }>('/contacts/import', { contacts, segmentId }),
    getImportUrl: (segmentId?: string) => apiClient.get<{ url: string; key: string }>(`/contacts/import-url${segmentId ? `?segmentId=${segmentId}` : ''}`),
    /** Server-side rule filtering — rules is a { combinator, conditions } tree */
    search: (body: { rules?: unknown; cursor?: string | null; pageSize?: number }) =>
      apiClient.post<ApiResponse<unknown[]>>('/contacts/search', body),
    /** Clusters of 2+ contacts sharing a normalized email/phone. */
    duplicates: (params?: { limit?: number }) =>
      apiClient.get<ApiResponse<DuplicateCluster[]>>(`/contacts/duplicates${toQuery(params)}`),
    /** Fold duplicates into a survivor (admin only). Survivor wins non-empty fields. */
    merge: (body: { survivorId: string; duplicateIds: string[] }) =>
      apiClient.post<MergeResult>('/contacts/merge', body),
    /** Selection-aware bulk action (editor; admin for delete). */
    bulk: (body: { selection: BulkSelection; action: BulkAction }) =>
      apiClient.post<{ affected: number }>('/contacts/bulk', body),
    /** Start an async CSV export of a selection. Returns 202 { jobId, status }. */
    export: (body: { selection: ExportSelection; columns?: string[] }) =>
      apiClient.post<{ jobId: string; status: ExportJobStatus['status'] }>('/contacts/export', body),
    /** Poll an export job's status + presigned download URL. */
    exportStatus: (jobId: string) =>
      apiClient.get<ExportJobStatus>(`/contacts/export/${jobId}`),
  },

  // Saved views — server-synced per-user + shared workspace views
  views: {
    list: () => apiClient.get<ApiResponse<SavedView[]>>('/views'),
    create: (body: { name: string; definition: unknown; shared?: boolean }) =>
      apiClient.post<SavedView>('/views', body),
    update: (id: string, body: { name?: string; definition?: unknown; shared?: boolean }) =>
      apiClient.put<SavedView>(`/views/${id}`, body),
    remove: (id: string) => apiClient.delete(`/views/${id}`),
  },

  // Custom field definitions
  customFields: {
    list: () => apiClient.get<ApiResponse<unknown[]>>('/custom-fields'),
    create: (data: unknown) => apiClient.post<unknown>('/custom-fields', data),
    update: (id: string, data: unknown) => apiClient.put<unknown>(`/custom-fields/${id}`, data),
    /** DELETE archives — definitions are never destroyed */
    archive: (id: string) => apiClient.delete<{ archived: boolean; fieldId: string }>(`/custom-fields/${id}`),
  },

  // Segments
  segments: {
    list: () => apiClient.get<ApiResponse<unknown[]>>('/segments'),
    /** Create a static or dynamic segment. Dynamic requires `rules`. */
    create: (body: {
      name: string;
      description?: string;
      color?: string | null;
      folder_id?: string | null;
      kind?: 'static' | 'dynamic';
      rules?: unknown;
    }) => apiClient.post<unknown>('/segments', body),
    /** Update name/description/color/sort and (dynamic only) rules. */
    update: (id: string, body: {
      name?: string;
      description?: string;
      color?: string | null;
      sort_order?: number;
      rules?: unknown;
    }) => apiClient.put<{ message: string } | Record<string, unknown>>(`/segments/${id}`, body),
    delete: (id: string) => apiClient.delete(`/segments/${id}`),
    addContacts: (id: string, contactIds: string[]) => apiClient.post(`/segments/${id}/contacts`, { contactIds }),
    removeContacts: (id: string, contactIds: string[]) => apiClient.delete(`/segments/${id}/contacts`, { contactIds }),
    /** Paginated membership preview — works for both static and dynamic segments. */
    listContacts: (id: string, params?: { cursor?: string | null; pageSize?: number }) =>
      apiClient.get<ApiResponse<unknown[]>>(`/segments/${id}/contacts${toQuery(params)}`),
    /** Live count for an unsaved rule tree. Throws ApiError (400) on invalid rules. */
    previewCount: (rules: unknown) => apiClient.post<{ total: number }>('/segments/preview-count', { rules }),
  },

  // Campaigns
  campaigns: {
    list: () => apiClient.get<ApiResponse<unknown[]>>('/campaigns'),
    get: (id: string) => apiClient.get<unknown>(`/campaigns/${id}`),
    create: (data: unknown) => apiClient.post<unknown>('/campaigns', data),
    update: (id: string, data: unknown) => apiClient.put<unknown>(`/campaigns/${id}`, data),
    delete: (id: string) => apiClient.delete(`/campaigns/${id}`),
  },

  // Templates
  templates: {
    email: {
      list: () => apiClient.get<ApiResponse<unknown[]>>('/templates/email'),
      get: (id: string) => apiClient.get<unknown>(`/templates/email/${id}`),
      create: (data: unknown) => apiClient.post<unknown>('/templates/email', data),
      update: (id: string, data: unknown) => apiClient.put<unknown>(`/templates/email/${id}`, data),
      delete: (id: string) => apiClient.delete(`/templates/email/${id}`),
    },
    sms: {
      list: () => apiClient.get<ApiResponse<unknown[]>>('/templates/sms'),
      create: (data: unknown) => apiClient.post<unknown>('/templates/sms', data),
      update: (id: string, data: unknown) => apiClient.put<unknown>(`/templates/sms/${id}`, data),
      delete: (id: string) => apiClient.delete(`/templates/sms/${id}`),
    },
    voice: {
      list: () => apiClient.get<ApiResponse<unknown[]>>('/templates/voice'),
      create: (data: unknown) => apiClient.post<unknown>('/templates/voice', data),
      update: (id: string, data: unknown) => apiClient.put<unknown>(`/templates/voice/${id}`, data),
      delete: (id: string) => apiClient.delete(`/templates/voice/${id}`),
    },
    webform: {
      list: () => apiClient.get<ApiResponse<unknown[]>>('/templates/webform'),
      create: (data: unknown) => apiClient.post<unknown>('/templates/webform', data),
      update: (id: string, data: unknown) => apiClient.put<unknown>(`/templates/webform/${id}`, data),
      delete: (id: string) => apiClient.delete(`/templates/webform/${id}`),
    },
  },

  // Inbox
  inbox: {
    sms: () => apiClient.get<ApiResponse<unknown[]>>('/inbox/sms'),
    email: () => apiClient.get<ApiResponse<unknown[]>>('/inbox/email'),
    forms: () => apiClient.get<ApiResponse<unknown[]>>('/inbox/forms'),
    markRead: (id: string) => apiClient.patch(`/inbox/${id}/read`),
  },

  // Settings
  settings: {
    get: () => apiClient.get<unknown>('/settings'),
    update: (data: unknown) => apiClient.put<unknown>('/settings', data),
  },

  // Analytics
  analytics: {
    overview: (params?: { from?: string; to?: string }) =>
      apiClient.get<unknown>(`/analytics/overview${toQuery(params)}`),
    campaigns: (params?: { from?: string; to?: string }) =>
      apiClient.get<ApiResponse<unknown[]>>(`/analytics/campaigns${toQuery(params)}`),
  },

  // Batch — single call for all workspace data
  batch: {
    load: () => apiClient.get<unknown>('/batch'),
  },
};

// ============================================
// Helpers
// ============================================

function toQuery(params?: Record<string, unknown>): string {
  if (!params) return '';
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (entries.length === 0) return '';
  return '?' + entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
}
