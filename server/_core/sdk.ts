import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { ForbiddenError } from "@shared/_core/errors";
import { parse as parseCookieHeader } from "cookie";
import type { Request } from "express";
import { SignJWT, jwtVerify } from "jose";
import type { User } from "../../drizzle/schema";
import * as db from "../db";
import { ENV } from "./env";

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

export type SessionPayload = {
  openId: string;
  name: string;
  email?: string;
  loginMethod?: string;
};

type KeycloakTokenResponse = {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  id_token?: string;
};

type KeycloakUserInfo = {
  sub: string;
  email?: string;
  name?: string;
  preferred_username?: string;
  given_name?: string;
  family_name?: string;
};

function keycloakEndpoint(path: string): string {
  if (!ENV.keycloakUrl) {
    throw new Error("KEYCLOAK_URL is not configured");
  }
  const realm = encodeURIComponent(ENV.keycloakRealm);
  return new URL(
    `realms/${realm}/protocol/openid-connect/${path}`,
    `${ENV.keycloakUrl}/`
  ).toString();
}

function decodeAndValidateRedirectUri(state: string): string {
  let redirectUri: string;
  try {
    redirectUri = Buffer.from(state, "base64").toString("utf8");
  } catch {
    throw ForbiddenError("Invalid OAuth state");
  }

  let normalized: string;
  try {
    normalized = new URL(redirectUri).toString();
  } catch {
    throw ForbiddenError("Invalid OAuth redirect URI");
  }

  const allowed = new Set(
    [ENV.keycloakRedirectUri, ...ENV.keycloakAllowedRedirectUris]
      .filter(Boolean)
      .map(value => new URL(value).toString())
  );
  if (!allowed.has(normalized)) {
    throw ForbiddenError("OAuth redirect URI is not allowed");
  }
  return normalized;
}

function sessionName(userInfo: KeycloakUserInfo): string {
  return userInfo.name || userInfo.preferred_username || userInfo.email || userInfo.sub;
}

class KeycloakOidcService {
  async getTokenByCode(code: string, state: string): Promise<KeycloakTokenResponse> {
    if (!ENV.keycloakClientId || !ENV.keycloakClientSecret) {
      throw new Error("KEYCLOAK_CLIENT_ID and KEYCLOAK_CLIENT_SECRET are required");
    }

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: ENV.keycloakClientId,
      client_secret: ENV.keycloakClientSecret,
      code,
      redirect_uri: decodeAndValidateRedirectUri(state),
    });
    const response = await fetch(keycloakEndpoint("token"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Keycloak token exchange failed (${response.status})${detail ? `: ${detail}` : ""}`);
    }

    const token = (await response.json()) as KeycloakTokenResponse;
    if (!isNonEmptyString(token.access_token)) {
      throw new Error("Keycloak token response did not contain an access token");
    }
    return token;
  }

  async getUserInfo(accessToken: string): Promise<KeycloakUserInfo> {
    const response = await fetch(keycloakEndpoint("userinfo"), {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Keycloak userinfo failed (${response.status})${detail ? `: ${detail}` : ""}`);
    }
    const userInfo = (await response.json()) as KeycloakUserInfo;
    if (!isNonEmptyString(userInfo.sub)) {
      throw new Error("Keycloak userinfo response did not contain sub");
    }
    return userInfo;
  }
}

class SDKServer {
  private readonly oidc = new KeycloakOidcService();

  buildAuthorizationUrl(redirectUri: string): string {
    const allowedRedirectUri = decodeAndValidateRedirectUri(
      Buffer.from(redirectUri, "utf8").toString("base64")
    );
    const url = new URL(keycloakEndpoint("auth"));
    url.searchParams.set("client_id", ENV.keycloakClientId);
    url.searchParams.set("redirect_uri", allowedRedirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid profile email");
    url.searchParams.set("state", Buffer.from(allowedRedirectUri, "utf8").toString("base64"));
    return url.toString();
  }

  async exchangeCodeForToken(code: string, state: string): Promise<KeycloakTokenResponse> {
    return this.oidc.getTokenByCode(code, state);
  }

  async getUserInfo(accessToken: string): Promise<KeycloakUserInfo & { openId: string; loginMethod: string }> {
    const userInfo = await this.oidc.getUserInfo(accessToken);
    return {
      ...userInfo,
      openId: userInfo.sub,
      name: sessionName(userInfo),
      loginMethod: "keycloak",
    };
  }

  private parseCookies(cookieHeader: string | undefined): Map<string, string> {
    if (!cookieHeader) return new Map<string, string>();
    return new Map(Object.entries(parseCookieHeader(cookieHeader)));
  }

  private getSessionSecret(): Uint8Array {
    return new TextEncoder().encode(ENV.cookieSecret);
  }

  async createSessionToken(
    openId: string,
    options: { expiresInMs?: number; name?: string; email?: string; loginMethod?: string } = {}
  ): Promise<string> {
    return this.signSession(
      {
        openId,
        name: options.name || openId,
        ...(options.email ? { email: options.email } : {}),
        ...(options.loginMethod ? { loginMethod: options.loginMethod } : {}),
      },
      options
    );
  }

  async signSession(
    payload: SessionPayload,
    options: { expiresInMs?: number } = {}
  ): Promise<string> {
    const issuedAt = Date.now();
    const expiresInMs = options.expiresInMs ?? ONE_YEAR_MS;
    return new SignJWT(payload)
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuedAt(Math.floor(issuedAt / 1000))
      .setExpirationTime(Math.floor((issuedAt + expiresInMs) / 1000))
      .sign(this.getSessionSecret());
  }

  async verifySession(
    cookieValue: string | undefined | null
  ): Promise<SessionPayload | null> {
    if (!cookieValue) return null;
    try {
      const { payload } = await jwtVerify(cookieValue, this.getSessionSecret(), {
        algorithms: ["HS256"],
      });
      const { openId, name, email, loginMethod } = payload as Record<string, unknown>;
      if (!isNonEmptyString(openId) || !isNonEmptyString(name)) return null;
      return {
        openId,
        name,
        ...(isNonEmptyString(email) ? { email } : {}),
        ...(isNonEmptyString(loginMethod) ? { loginMethod } : {}),
      };
    } catch {
      return null;
    }
  }

  async authenticateRequest(req: Request): Promise<User> {
    const sessionCookie = this.parseCookies(req.headers.cookie).get(COOKIE_NAME);
    const session = await this.verifySession(sessionCookie);
    if (!session) throw ForbiddenError("Invalid session cookie");

    const signedInAt = new Date();
    let user = await db.getUserByOpenId(session.openId);
    if (!user) {
      await db.upsertUser({
        openId: session.openId,
        name: session.name,
        email: session.email ?? null,
        loginMethod: session.loginMethod ?? "keycloak",
        lastSignedIn: signedInAt,
      });
      user = await db.getUserByOpenId(session.openId);
    }
    if (!user) throw ForbiddenError("User not found");

    await db.upsertUser({ openId: user.openId, lastSignedIn: signedInAt });
    return user;
  }
}

export const sdk = new SDKServer();
export const __oidcTestables = { decodeAndValidateRedirectUri, keycloakEndpoint };
