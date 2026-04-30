'use client';

import { useState, useEffect, useCallback, createContext, useContext } from 'react';
import { config } from './config';
import { api, setActiveWorkspaceId } from './api-client';
import { useAuth } from './auth';

// ============================================
// Types
// ============================================

export interface Workspace {
  workspaceId: string;
  name: string;
  slug: string;
  createdAt: string;
}

interface WorkspaceState {
  workspaces: Workspace[];
  activeWorkspaceId: string;
}

// ============================================
// localStorage keys
// ============================================

const WS_META_KEY = 'marketpro_workspaces';

function getDataKey(workspaceId: string) {
  return `marketpro_data_${workspaceId}`;
}

// ============================================
// Default workspaces
// ============================================

const DEFAULT_WORKSPACE: Workspace = {
  workspaceId: 'ws_acme',
  name: 'Acme Corp',
  slug: 'acme-corp',
  createdAt: new Date().toISOString(),
};

function loadWorkspaceState(): WorkspaceState {
  if (typeof window === 'undefined') {
    return { workspaces: [DEFAULT_WORKSPACE], activeWorkspaceId: DEFAULT_WORKSPACE.workspaceId };
  }
  try {
    const raw = localStorage.getItem(WS_META_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }

  const initial: WorkspaceState = {
    workspaces: [DEFAULT_WORKSPACE],
    activeWorkspaceId: DEFAULT_WORKSPACE.workspaceId,
  };
  localStorage.setItem(WS_META_KEY, JSON.stringify(initial));
  return initial;
}

function saveWorkspaceState(state: WorkspaceState) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(WS_META_KEY, JSON.stringify(state));
}

// ============================================
// Context + Hook
// ============================================

interface WorkspaceContextValue {
  workspaces: Workspace[];
  activeWorkspace: Workspace;
  switchWorkspace: (workspaceId: string) => void;
  createWorkspace: (name: string) => void;
  renameWorkspace: (workspaceId: string, newName: string) => void;
  deleteWorkspace: (workspaceId: string) => void;
  hydrated: boolean;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [state, setState] = useState<WorkspaceState>({
    workspaces: [DEFAULT_WORKSPACE],
    activeWorkspaceId: DEFAULT_WORKSPACE.workspaceId,
  });
  const [hydrated, setHydrated] = useState(false);
  const useApiMode = config.isApiConfigured;

  // Load workspaces on mount or when user changes
  useEffect(() => {
    if (useApiMode && user) {
      api.workspaces.list()
        .then((res) => {
          const apiWorkspaces = ((res as any)?.data || []).map((w: any) => ({
            workspaceId: w.workspaceId || w.workspace_id,
            name: w.name,
            slug: w.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
            createdAt: w.createdAt || w.created_at || new Date().toISOString(),
          }));

          if (apiWorkspaces.length > 0) {
            const activeId = apiWorkspaces[0].workspaceId;
            setState({ workspaces: apiWorkspaces, activeWorkspaceId: activeId });
            setActiveWorkspaceId(activeId);
          } else {
            setState(loadWorkspaceState());
          }
          setHydrated(true);
        })
        .catch(() => {
          setState(loadWorkspaceState());
          setHydrated(true);
        });
    } else if (!useApiMode || !user) {
      // If no API mode, or no user is logged in, fall back to offline/local state
      setState(loadWorkspaceState());
      setHydrated(true);
    }
  }, [useApiMode, user]);

  useEffect(() => {
    if (hydrated && !useApiMode) saveWorkspaceState(state);
  }, [state, hydrated, useApiMode]);

  useEffect(() => {
    if (state.activeWorkspaceId) {
      setActiveWorkspaceId(state.activeWorkspaceId);
    }
  }, [state.activeWorkspaceId]);

  const activeWorkspace = state.workspaces.find((w) => w.workspaceId === state.activeWorkspaceId) || state.workspaces[0]!;

  const switchWorkspace = useCallback((workspaceId: string) => {
    setState((prev) => ({ ...prev, activeWorkspaceId: workspaceId }));
  }, []);

  const createWorkspace = useCallback((name: string) => {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const newWs: Workspace = {
      workspaceId: `ws_${crypto.randomUUID().slice(0, 8)}`,
      name,
      slug,
      createdAt: new Date().toISOString(),
    };
    setState((prev) => ({
      workspaces: [...prev.workspaces, newWs],
      activeWorkspaceId: newWs.workspaceId,
    }));
    if (useApiMode) {
      api.workspaces.create(name).then((res: any) => {
        if (res?.workspaceId) {
          setState((prev) => ({
            ...prev,
            workspaces: prev.workspaces.map((w) =>
              w.workspaceId === newWs.workspaceId ? { ...w, workspaceId: res.workspaceId } : w
            ),
            activeWorkspaceId: res.workspaceId,
          }));
        }
      }).catch(console.error);
    }
  }, [useApiMode]);

  const renameWorkspace = useCallback((workspaceId: string, newName: string) => {
    setState((prev) => ({
      ...prev,
      workspaces: prev.workspaces.map((w) =>
        w.workspaceId === workspaceId ? { ...w, name: newName } : w
      ),
    }));
    if (useApiMode) {
      api.workspaces.update(workspaceId, newName).catch(console.error);
    }
  }, [useApiMode]);

  const deleteWorkspace = useCallback((workspaceId: string) => {
    setState((prev) => {
      if (prev.workspaces.length <= 1) return prev;
      const filtered = prev.workspaces.filter((w) => w.workspaceId !== workspaceId);
      if (!useApiMode && typeof window !== 'undefined') {
        localStorage.removeItem(getDataKey(workspaceId));
      }
      return {
        workspaces: filtered,
        activeWorkspaceId: prev.activeWorkspaceId === workspaceId ? filtered[0]!.workspaceId : prev.activeWorkspaceId,
      };
    });
    if (useApiMode) {
      api.workspaces.delete(workspaceId).catch(console.error);
    }
  }, [useApiMode]);

  return (
    <WorkspaceContext.Provider value={{ workspaces: state.workspaces, activeWorkspace, switchWorkspace, createWorkspace, renameWorkspace, deleteWorkspace, hydrated }}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace must be used within WorkspaceProvider');
  return ctx;
}

export { getDataKey };
