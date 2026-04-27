// ============================================
// API Client — Centralized HTTP layer
// Auto-attaches auth token + workspace headers
// ============================================

import { config } from './config';

// Token getter — set by AuthProvider
let getAuthToken: (() => Promise<string | null>) | null = null;
let currentWorkspaceId: string | null = null;

/** Called by AuthProvider to wire up token resolution */
export function setAuthTokenGetter(getter: () => Promise<string | null>) {
  getAuthToken = getter;
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
}

export interface ApiResponse<T> {
  data: T;
  meta?: {
    total?: number;
    page?: number;
    pageSize?: number;
  };
}

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
  if (getAuthToken) {
    const token = await getAuthToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
  }

  // Attach workspace isolation header
  if (currentWorkspaceId) {
    headers['X-Workspace-Id'] = currentWorkspaceId;
  }

  const url = `${config.apiUrl}${path}`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });

      // Handle auth failures
      if (res.status === 401) {
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
        } as ApiError;
      }

      // Handle server errors (5xx) — retry with backoff
      if (res.status >= 500) {
        if (attempt < retries) {
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
  delete: <T = void>(path: string) => apiFetch<T>('DELETE', path),
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
    list: (params?: { page?: number; search?: string; status?: string }) =>
      apiClient.get<ApiResponse<unknown[]>>(`/contacts${toQuery(params)}`),
    get: (id: string) => apiClient.get<unknown>(`/contacts/${id}`),
    create: (data: unknown) => apiClient.post<unknown>('/contacts', data),
    update: (id: string, data: unknown) => apiClient.put<unknown>(`/contacts/${id}`, data),
    delete: (id: string) => apiClient.delete(`/contacts/${id}`),
    import: (contacts: unknown[]) => apiClient.post<{ added: number; updated: number; skipped: number }>('/contacts/import', { contacts }),
  },

  // Segments
  segments: {
    list: () => apiClient.get<ApiResponse<unknown[]>>('/segments'),
    create: (data: unknown) => apiClient.post<unknown>('/segments', data),
    update: (id: string, data: unknown) => apiClient.put<unknown>(`/segments/${id}`, data),
    delete: (id: string) => apiClient.delete(`/segments/${id}`),
    addContacts: (id: string, contactIds: string[]) => apiClient.post(`/segments/${id}/contacts`, { contactIds }),
    removeContacts: (id: string, contactIds: string[]) => apiClient.delete(`/segments/${id}/contacts`),
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
    customFields: {
      list: () => apiClient.get<ApiResponse<unknown[]>>('/settings/custom-fields'),
      create: (data: unknown) => apiClient.post<unknown>('/settings/custom-fields', data),
      update: (id: string, data: unknown) => apiClient.put<unknown>(`/settings/custom-fields/${id}`, data),
      delete: (id: string) => apiClient.delete(`/settings/custom-fields/${id}`),
    },
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
