import React, { createContext, useContext, useState, useEffect } from 'react';
import * as SecureStore from 'expo-secure-store';
import * as AuthSession from 'expo-auth-session';

interface User {
  id: number;
  name: string;
  email: string;
  role: 'user' | 'admin';
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  isAuthenticated: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3000';

// The server authenticates requests via a session cookie (see
// server/_core/sdk.ts -> authenticateRequest). There is no Bearer-token
// support server-side, so mobile stores the session token issued by the
// OAuth callback and sends it as this cookie on every request.
const SESSION_COOKIE_NAME = 'app_session_id';
const TOKEN_STORAGE_KEY = 'auth_token';

// The server-side OAuth authorization endpoint. The app server only exposes
// /api/oauth/callback (which exchanges the code and issues the session
// cookie); the authorization page itself is hosted by the OAuth portal.
// Configure it via EXPO_PUBLIC_OAUTH_AUTHORIZE_URL.
const AUTHORIZE_URL =
  process.env.EXPO_PUBLIC_OAUTH_AUTHORIZE_URL || `${API_URL}/api/oauth/authorize`;

// Minimal base64 encoder (Hermes does not guarantee btoa). The server's
// OAuth callback decodes `state` with atob() and expects it to contain the
// redirect URI.
const BASE64_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function base64Encode(input: string): string {
  let output = '';
  let i = 0;
  const bytes: number[] = [];
  for (let j = 0; j < input.length; j++) {
    const code = input.charCodeAt(j);
    if (code > 255) {
      throw new Error('base64Encode only supports latin1 input');
    }
    bytes.push(code);
  }
  while (i < bytes.length) {
    const b1 = bytes[i++];
    const b2 = i < bytes.length ? bytes[i++] : NaN;
    const b3 = i < bytes.length ? bytes[i++] : NaN;
    output +=
      BASE64_CHARS[b1 >> 2] +
      BASE64_CHARS[(b1 & 3) << 4 | (isNaN(b2) ? 0 : b2 >> 4)] +
      (isNaN(b2) ? '=' : BASE64_CHARS[(b2 & 15) << 2 | (isNaN(b3) ? 0 : b3 >> 6)]) +
      (isNaN(b3) ? '=' : BASE64_CHARS[b3 & 63]);
  }
  return output;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const redirectUri = AuthSession.makeRedirectUri({ scheme: 'vpp' });
  // The server's /api/oauth/callback expects state = base64(redirectUri).
  const oauthState = base64Encode(redirectUri);

  const discovery = {
    authorizationEndpoint: AUTHORIZE_URL,
    // NOTE: the app server has no token endpoint; the code is exchanged by
    // calling /api/oauth/callback directly (see exchangeCodeForSession).
    tokenEndpoint: `${API_URL}/api/oauth/token`,
  };

  const [request, response, promptAsync] = AuthSession.useAuthRequest(
    {
      clientId: process.env.EXPO_PUBLIC_CLIENT_ID || 'vpp-mobile',
      scopes: ['openid', 'profile', 'email'],
      redirectUri,
      state: oauthState,
    },
    discovery
  );

  useEffect(() => {
    loadUser();
  }, []);

  useEffect(() => {
    if (response?.type === 'success') {
      const { code, state } = response.params;
      exchangeCodeForSession(code, state);
    }
  }, [response]);

  const loadUser = async () => {
    try {
      const token = await SecureStore.getItemAsync(TOKEN_STORAGE_KEY);
      if (token) {
        // Fetch user data using the session cookie scheme the server expects.
        const res = await fetch(`${API_URL}/api/trpc/auth.me`, {
          headers: {
            Cookie: `${SESSION_COOKIE_NAME}=${token}`,
          },
        });
        const data = await res.json();
        if (data.result?.data) {
          setUser(data.result.data);
        } else {
          // Session is invalid or expired; drop the stale token.
          await SecureStore.deleteItemAsync(TOKEN_STORAGE_KEY);
          setUser(null);
        }
      }
    } catch (error) {
      console.error('Failed to load user:', error);
    } finally {
      setLoading(false);
    }
  };

  const exchangeCodeForSession = async (code: string, state?: string) => {
    try {
      // The app server exposes /api/oauth/callback (GET) which exchanges the
      // authorization code, upserts the user and sets the app_session_id
      // session cookie. There is no JSON token endpoint.
      const params = new URLSearchParams({
        code,
        state: state || oauthState,
      });
      const res = await fetch(
        `${API_URL}/api/oauth/callback?${params.toString()}`,
        { redirect: 'manual' }
      );

      // Extract the session cookie from the Set-Cookie response header.
      const setCookie =
        res.headers.get('set-cookie') || res.headers.get('Set-Cookie');
      const match = setCookie?.match(
        new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`)
      );
      const sessionToken = match?.[1];

      if (sessionToken) {
        await SecureStore.setItemAsync(TOKEN_STORAGE_KEY, sessionToken);
        await loadUser();
      } else {
        console.error(
          'OAuth callback did not return a session cookie; sign-in failed.'
        );
      }
    } catch (error) {
      console.error('Failed to exchange code for session:', error);
    }
  };

  const login = async () => {
    await promptAsync();
  };

  const logout = async () => {
    try {
      const token = await SecureStore.getItemAsync(TOKEN_STORAGE_KEY);
      if (token) {
        // Best-effort server-side logout (clears the session cookie).
        await fetch(`${API_URL}/api/trpc/auth.logout`, {
          method: 'POST',
          headers: {
            Cookie: `${SESSION_COOKIE_NAME}=${token}`,
            'Content-Type': 'application/json',
          },
          body: '{}',
        });
      }
    } catch (error) {
      console.error('Server logout failed:', error);
    } finally {
      await SecureStore.deleteItemAsync(TOKEN_STORAGE_KEY);
      setUser(null);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        login,
        logout,
        isAuthenticated: !!user,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}
