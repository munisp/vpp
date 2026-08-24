import { defineConfig } from "drizzle-kit";
import { assertPostgresUrl } from "./server/_core/database-url";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required to run drizzle commands");
}
assertPostgresUrl(connectionString);

export default defineConfig({
  schema: ["./drizzle/schema.ts", "./drizzle/*-schema.ts"],
  out: "./drizzle/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: connectionString,
  },
});
