import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { auth as authApi, TOKEN_KEY } from '../lib/api';
import type { AuthUser } from '../lib/api';

const USER_KEY = 'lpb_auth_user';

interface AuthContextType {
  token: string | null;
  user: AuthUser | null;
  username: string | null;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string, phone: string, fullName?: string) => Promise<{ activationRequired: boolean; email?: string }>;
  activate: (token: string) => Promise<void>;
  updateUser: (user: AuthUser) => void;
  logout: () => void;
  isAuthenticated: boolean;
}

const AuthContext = createContext<AuthContextType>({
  token: null,
  user: null,
  username: null,
  login: async () => {},
  signup: async () => ({ activationRequired: false }),
  activate: async () => {},
  updateUser: () => {},
  logout: () => {},
  isAuthenticated: false,
});

function loadUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as AuthUser) : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));
  const [user, setUser] = useState<AuthUser | null>(loadUser);

  // Refresh the user from the server on load, so fields like is_admin (or a
  // changed email) reflect without requiring a re-login. request() handles 401.
  useEffect(() => {
    if (!token) return;
    authApi.me()
      .then(res => { localStorage.setItem(USER_KEY, JSON.stringify(res.user)); setUser(res.user); })
      .catch(() => { /* ignore transient errors; 401 is handled in request() */ });
  }, [token]);

  const persist = (newToken: string, newUser: AuthUser) => {
    localStorage.setItem(TOKEN_KEY, newToken);
    localStorage.setItem(USER_KEY, JSON.stringify(newUser));
    setToken(newToken);
    setUser(newUser);
  };

  const login = async (email: string, password: string) => {
    const res = await authApi.login({ email, password });
    persist(res.token, res.user);
  };

  const signup = async (email: string, password: string, phone: string, fullName?: string) => {
    const res = await authApi.signup({ email, password, phone, full_name: fullName });
    if ('token' in res) {
      persist(res.token, res.user);
      return { activationRequired: false };
    }
    // Email verification is on: account created, awaiting activation.
    return { activationRequired: true, email: res.email };
  };

  const activate = async (token: string) => {
    const res = await authApi.activate(token);
    persist(res.token, res.user);
  };

  const updateUser = (next: AuthUser) => {
    localStorage.setItem(USER_KEY, JSON.stringify(next));
    setUser(next);
  };

  const logout = () => {
    // Best-effort server-side token revocation; clear locally regardless.
    authApi.logout().catch(() => {});
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    setToken(null);
    setUser(null);
  };

  const username = user ? (user.full_name || user.email) : null;

  return (
    <AuthContext.Provider value={{ token, user, username, login, signup, activate, updateUser, logout, isAuthenticated: !!token }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
