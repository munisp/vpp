import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import type { Express, Request, Response } from "express";
import * as db from "../db";
import { getSessionCookieOptions } from "./cookies";
import { sdk } from "./sdk";

function getQueryParam(req: Request, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Register Keycloak/OIDC routes. The application keeps a short, signed local
 * session cookie after a successful Keycloak code exchange; this maintains the
 * existing tRPC, Socket.IO, and mobile-session contract without a hosted
 * platform runtime.
 */
export function registerOAuthRoutes(app: Express) {
  app.get("/api/oauth/authorize", (req: Request, res: Response) => {
    const redirectUri = getQueryParam(req, "redirect_uri") ??
      `${req.protocol}://${req.get("host")}/api/oauth/callback`;
    try {
      res.redirect(302, sdk.buildAuthorizationUrl(redirectUri));
    } catch (error) {
      console.warn("[OAuth] Authorization request rejected", error);
      res.status(400).json({ error: "OAuth redirect URI is not allowed" });
    }
  });

  app.get("/api/oauth/callback", async (req: Request, res: Response) => {
    const code = getQueryParam(req, "code");
    const state = getQueryParam(req, "state");
    if (!code || !state) {
      res.status(400).json({ error: "code and state are required" });
      return;
    }

    try {
      const tokenResponse = await sdk.exchangeCodeForToken(code, state);
      const userInfo = await sdk.getUserInfo(tokenResponse.access_token);
      await db.upsertUser({
        openId: userInfo.openId,
        name: userInfo.name || null,
        email: userInfo.email ?? null,
        loginMethod: userInfo.loginMethod,
        lastSignedIn: new Date(),
      });

      const sessionToken = await sdk.createSessionToken(userInfo.openId, {
        name: userInfo.name,
        email: userInfo.email,
        loginMethod: userInfo.loginMethod,
        expiresInMs: ONE_YEAR_MS,
      });
      res.cookie(COOKIE_NAME, sessionToken, {
        ...getSessionCookieOptions(req),
        maxAge: ONE_YEAR_MS,
      });

      const redirectUri = Buffer.from(state, "base64").toString("utf8");
      const target = new URL(redirectUri);
      // The SDK revalidates state before exchange. The local redirect avoids
      // reflecting query values into a response without an allowed-origin gate.
      res.redirect(302, target.toString());
    } catch (error) {
      console.error("[OAuth] Callback failed", error);
      res.status(500).json({ error: "OAuth callback failed" });
    }
  });
}
