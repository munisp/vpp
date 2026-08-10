/**
 * Keycloak Authentication Bridge
 * 
 * Integrates VPP Platform with Keycloak for enterprise SSO and RBAC
 */

import axios, { AxiosInstance } from 'axios';

export interface KeycloakConfig {
  serverUrl: string;
  realm: string;
  clientId: string;
  clientSecret: string;
}

export interface KeycloakUser {
  id: string;
  username: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  enabled: boolean;
  emailVerified: boolean;
  attributes?: Record<string, string[]>;
  roles?: string[];
}

export interface KeycloakToken {
  access_token: string;
  expires_in: number;
  refresh_expires_in: number;
  refresh_token: string;
  token_type: string;
  session_state?: string;
  scope?: string;
}

export class KeycloakClient {
  private config: KeycloakConfig;
  private client: AxiosInstance;
  private adminToken: string | null = null;
  private tokenExpiry: number = 0;

  constructor(config?: KeycloakConfig) {
    this.config = config || {
      serverUrl: process.env.KEYCLOAK_SERVER_URL || 'http://localhost:8080',
      realm: process.env.KEYCLOAK_REALM || 'vpp-platform',
      clientId: process.env.KEYCLOAK_CLIENT_ID || 'vpp-consumer-platform',
      clientSecret: process.env.KEYCLOAK_CLIENT_SECRET || '',
    };

    this.client = axios.create({
      baseURL: this.config.serverUrl,
      timeout: 10000,
    });
  }

  /**
   * Get admin access token
   */
  private async getAdminToken(): Promise<string> {
    // Return cached token if still valid
    if (this.adminToken && Date.now() < this.tokenExpiry) {
      return this.adminToken;
    }

    try {
      const response = await this.client.post(
        `/realms/${this.config.realm}/protocol/openid-connect/token`,
        new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
        }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );

      const token: KeycloakToken = response.data;
      this.adminToken = token.access_token;
      this.tokenExpiry = Date.now() + (token.expires_in - 60) * 1000; // Refresh 1 min before expiry

      console.log('[Keycloak] Admin token obtained');
      return this.adminToken;
    } catch (error) {
      console.error('[Keycloak] Failed to get admin token:', error);
      throw error;
    }
  }

  /**
   * Authenticate user with username and password
   */
  async authenticateUser(username: string, password: string): Promise<KeycloakToken> {
    try {
      const response = await this.client.post(
        `/realms/${this.config.realm}/protocol/openid-connect/token`,
        new URLSearchParams({
          grant_type: 'password',
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          username,
          password,
        }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );

      console.log(`[Keycloak] User authenticated: ${username}`);
      return response.data;
    } catch (error) {
      console.error('[Keycloak] Authentication failed:', error);
      throw error;
    }
  }

  /**
   * Refresh access token
   */
  async refreshToken(refreshToken: string): Promise<KeycloakToken> {
    try {
      const response = await this.client.post(
        `/realms/${this.config.realm}/protocol/openid-connect/token`,
        new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          refresh_token: refreshToken,
        }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );

      console.log('[Keycloak] Token refreshed');
      return response.data;
    } catch (error) {
      console.error('[Keycloak] Token refresh failed:', error);
      throw error;
    }
  }

  /**
   * Validate access token
   */
  async validateToken(token: string): Promise<boolean> {
    try {
      const response = await this.client.post(
        `/realms/${this.config.realm}/protocol/openid-connect/token/introspect`,
        new URLSearchParams({
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          token,
        }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );

      return response.data.active === true;
    } catch (error) {
      console.error('[Keycloak] Token validation failed:', error);
      return false;
    }
  }

  /**
   * Get user info from token
   */
  async getUserInfo(token: string): Promise<any> {
    try {
      const response = await this.client.get(
        `/realms/${this.config.realm}/protocol/openid-connect/userinfo`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      return response.data;
    } catch (error) {
      console.error('[Keycloak] Failed to get user info:', error);
      throw error;
    }
  }

  /**
   * Create user
   */
  async createUser(user: {
    username: string;
    email: string;
    firstName?: string;
    lastName?: string;
    enabled?: boolean;
    emailVerified?: boolean;
    attributes?: Record<string, string[]>;
  }): Promise<string> {
    const token = await this.getAdminToken();

    try {
      const response = await this.client.post(
        `/admin/realms/${this.config.realm}/users`,
        {
          username: user.username,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          enabled: user.enabled !== false,
          emailVerified: user.emailVerified || false,
          attributes: user.attributes,
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        }
      );

      // Extract user ID from Location header
      const location = response.headers.location;
      const userId = location?.split('/').pop() || '';

      console.log(`[Keycloak] User created: ${user.username} (${userId})`);
      return userId;
    } catch (error) {
      console.error('[Keycloak] Failed to create user:', error);
      throw error;
    }
  }

  /**
   * Get user by ID
   */
  async getUser(userId: string): Promise<KeycloakUser> {
    const token = await this.getAdminToken();

    try {
      const response = await this.client.get(
        `/admin/realms/${this.config.realm}/users/${userId}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      return response.data;
    } catch (error) {
      console.error(`[Keycloak] Failed to get user ${userId}:`, error);
      throw error;
    }
  }

  /**
   * Update user
   */
  async updateUser(
    userId: string,
    updates: Partial<{
      email: string;
      firstName: string;
      lastName: string;
      enabled: boolean;
      emailVerified: boolean;
      attributes: Record<string, string[]>;
    }>
  ): Promise<void> {
    const token = await this.getAdminToken();

    try {
      await this.client.put(
        `/admin/realms/${this.config.realm}/users/${userId}`,
        updates,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        }
      );

      console.log(`[Keycloak] User updated: ${userId}`);
    } catch (error) {
      console.error(`[Keycloak] Failed to update user ${userId}:`, error);
      throw error;
    }
  }

  /**
   * Delete user
   */
  async deleteUser(userId: string): Promise<void> {
    const token = await this.getAdminToken();

    try {
      await this.client.delete(
        `/admin/realms/${this.config.realm}/users/${userId}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      console.log(`[Keycloak] User deleted: ${userId}`);
    } catch (error) {
      console.error(`[Keycloak] Failed to delete user ${userId}:`, error);
      throw error;
    }
  }

  /**
   * Assign role to user
   */
  async assignRole(userId: string, roleName: string): Promise<void> {
    const token = await this.getAdminToken();

    try {
      // Get role
      const rolesResponse = await this.client.get(
        `/admin/realms/${this.config.realm}/roles/${roleName}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      const role = rolesResponse.data;

      // Assign role to user
      await this.client.post(
        `/admin/realms/${this.config.realm}/users/${userId}/role-mappings/realm`,
        [role],
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        }
      );

      console.log(`[Keycloak] Role ${roleName} assigned to user ${userId}`);
    } catch (error) {
      console.error(`[Keycloak] Failed to assign role ${roleName} to user ${userId}:`, error);
      throw error;
    }
  }

  /**
   * Get user roles
   */
  async getUserRoles(userId: string): Promise<string[]> {
    const token = await this.getAdminToken();

    try {
      const response = await this.client.get(
        `/admin/realms/${this.config.realm}/users/${userId}/role-mappings/realm`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      return response.data.map((role: any) => role.name);
    } catch (error) {
      console.error(`[Keycloak] Failed to get roles for user ${userId}:`, error);
      throw error;
    }
  }

  /**
   * Logout user
   */
  async logoutUser(refreshToken: string): Promise<void> {
    try {
      await this.client.post(
        `/realms/${this.config.realm}/protocol/openid-connect/logout`,
        new URLSearchParams({
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          refresh_token: refreshToken,
        }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );

      console.log('[Keycloak] User logged out');
    } catch (error) {
      console.error('[Keycloak] Logout failed:', error);
      throw error;
    }
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<{ connected: boolean; realm?: string }> {
    try {
      const response = await this.client.get(`/realms/${this.config.realm}`);
      return {
        connected: true,
        realm: response.data.realm,
      };
    } catch (error) {
      console.error('[Keycloak] Health check failed:', error);
      return { connected: false };
    }
  }
}

// Singleton instance
export const keycloakClient = new KeycloakClient();

// Export for testing with custom config
export default KeycloakClient;
