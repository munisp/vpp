import { createHash } from 'crypto';
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

/**
 * Longest a verified token is trusted from cache. A token may live far longer
 * than this; the cache is a way to avoid re-verifying every request, not a
 * second opinion on how long the token is good for.
 */
const MAX_TOKEN_CACHE_SECONDS = 300;

/**
 * Slack subtracted from a token's expiry before caching, so a cached entry can
 * never outlive the token it describes.
 */
const EXPIRY_SAFETY_SECONDS = 5;

/**
 * Cache key for a bearer token. The token itself is a credential and is never
 * used as a key: Redis keys appear in `KEYS`, `MONITOR` and slow-log output, so
 * a raw-token key hands whoever can read Redis a usable session.
 */
function tokenCacheKey(token: string): string {
  return `keycloak:token:${createHash('sha256').update(token).digest('hex')}`;
}

/** What a cached verification remembers, including when the token itself dies. */
interface CachedVerification {
  user: KeycloakUser;
  /** Token `exp` in epoch seconds, or null when the token declared none. */
  expiresAtEpochSeconds: number | null;
}

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
      const cacheKey = tokenCacheKey(token);
      const cached = await redisCache.get<CachedVerification>(cacheKey);
      if (cached?.user) {
        // A cached verification is only as good as the token's own lifetime: an
        // expired or revoked-then-reissued token must not ride a cache entry.
        if (!isExpired(cached.expiresAtEpochSeconds)) {
          return cached.user;
        }
        await redisCache.del(cacheKey);
      }

      // Verify with Keycloak
      const grant = await this.keycloak.grantManager.createGrant({
        access_token: token
      });

      if (!grant || !grant.access_token) {
        return null;
      }

      const accessToken = grant.access_token;
      const content = accessToken.content as { [key: string]: unknown } & {
        sub: string;
        exp?: number;
        realm_access?: { roles?: string[] };
      };

      const user: KeycloakUser = {
        sub: content.sub,
        email: typeof content.email === 'string' ? content.email : undefined,
        name: typeof content.name === 'string' ? content.name : undefined,
        preferred_username:
          typeof content.preferred_username === 'string' ? content.preferred_username : undefined,
        given_name: typeof content.given_name === 'string' ? content.given_name : undefined,
        family_name: typeof content.family_name === 'string' ? content.family_name : undefined,
        roles: content.realm_access?.roles || []
      };

      const expiresAtEpochSeconds = typeof content.exp === 'number' ? content.exp : null;
      if (isExpired(expiresAtEpochSeconds)) {
        // Keycloak accepted it but it has since expired: report it as invalid
        // rather than caching a session that is already over.
        return null;
      }

      const ttl = cacheTtlSeconds(expiresAtEpochSeconds);
      if (ttl > 0) {
        await redisCache.set(cacheKey, { user, expiresAtEpochSeconds }, ttl);
      }

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
      await redisCache.del(tokenCacheKey(token));

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

/** True when a token's declared expiry has passed. No expiry is not expired. */
export function isExpired(
  expiresAtEpochSeconds: number | null,
  nowMs: number = Date.now()
): boolean {
  if (expiresAtEpochSeconds === null) return false;
  return expiresAtEpochSeconds * 1000 <= nowMs;
}

/**
 * How long a verified token may be trusted from cache: the shorter of the cache
 * ceiling and the token's own remaining life. A token with no declared expiry
 * gets the ceiling, because the platform cannot claim to know better.
 */
export function cacheTtlSeconds(
  expiresAtEpochSeconds: number | null,
  nowMs: number = Date.now()
): number {
  if (expiresAtEpochSeconds === null) return MAX_TOKEN_CACHE_SECONDS;
  const remaining = Math.floor(
    (expiresAtEpochSeconds * 1000 - nowMs) / 1000 - EXPIRY_SAFETY_SECONDS
  );
  return Math.max(0, Math.min(MAX_TOKEN_CACHE_SECONDS, remaining));
}

export { tokenCacheKey };

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
