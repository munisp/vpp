import crypto from "crypto";

/**
 * Resolve the JWT/session secret.
 *
 * JWT_SECRET is both the HS256 session-signing key and the AES-GCM data
 * encryption key (server/encryption.ts). An empty or weak secret would make
 * session forgery trivial, so:
 * - production: hard-fail at module load when missing/too short (<32 chars)
 * - development: fall back to an ephemeral random secret with a loud warning
 */
function resolveCookieSecret(): string {
  const secret = process.env.JWT_SECRET ?? "";
  const isProduction = process.env.NODE_ENV === "production";

  if (secret.length >= 32) {
    return secret;
  }

  if (isProduction) {
    throw new Error(
      "FATAL: JWT_SECRET is missing or shorter than 32 characters. " +
        "Refusing to start in production with a weak session/encryption secret. " +
        "Set JWT_SECRET to a cryptographically random value of at least 32 characters."
    );
  }

  const ephemeral = crypto.randomBytes(32).toString("hex");
  console.warn(
    "[ENV] WARNING: JWT_SECRET is not set or too short. Generated an EPHEMERAL random secret " +
      "for this process — all sessions and encrypted data become invalid on restart. " +
      "Set JWT_SECRET (>= 32 chars) to persist sessions."
  );
  return ephemeral;
}

const cookieSecret = resolveCookieSecret();

export const ENV = {
  appId: process.env.VITE_APP_ID ?? "",
  cookieSecret,
  databaseUrl: process.env.DATABASE_URL ?? "",
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? "",
  
  // Redis configuration
  redisHost: process.env.REDIS_HOST ?? "localhost",
  redisPort: parseInt(process.env.REDIS_PORT ?? "6379"),
  redisPassword: process.env.REDIS_PASSWORD,
  redisDb: parseInt(process.env.REDIS_DB ?? "0"),
  
  // OpenWeather API
  openWeatherApiKey: process.env.OPENWEATHER_API_KEY,
  
  // Monitoring webhooks
  alertWebhookUrl: process.env.ALERT_WEBHOOK_URL,
};
