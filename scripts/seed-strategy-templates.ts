import { seedStrategyTemplates } from "../server/db-strategy-templates";

async function main() {
  console.log("[Seed] Starting strategy templates seeding...");
  await seedStrategyTemplates();
  console.log("[Seed] Complete!");
  process.exit(0);
}

main().catch((error) => {
  console.error("[Seed] Error:", error);
  process.exit(1);
});
