import { eq } from "drizzle-orm";
import { strategyTemplates, InsertStrategyTemplate } from "../drizzle/schema";
import { getDb } from "./db";

/**
 * Get all strategy templates
 */
export async function getAllStrategyTemplates() {
  const db = await getDb();
  if (!db) return [];
  
  return await db.select().from(strategyTemplates);
}

/**
 * Get strategy template by ID
 */
export async function getStrategyTemplateById(id: number) {
  const db = await getDb();
  if (!db) return null;
  
  const result = await db.select().from(strategyTemplates).where(eq(strategyTemplates.id, id)).limit(1);
  return result.length > 0 ? result[0] : null;
}

/**
 * Get strategy templates by category
 */
export async function getStrategyTemplatesByCategory(category: string) {
  const db = await getDb();
  if (!db) return [];
  
  return await db.select().from(strategyTemplates).where(eq(strategyTemplates.category, category));
}

/**
 * Increment times cloned counter
 */
export async function incrementTemplateCloneCount(id: number) {
  const db = await getDb();
  if (!db) return;
  
  // Get current count
  const template = await getStrategyTemplateById(id);
  if (!template) return;
  
  // Increment by 1
  await db.update(strategyTemplates)
    .set({ timesCloned: (template.timesCloned || 0) + 1 })
    .where(eq(strategyTemplates.id, id));
}

/**
 * Seed initial strategy templates (call once during setup)
 */
export async function seedStrategyTemplates() {
  const db = await getDb();
  if (!db) return;
  
  // Check if templates already exist
  const existing = await db.select().from(strategyTemplates).limit(1);
  if (existing.length > 0) {
    console.log("[Strategy Templates] Templates already seeded");
    return;
  }
  
  const templates: InsertStrategyTemplate[] = [
    {
      name: "Peak Hour Seller",
      description: "Automatically sell excess solar energy during peak price hours (10 AM - 6 PM) when grid demand is highest. Maximizes revenue by targeting premium pricing periods.",
      category: "peak_hours",
      icon: "Sun",
      conditions: {
        priceThresholds: {
          minExportPrice: 150, // TZS/kWh minimum
        },
        batteryLevels: {
          minSOC: 60, // Only sell when battery is above 60%
        },
        timeWindows: {
          startHour: 10,
          endHour: 18,
          daysOfWeek: [1, 2, 3, 4, 5], // Weekdays only
        },
        energyLimits: {
          minTradeSize: 2, // Minimum 2 kWh per trade
          maxTradeSize: 20, // Maximum 20 kWh per trade
          dailyLimit: 50, // Maximum 50 kWh per day
        },
      },
      tradingMode: "export",
      priority: 10,
      expectedPerformance: {
        avgDailyTrades: 4,
        avgDailyProfit: 2400, // TZS (~$1)
        avgDailyEnergy: 16, // kWh
        successRate: 92,
        bestSeason: "Dry season (June-October)",
      },
      tags: ["beginner-friendly", "high-profit", "solar-focused"],
      difficulty: "beginner",
    },
    {
      name: "Battery Optimizer",
      description: "Smart battery management strategy that charges during low-price periods and discharges during high-price periods. Optimizes battery cycles for maximum profitability.",
      category: "battery_optimization",
      icon: "Battery",
      conditions: {
        priceThresholds: {
          minExportPrice: 140,
          maxImportPrice: 80, // Buy when price is low
        },
        batteryLevels: {
          minSOC: 80, // Sell when battery is nearly full
          maxSOC: 30, // Buy when battery is low
        },
        timeWindows: {
          startHour: 0,
          endHour: 23,
          daysOfWeek: [0, 1, 2, 3, 4, 5, 6], // Every day
        },
        energyLimits: {
          minTradeSize: 3,
          maxTradeSize: 15,
          dailyLimit: 40,
        },
      },
      tradingMode: "both",
      priority: 8,
      expectedPerformance: {
        avgDailyTrades: 6,
        avgDailyProfit: 1800, // TZS
        avgDailyEnergy: 24, // kWh
        successRate: 88,
        bestSeason: "All year",
      },
      tags: ["intermediate", "battery-focused", "arbitrage"],
      difficulty: "intermediate",
    },
    {
      name: "Price Arbitrage",
      description: "Advanced trading strategy that exploits price differences throughout the day. Buys energy when prices are low and sells when prices spike, maximizing profit margins.",
      category: "price_arbitrage",
      icon: "TrendingUp",
      conditions: {
        priceThresholds: {
          minExportPrice: 160, // Sell at premium prices
          maxImportPrice: 70, // Buy at bargain prices
        },
        batteryLevels: {
          minSOC: 50,
          maxSOC: 50,
        },
        timeWindows: {
          startHour: 0,
          endHour: 23,
          daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        },
        energyLimits: {
          minTradeSize: 5,
          maxTradeSize: 25,
          dailyLimit: 60,
        },
      },
      tradingMode: "both",
      priority: 9,
      expectedPerformance: {
        avgDailyTrades: 8,
        avgDailyProfit: 3200, // TZS
        avgDailyEnergy: 32, // kWh
        successRate: 85,
        bestSeason: "All year",
      },
      tags: ["advanced", "high-profit", "active-trading"],
      difficulty: "advanced",
    },
    {
      name: "Night Charger",
      description: "Charges battery during off-peak night hours (10 PM - 6 AM) when electricity prices are lowest. Ideal for users with grid connection who want to minimize energy costs.",
      category: "battery_optimization",
      icon: "Moon",
      conditions: {
        priceThresholds: {
          maxImportPrice: 75, // Buy only when very cheap
        },
        batteryLevels: {
          maxSOC: 40, // Only charge when battery is low
        },
        timeWindows: {
          startHour: 22,
          endHour: 6,
          daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        },
        energyLimits: {
          minTradeSize: 5,
          maxTradeSize: 30,
          dailyLimit: 50,
        },
      },
      tradingMode: "import",
      priority: 7,
      expectedPerformance: {
        avgDailyTrades: 2,
        avgDailyProfit: 600, // TZS (savings)
        avgDailyEnergy: 20, // kWh
        successRate: 95,
        bestSeason: "All year",
      },
      tags: ["beginner-friendly", "cost-saving", "night-hours"],
      difficulty: "beginner",
    },
    {
      name: "Grid Support",
      description: "Participates in grid stabilization by exporting energy during peak demand periods. Helps prevent blackouts while earning premium compensation from grid operators.",
      category: "grid_support",
      icon: "Zap",
      conditions: {
        priceThresholds: {
          minExportPrice: 180, // Premium grid support pricing
        },
        batteryLevels: {
          minSOC: 70, // Ensure sufficient reserve
        },
        timeWindows: {
          startHour: 17,
          endHour: 21, // Evening peak hours
          daysOfWeek: [1, 2, 3, 4, 5],
        },
        energyLimits: {
          minTradeSize: 3,
          maxTradeSize: 15,
          dailyLimit: 30,
        },
      },
      tradingMode: "export",
      priority: 11, // Highest priority for grid support
      expectedPerformance: {
        avgDailyTrades: 3,
        avgDailyProfit: 2700, // TZS
        avgDailyEnergy: 12, // kWh
        successRate: 90,
        bestSeason: "Dry season",
      },
      tags: ["intermediate", "grid-support", "premium-pricing"],
      difficulty: "intermediate",
    },
    {
      name: "Solar Maximizer",
      description: "Optimizes solar panel output by selling all excess generation immediately. Perfect for users without battery storage who want to maximize solar investment returns.",
      category: "solar_maximization",
      icon: "SunMedium",
      conditions: {
        priceThresholds: {
          minExportPrice: 120, // Accept reasonable prices
        },
        timeWindows: {
          startHour: 8,
          endHour: 17, // Solar generation hours
          daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        },
        energyLimits: {
          minTradeSize: 1,
          maxTradeSize: 10,
          dailyLimit: 40,
        },
      },
      tradingMode: "export",
      priority: 6,
      expectedPerformance: {
        avgDailyTrades: 6,
        avgDailyProfit: 1600, // TZS
        avgDailyEnergy: 18, // kWh
        successRate: 94,
        bestSeason: "All year",
      },
      tags: ["beginner-friendly", "solar-focused", "no-battery-required"],
      difficulty: "beginner",
    },
    {
      name: "Emergency Reserve",
      description: "Conservative strategy that maintains high battery reserve for emergencies while selling only excess energy above 90% SOC. Prioritizes energy security over profit.",
      category: "emergency_reserve",
      icon: "Shield",
      conditions: {
        priceThresholds: {
          minExportPrice: 130,
        },
        batteryLevels: {
          minSOC: 90, // Only sell when battery is nearly full
        },
        timeWindows: {
          startHour: 0,
          endHour: 23,
          daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        },
        energyLimits: {
          minTradeSize: 2,
          maxTradeSize: 10,
          dailyLimit: 20,
        },
      },
      tradingMode: "export",
      priority: 5,
      expectedPerformance: {
        avgDailyTrades: 2,
        avgDailyProfit: 800, // TZS
        avgDailyEnergy: 8, // kWh
        successRate: 96,
        bestSeason: "All year",
      },
      tags: ["beginner-friendly", "conservative", "energy-security"],
      difficulty: "beginner",
    },
  ];
  
  await db.insert(strategyTemplates).values(templates);
  console.log(`[Strategy Templates] Seeded ${templates.length} templates`);
}
