import React, { createContext, useContext, useState, useEffect } from 'react';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
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

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const discovery = {
    authorizationEndpoint: `${API_URL}/api/oauth/authorize`,
    tokenEndpoint: `${API_URL}/api/oauth/token`,
  };

  const [request, response, promptAsync] = AuthSession.useAuthRequest(
    {
      clientId: process.env.EXPO_PUBLIC_CLIENT_ID || 'vpp-mobile',
      scopes: ['openid', 'profile', 'email'],
      redirectUri: AuthSession.makeRedirectUri({
        scheme: 'vpp',
      }),
    },
    discovery
  );

  useEffect(() => {
    loadUser();
  }, []);

  useEffect(() => {
    if (response?.type === 'success') {
      const { code } = response.params;
      exchangeCodeForToken(code);
    }
  }, [response]);

  const loadUser = async () => {
    try {
      const token = await SecureStore.getItemAsync('auth_token');
      if (token) {
        // Fetch user data
        const res = await fetch(`${API_URL}/api/trpc/auth.me`, {
          headers: {
            'Cookie': `session=${token}`,
          },
        });
        const data = await res.json();
        if (data.result?.data) {
          setUser(data.result.data);
        }
      }
    } catch (error) {
      console.error('Failed to load user:', error);
    } finally {
      setLoading(false);
    }
  };

  const exchangeCodeForToken = async (code: string) => {
    try {
      const res = await fetch(`${API_URL}/api/oauth/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          code,
          redirect_uri: AuthSession.makeRedirectUri({ scheme: 'vpp' }),
        }),
      });

      const data = await res.json();
      if (data.access_token) {
        await SecureStore.setItemAsync('auth_token', data.access_token);
        await loadUser();
      }
    } catch (error) {
      console.error('Failed to exchange code:', error);
    }
  };

  const login = async () => {
    await promptAsync();
  };

  const logout = async () => {
    await SecureStore.deleteItemAsync('auth_token');
    setUser(null);
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
