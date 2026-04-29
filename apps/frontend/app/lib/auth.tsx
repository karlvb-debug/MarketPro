'use client';

// ============================================
// Auth Provider — Cognito Integration
// Wraps amazon-cognito-identity-js for login, signup, signout, token refresh
// ============================================

import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from 'react';
import {
  CognitoUserPool,
  CognitoUser,
  AuthenticationDetails,
  CognitoUserSession,
  CognitoUserAttribute,
} from 'amazon-cognito-identity-js';
import { config } from './config';
import { setAuthTokenGetter, setAuthExpiredHandler } from './api-client';

// ============================================
// Types
// ============================================

export interface AuthUser {
  userId: string;        // Cognito sub
  email: string;
  name?: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  error: string | null;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, name?: string) => Promise<{ needsConfirmation: boolean }>;
  confirmSignUp: (email: string, code: string) => Promise<void>;
  signOut: () => void;
  getToken: () => Promise<string | null>;
}

// ============================================
// Cognito Pool
// ============================================

function getUserPool(): CognitoUserPool | null {
  if (!config.cognitoUserPoolId || !config.cognitoClientId) return null;
  return new CognitoUserPool({
    UserPoolId: config.cognitoUserPoolId,
    ClientId: config.cognitoClientId,
  });
}

// ============================================
// Context
// ============================================

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const pool = useMemo(() => getUserPool(), []);
  const poolRef = useRef(pool);
  poolRef.current = pool;

  // Get current valid token
  const getToken = useCallback(async (): Promise<string | null> => {
    if (!pool) return null;
    const cognitoUser = pool.getCurrentUser();
    if (!cognitoUser) return null;

    return new Promise((resolve) => {
      cognitoUser.getSession((err: Error | null, session: CognitoUserSession | null) => {
        if (err || !session) {
          resolve(null);
          return;
        }

        if (session.isValid()) {
          resolve(session.getIdToken().getJwtToken());
        } else {
          // Try refresh
          const refreshToken = session.getRefreshToken();
          cognitoUser.refreshSession(refreshToken, (refreshErr: Error | null, newSession: CognitoUserSession | null) => {
            if (refreshErr || !newSession) {
              resolve(null);
            } else {
              resolve(newSession.getIdToken().getJwtToken());
            }
          });
        }
      });
    });
  }, [pool]);

  // Wire up token getter for api-client
  useEffect(() => {
    setAuthTokenGetter(getToken);
    setAuthExpiredHandler(() => {
      // Clear local state and redirect to login
      if (pool) {
        const cognitoUser = pool.getCurrentUser();
        if (cognitoUser) cognitoUser.signOut();
      }
      setUser(null);
      if (typeof window !== 'undefined') {
        window.location.href = '/login';
      }
    });
  }, [getToken, pool]);

  // Check for existing session on mount
  useEffect(() => {
    if (!pool) {
      setLoading(false);
      return;
    }

    const cognitoUser = pool.getCurrentUser();
    if (!cognitoUser) {
      setLoading(false);
      return;
    }

    cognitoUser.getSession((err: Error | null, session: CognitoUserSession | null) => {
      if (err || !session || !session.isValid()) {
        setLoading(false);
        return;
      }

      // Extract user info from token
      const payload = session.getIdToken().decodePayload();
      setUser({
        userId: payload.sub,
        email: payload.email || '',
        name: payload.name || payload.email?.split('@')[0] || '',
      });
      setLoading(false);
    });
  }, [pool]);

  // Sign In
  const signIn = useCallback(async (email: string, password: string) => {
    if (!pool) throw new Error('Auth not configured');

    setError(null);
    setLoading(true);

    const cognitoUser = new CognitoUser({ Username: email, Pool: pool });
    const authDetails = new AuthenticationDetails({ Username: email, Password: password });

    return new Promise<void>((resolve, reject) => {
      cognitoUser.authenticateUser(authDetails, {
        onSuccess: (session: CognitoUserSession) => {
          const payload = session.getIdToken().decodePayload();
          setUser({
            userId: payload.sub,
            email: payload.email || email,
            name: payload.name || payload.email?.split('@')[0] || '',
          });
          setLoading(false);
          resolve();
        },
        onFailure: (err: Error) => {
          const msg = err.message || 'Authentication failed';
          setError(msg);
          setLoading(false);
          reject(new Error(msg));
        },
        newPasswordRequired: () => {
          setError('Password change required. Please contact support.');
          setLoading(false);
          reject(new Error('Password change required'));
        },
      });
    });
  }, [pool]);

  // Sign Up
  const signUp = useCallback(async (email: string, password: string, name?: string): Promise<{ needsConfirmation: boolean }> => {
    if (!pool) throw new Error('Auth not configured');

    setError(null);

    const attributes: CognitoUserAttribute[] = [
      new CognitoUserAttribute({ Name: 'email', Value: email }),
    ];
    if (name) {
      attributes.push(new CognitoUserAttribute({ Name: 'name', Value: name }));
    }

    return new Promise((resolve, reject) => {
      pool.signUp(email, password, attributes, [], (err, result) => {
        if (err) {
          setError(err.message);
          reject(err);
          return;
        }
        resolve({
          needsConfirmation: !result?.userConfirmed,
        });
      });
    });
  }, [pool]);

  // Confirm Sign Up
  const confirmSignUp = useCallback(async (email: string, code: string) => {
    if (!pool) throw new Error('Auth not configured');

    const cognitoUser = new CognitoUser({ Username: email, Pool: pool });

    return new Promise<void>((resolve, reject) => {
      cognitoUser.confirmRegistration(code, true, (err) => {
        if (err) {
          setError(err.message);
          reject(err);
          return;
        }
        resolve();
      });
    });
  }, [pool]);

  // Sign Out
  const signOut = useCallback(() => {
    if (!pool) return;
    const cognitoUser = pool.getCurrentUser();
    if (cognitoUser) {
      cognitoUser.signOut();
    }
    setUser(null);
  }, [pool]);

  return (
    <AuthContext.Provider value={{ user, loading, error, signIn, signUp, confirmSignUp, signOut, getToken }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
