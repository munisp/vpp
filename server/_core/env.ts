import crypto from "crypto";

/**
 * Resolve the JWT/session secret.
 *
 * JWT_SECRET signs the local application session and encrypts protected data. A
 * production instance refuses to start without a sufficiently strong secret;
 * development gets an explicitly ephemeral secret to avoid a silent insecure
 * default.
 */
function resolveCookieSecret(): string {
  const secret = process.env.JWT_SECRET ?? "";
  const isProduction = process.env.NODE_ENV === "production";

  if (secret.length >= 32) return secret;
  if (isProduction) {
    throw new Error(
      "FATAL: JWT_SECRET is missing or shorter than 32 characters. " +
        "Set a cryptographically random value of at least 32 characters."
    );
  }

  const ephemeral = crypto.randomBytes(32).toString("hex");
  console.warn(
    "[ENV] WARNING: JWT_SECRET is not set or too short. Generated an ephemeral " +
      "development-only secret; sessions and encrypted data will be invalid after restart."
  );
  return ephemeral;
}

function optionalUrl(name: string): string {
  const value = process.env[name]?.trim() ?? "";
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && url.protocol === "http:")) {
      throw new Error("must use HTTPS outside local development");
    }
    return url.toString().replace(/\/$/, "");
  } catch (error) {
    throw new Error(`Invalid ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function csv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
}

const cookieSecret = resolveCookieSecret();

export const ENV = {
  cookieSecret,
  databaseUrl: process.env.DATABASE_URL ?? "",
  isProduction: process.env.NODE_ENV === "production",

  // Keycloak / OpenID Connect
  keycloakUrl: optionalUrl("KEYCLOAK_URL"),
  keycloakRealm: process.env.KEYCLOAK_REALM?.trim() || "vpp",
  keycloakClientId: process.env.KEYCLOAK_CLIENT_ID?.trim() || "vpp-consumer-platform",
  keycloakClientSecret: process.env.KEYCLOAK_CLIENT_SECRET ?? "",
  keycloakRedirectUri: optionalUrl("KEYCLOAK_REDIRECT_URI"),
  keycloakAllowedRedirectUris: csv("KEYCLOAK_ALLOWED_REDIRECT_URIS"),
  ownerUserId: process.env.OWNER_USER_ID?.trim() || "",

  // S3-compatible object storage (MinIO or another S3 implementation)
  s3Endpoint: optionalUrl("S3_ENDPOINT"),
  s3Region: process.env.S3_REGION?.trim() || "us-east-1",
  s3AccessKey: process.env.S3_ACCESS_KEY ?? "",
  s3SecretKey: process.env.S3_SECRET_KEY ?? "",
  s3Bucket: process.env.S3_BUCKET?.trim() || "",
  s3ForcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
  s3SignedUrlTtlSeconds: Number.parseInt(process.env.S3_SIGNED_URL_TTL_SECONDS ?? "900", 10),

  // Self-hostable OpenAI-compatible model services
  llmBaseUrl: optionalUrl("LLM_BASE_URL"),
  llmApiKey: process.env.LLM_API_KEY ?? "",
  llmModel: process.env.LLM_MODEL?.trim() || "",
  imageGenerationBaseUrl: optionalUrl("IMAGE_GENERATION_BASE_URL"),
  imageGenerationApiKey: process.env.IMAGE_GENERATION_API_KEY ?? "",
  imageGenerationModel: process.env.IMAGE_GENERATION_MODEL?.trim() || "",
  transcriptionBaseUrl: optionalUrl("TRANSCRIPTION_BASE_URL"),
  transcriptionApiKey: process.env.TRANSCRIPTION_API_KEY ?? "",
  transcriptionModel: process.env.TRANSCRIPTION_MODEL?.trim() || "whisper-1",

  // Direct integrations, never browser-exposed.
  googleMapsApiBaseUrl: optionalUrl("GOOGLE_MAPS_API_BASE_URL") || "https://maps.googleapis.com",
  googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY ?? "",
  ownerNotificationWebhookUrl: optionalUrl("OWNER_NOTIFICATION_WEBHOOK_URL"),
  ownerNotificationWebhookSecret: process.env.OWNER_NOTIFICATION_WEBHOOK_SECRET ?? "",

  redisHost: process.env.REDIS_HOST ?? "localhost",
  redisPort: Number.parseInt(process.env.REDIS_PORT ?? "6379", 10),
  redisPassword: process.env.REDIS_PASSWORD,
  redisDb: Number.parseInt(process.env.REDIS_DB ?? "0", 10),
  openWeatherApiKey: process.env.OPENWEATHER_API_KEY,
  alertWebhookUrl: process.env.ALERT_WEBHOOK_URL,
};
