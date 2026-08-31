import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import { assetsRouter } from "./routers/assets";
import { telemetryRouter } from "./routers/telemetry";
import { tradingRouter } from "./routers/trading";
import { billingRouter } from "./routers/billing";
import { paymentsRouter } from "./routers/payments";
import { alertsRouter } from "./routers/alerts";
import { adminRouter } from './routers/admin';
import { analyticsRouter } from './routers/analytics';
import { devicesRouter } from './routers/devices';
import { exportRouter } from './routers/export';
import { demandResponseRouter } from './routers/demandResponse';
import { drAutomationRouter } from './routers/dr-automation';
import { redisHealthRouter } from './routers/redis-health';
import { webhookConfigRouter } from './routers/webhook-config';import { paymentCredentialsRouter } from './routers/paymentCredentials';
import { paymentProcessingRouter } from './routers/paymentProcessing';
import { drForecastingRouter } from './routers/drForecasting';
import { adminAnalyticsRouter } from './routers/adminAnalytics';
import { drSegmentationRouter } from './routers/drSegmentation';
import { reconciliationRouter } from './routers/reconciliation';
import { gamificationRouter } from './routers/gamification';
import { participantInsightsRouter } from './routers/participantInsights';
import { cacheMonitoringRouter } from './routers/cache-monitoring';
import { notificationsRouter } from './routers/notifications';
import { notificationPreferencesRouter } from './routers/notificationPreferences';
import { emailRouter } from './routers/email';
import { biometricRouter } from './routers/biometric';
import { mqttCredentialsRouter } from './routers/mqtt-credentials';
import { orchestratorRouter } from './routers/orchestrator';
import { onboardingRouter } from './routers/onboarding';
import { performanceRouter } from './routers/performance';
import { performanceAlerting } from './_core/performance-alerting';
import { mpesaWebhookRouter } from './routers/mpesa-webhook';
import { auditLogsRouter } from './routers/auditLogs';
import { tradingStrategiesRouter } from './routers/tradingStrategies';
import { strategyTemplatesRouter } from './routers/strategyTemplates';
import { priceAlertsRouter } from './routers/priceAlerts';
import { strategyComparisonRouter } from './routers/strategyComparison';
import { referralsRouter } from './routers/referrals';
import { qrcodeRouter } from './routers/qrcode';
import { qrHistoryRouter } from './routers/qr-history';
import { workflowsRouter } from './routers/workflows';
import { gridOperatorRouter } from './routers/grid-operator';
import { iotDevicesRouter } from './routers/iot-devices';
import { mlPredictionsRouter } from './routers/ml-predictions';
import { p2pTradingRouter } from './routers/p2p-trading';
import { energyAdvisorRouter } from './routers/energyAdvisor';
import { dynamicTariffsRouter } from './routers/dynamicTariffs';
import { batteryHealthRouter } from './routers/batteryHealth';
import { p2pMatchingRouter } from './routers/p2pMatching';
import { carbonCreditsRouter } from './routers/carbonCredits';
import { gridAnomalyRouter } from './routers/gridAnomaly';
import { v2gOptimizerRouter } from './routers/v2gOptimizer';
import { energyWalletRouter } from './routers/energyWallet';
import { communityPoolsRouter } from './routers/communityPools';
import { drForecastRouter } from './routers/drForecast';
import { smsCommandsRouter } from './routers/smsCommands';
import { solarYieldRouter } from './routers/solarYield';
import { ntlDetectionRouter } from './routers/ntlDetection';
import { priceAlertEngineRouter } from './routers/priceAlertEngine';
import { complianceReportsRouter } from './routers/complianceReports';
import { controlWindowsRouter } from './routers/controlWindows';

// Next-gen VPP routers
import {
  anomalyRouter,
  evChargingRouter,
  forecastingRouter,
  optimizationRouter,
  settlementRouter,
  edgeRouter,
  carbonRouter,
  communityRouter,
  mlopsRouter,
  complianceRouter,
  blockchainRouter,
  derCapabilitiesRouter,
  priceSignalRouter,
  fleetTelemetryRouter,
  locationalFlexibilityRouter,
  matterLoadsRouter,
  degradedOperationRouter,
  digitalTwinRouter,
  ledgerRouter,
  eventStreamRouter,
  lakehouseRouter,
  diagnosticsRouter,
  modelHealthRouter,
  prepaidRouter,
  networkModelRouter,
  designStudyRouter,
  protocolConformanceRouter,
} from './routers/nextgen';

// Innovation routers (2026-08-31 wave — innov3). Note: the 'evCharging' key
// is already used by the nextgen router, so the planner is registered as
// 'evChargingPlanner'.
import { evChargingRouter as innov3EvChargingRouter } from './routers/innov3/evCharging';
import { outageRiskRouter } from './routers/innov3/outageRisk';
import { loadDisaggregationRouter } from './routers/innov3/loadDisaggregation';
import { tariffAdvisorRouter } from './routers/innov3/tariffAdvisor';
import { demandGuardianRouter } from './routers/innov3/demandGuardian';
import { workOrdersRouter } from './routers/innov3/workOrders';
import { firmwareCampaignsRouter } from './routers/innov3/firmwareCampaigns';
import { savingsVerifierRouter } from './routers/innov3/savingsVerifier';
import { flexLoadsRouter } from './routers/innov3/flexLoads';
import { portfolioRouter } from './routers/innov3/portfolio';
import { gridRevenueRouter } from './routers/innov3/gridRevenue';
import { offsetMarketRouter } from './routers/innov3/offsetMarket';
import { inverterFaultsRouter } from './routers/innov3/inverterFaults';
import { challengesRouter } from './routers/innov3/challenges';
import { digestRouter } from './routers/innov3/digest';
import { greenButtonRouter } from './routers/innov3/greenButton';
import { capacityBidsRouter } from './routers/innov3/capacityBids';
import { islandMonitorRouter } from './routers/innov3/islandMonitor';
import { dispatchWindowsRouter } from './routers/innov3/dispatchWindows';
import { budgetPlannerRouter } from './routers/innov3/budgetPlanner';

// Start performance alerting
if (process.env.NODE_ENV === 'production') {
  performanceAlerting.start();
}

export const appRouter = router({
  system: systemRouter,
  orchestrator: orchestratorRouter,
  onboarding: onboardingRouter,
  performance: performanceRouter,
  mpesaWebhook: mpesaWebhookRouter,
  auditLogs: auditLogsRouter,
  tradingStrategies: tradingStrategiesRouter,
  strategyTemplates: strategyTemplatesRouter,
  priceAlerts: priceAlertsRouter,
  strategyComparison: strategyComparisonRouter,
  referrals: referralsRouter,
  qrcode: qrcodeRouter,
  qrHistory: qrHistoryRouter,
  workflows: workflowsRouter,
  gridOperator: gridOperatorRouter,
  iotDevices: iotDevicesRouter,
  mlPredictions: mlPredictionsRouter,
  notifications: notificationsRouter,
  notificationPreferences: notificationPreferencesRouter,
  email: emailRouter,
  biometric: biometricRouter,
  mqttCredentials: mqttCredentialsRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),

  // VPP Platform Routers
  assets: assetsRouter,
  telemetry: telemetryRouter,
  trading: tradingRouter,
  p2pTrading: p2pTradingRouter,
  billing: billingRouter,
  payments: paymentsRouter,
  alerts: alertsRouter,
  admin: adminRouter,
  cacheMonitoring: cacheMonitoringRouter,
  analytics: analyticsRouter,
  devices: devicesRouter,
  export: exportRouter,
  demandResponse: demandResponseRouter,
  drAutomation: drAutomationRouter,
  redisHealth: redisHealthRouter,
  webhookConfig: webhookConfigRouter,
  paymentCredentials: paymentCredentialsRouter,
  paymentProcessing: paymentProcessingRouter,
  drForecasting: drForecastingRouter,
  adminAnalytics: adminAnalyticsRouter,
  drSegmentation: drSegmentationRouter,
  reconciliation: reconciliationRouter,
  gamification: gamificationRouter,
  participantInsights: participantInsightsRouter,

  // Innovation routers (2026-08-11 wave)
  energyAdvisor: energyAdvisorRouter,
  // Innovation routers (2026-08-31 wave — innov3)
  evChargingPlanner: innov3EvChargingRouter,
  outageRisk: outageRiskRouter,
  loadDisaggregation: loadDisaggregationRouter,
  tariffAdvisor: tariffAdvisorRouter,
  demandGuardian: demandGuardianRouter,
  workOrders: workOrdersRouter,
  firmwareCampaigns: firmwareCampaignsRouter,
  savingsVerifier: savingsVerifierRouter,
  flexLoads: flexLoadsRouter,
  portfolio: portfolioRouter,
  gridRevenue: gridRevenueRouter,
  offsetMarket: offsetMarketRouter,
  inverterFaults: inverterFaultsRouter,
  challenges: challengesRouter,
  digest: digestRouter,
  greenButton: greenButtonRouter,
  capacityBids: capacityBidsRouter,
  islandMonitor: islandMonitorRouter,
  dispatchWindows: dispatchWindowsRouter,
  budgetPlanner: budgetPlannerRouter,
  dynamicTariffs: dynamicTariffsRouter,
  batteryHealth: batteryHealthRouter,
  p2pMatching: p2pMatchingRouter,
  carbonCredits: carbonCreditsRouter,
  gridAnomaly: gridAnomalyRouter,
  v2gOptimizer: v2gOptimizerRouter,
  controlWindows: controlWindowsRouter,
  energyWallet: energyWalletRouter,
  communityPools: communityPoolsRouter,
  drForecast: drForecastRouter,
  smsCommands: smsCommandsRouter,
  solarYield: solarYieldRouter,
  ntlDetection: ntlDetectionRouter,
  priceAlertEngine: priceAlertEngineRouter,
  complianceReports: complianceReportsRouter,

  // Next-gen VPP routers
  anomaly: anomalyRouter,
  evCharging: evChargingRouter,
  forecasting: forecastingRouter,
  optimization: optimizationRouter,
  priceSignal: priceSignalRouter,
  fleetTelemetry: fleetTelemetryRouter,
  locationalFlexibility: locationalFlexibilityRouter,
  matterLoads: matterLoadsRouter,
  degradedOperation: degradedOperationRouter,
  digitalTwin: digitalTwinRouter,
  ledger: ledgerRouter,
  eventStream: eventStreamRouter,
  lakehouse: lakehouseRouter,
  diagnostics: diagnosticsRouter,
  modelHealth: modelHealthRouter,
  prepaid: prepaidRouter,
  networkModel: networkModelRouter,
  designStudy: designStudyRouter,
  protocolConformance: protocolConformanceRouter,
  settlement: settlementRouter,
  edge: edgeRouter,
  carbon: carbonRouter,
  community: communityRouter,
  mlops: mlopsRouter,
  compliance: complianceRouter,
  blockchain: blockchainRouter,
  derCapabilities: derCapabilitiesRouter,
});

export type AppRouter = typeof appRouter;
