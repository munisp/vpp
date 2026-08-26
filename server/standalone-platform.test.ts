import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("standalone platform contracts", () => {
  it("allows only configured Keycloak callback URIs", async () => {
    vi.stubEnv("KEYCLOAK_URL", "https://identity.example.test");
    vi.stubEnv("KEYCLOAK_REALM", "vpp");
    vi.stubEnv("KEYCLOAK_CLIENT_ID", "vpp-web");
    vi.stubEnv("KEYCLOAK_CLIENT_SECRET", "test-secret");
    vi.stubEnv("KEYCLOAK_REDIRECT_URI", "https://app.example.test/api/oauth/callback");
    vi.stubEnv("KEYCLOAK_ALLOWED_REDIRECT_URIS", "vpp://oauth/callback");

    const { __oidcTestables } = await import("./_core/sdk");
    const allowed = Buffer.from("vpp://oauth/callback", "utf8").toString("base64");
    const rejected = Buffer.from("https://attacker.example.test/callback", "utf8").toString("base64");

    expect(__oidcTestables.decodeAndValidateRedirectUri(allowed)).toBe("vpp://oauth/callback");
    expect(() => __oidcTestables.decodeAndValidateRedirectUri(rejected)).toThrow("OAuth redirect URI is not allowed");
    expect(__oidcTestables.keycloakEndpoint("token")).toBe(
      "https://identity.example.test/realms/vpp/protocol/openid-connect/token"
    );
  });

  it("rejects unsafe S3 object keys before an upload can escape its namespace", async () => {
    const { __storageTestables } = await import("../server/storage");
    expect(__storageTestables.normalizeKey("generated/report.png")).toBe("generated/report.png");
    expect(() => __storageTestables.normalizeKey("../escape")).toThrow("dot segments");
    expect(() => __storageTestables.normalizeKey("/generated//report.png")).toThrow("dot segments");
  });

  it("signs generic owner notifications without a hosted notification service", async () => {
    vi.stubEnv("OWNER_NOTIFICATION_WEBHOOK_SECRET", "notification-test-secret");
    const { __notificationTestables } = await import("./_core/notification");
    expect(__notificationTestables.signature('{"title":"Alert","content":"Body"}')).toMatch(/^\w{64}$/);
  });

  it("has no retired platform integration references in tracked source or configuration", () => {
    const root = resolve(import.meta.dirname, "..");
    const files = [
      "package.json",
      "vite.config.ts",
      ".env.example",
      "server/_core/env.ts",
      "server/_core/sdk.ts",
      "server/_core/oauth.ts",
      "server/storage.ts",
      "server/_core/llm.ts",
      "server/_core/imageGeneration.ts",
      "server/_core/voiceTranscription.ts",
      "server/_core/notification.ts",
      "server/_core/map.ts",
      "scripts/validate-env.sh",
    ];
    const retiredTerms = [
      "ma" + "nus",
      "forge" + "." + "ma" + "nus",
      "built" + "_in_forge",
      "webdev" + "token",
      "webdev" + ".v1",
      "vite-plugin-" + "ma" + "nus-runtime",
    ];
    for (const file of files) {
      const source = readFileSync(resolve(root, file), "utf8").toLowerCase();
      for (const term of retiredTerms) {
        expect(source, `${file} contains retired term ${term}`).not.toContain(term);
      }
    }
  });
});
