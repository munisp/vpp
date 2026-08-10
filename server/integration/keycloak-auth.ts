import Keycloak from 'keycloak-connect';
import { redisCache } from './redis-cache';

export const keycloakConfig = {
  realm: process.env.KEYCLOAK_REALM || 'vpp',
  'auth-server-url': process.env.KEYCLOAK_URL || 'http://localhost:8080',
  resource: process.env.KEYCLOAK_CLIENT_ID || 'vpp-consumer-platform',
  credentials: {
    secret: process.env.KEYCLOAK_CLIENT_SECRET || ''
  },
  'ssl-required': process.env.KEYCLOAK_SSL_REQUIRED || 'external',
  'public-client': false,
  'confidential-port': 0
};

// Initialize Keycloak
export const keycloak = new Keycloak({}, keycloakConfig);

export interface KeycloakUser {
  sub: string;
  email?: string;
  name?: string;
  preferred_username?: string;
  given_name?: string;
  family_name?: string;
  roles?: string[];
}

export class KeycloakAuthBridge {
  private keycloak: any;

  constructor() {
    this.keycloak = keycloak;
  }

  // Verify access token
  async verifyToken(token: string): Promise<KeycloakUser | null> {
    try {
      // Check cache first
      const cacheKey = `keycloak:token:${token}`;
      const cached = await redisCache.get<KeycloakUser>(cacheKey);
      if (cached) {
        return cached;
      }

      // Verify with Keycloak
      const grant = await this.keycloak.grantManager.createGrant({
        access_token: token
      });

      if (!grant || !grant.access_token) {
        return null;
      }

      const accessToken = grant.access_token;
      const content = accessToken.content as any;

      const user: KeycloakUser = {
        sub: content.sub,
        email: content.email,
        name: content.name,
        preferred_username: content.preferred_username,
        given_name: content.given_name,
        family_name: content.family_name,
        roles: content.realm_access?.roles || []
      };

      // Cache for 5 minutes
      await redisCache.set(cacheKey, user, 300);

      return user;
    } catch (error) {
      console.error('[Keycloak] Error verifying token:', error);
      return null;
    }
  }

  // Get user info from token
  async getUserInfo(token: string): Promise<any> {
    try {
      const response = await fetch(
        `${keycloakConfig['auth-server-url']}/realms/${keycloakConfig.realm}/protocol/openid-connect/userinfo`,
        {
          headers: {
            Authorization: `Bearer ${token}`
          }
        }
      );

      if (!response.ok) {
        return null;
      }

      return await response.json();
    } catch (error) {
      console.error('[Keycloak] Error getting user info:', error);
      return null;
    }
  }

  // Check if user has role
  hasRole(user: KeycloakUser, role: string): boolean {
    return user.roles?.includes(role) || false;
  }

  // Check if user has any of the roles
  hasAnyRole(user: KeycloakUser, roles: string[]): boolean {
    return roles.some(role => this.hasRole(user, role));
  }

  // Check if user has all roles
  hasAllRoles(user: KeycloakUser, roles: string[]): boolean {
    return roles.every(role => this.hasRole(user, role));
  }

  // Exchange Manus OAuth token for Keycloak token (migration helper)
  async exchangeManusToken(manusToken: string): Promise<string | null> {
    try {
      // This would call Manus OAuth API to get user info
      // Then create or get Keycloak user
      // Then generate Keycloak token
      // This is a placeholder for the actual implementation
      
      console.log('[Keycloak] Token exchange not yet implemented');
      return null;
    } catch (error) {
      console.error('[Keycloak] Error exchanging Manus token:', error);
      return null;
    }
  }

  // Logout user
  async logout(token: string): Promise<boolean> {
    try {
      const response = await fetch(
        `${keycloakConfig['auth-server-url']}/realms/${keycloakConfig.realm}/protocol/openid-connect/logout`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Bearer ${token}`
          },
          body: new URLSearchParams({
            client_id: keycloakConfig.resource,
            client_secret: keycloakConfig.credentials.secret
          })
        }
      );

      // Invalidate cache
      const cacheKey = `keycloak:token:${token}`;
      await redisCache.del(cacheKey);

      return response.ok;
    } catch (error) {
      console.error('[Keycloak] Error logging out:', error);
      return false;
    }
  }

  // Refresh token
  async refreshToken(refreshToken: string): Promise<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
  } | null> {
    try {
      const response = await fetch(
        `${keycloakConfig['auth-server-url']}/realms/${keycloakConfig.realm}/protocol/openid-connect/token`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: keycloakConfig.resource,
            client_secret: keycloakConfig.credentials.secret
          })
        }
      );

      if (!response.ok) {
        return null;
      }

      return await response.json();
    } catch (error) {
      console.error('[Keycloak] Error refreshing token:', error);
      return null;
    }
  }

  // Health check
  async isHealthy(): Promise<boolean> {
    try {
      const response = await fetch(
        `${keycloakConfig['auth-server-url']}/realms/${keycloakConfig.realm}`
      );
      return response.ok;
    } catch (error) {
      console.error('[Keycloak] Health check failed:', error);
      return false;
    }
  }
}

// Singleton instance
export const keycloakAuth = new KeycloakAuthBridge();

// Express middleware for protecting routes
export function keycloakProtect(roles?: string[]) {
  return async (req: any, res: any, next: any) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = authHeader.substring(7);
    const user = await keycloakAuth.verifyToken(token);

    if (!user) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    if (roles && roles.length > 0) {
      if (!keycloakAuth.hasAnyRole(user, roles)) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    req.user = user;
    next();
  };
}
