import { lazy, Suspense } from "react";
import { Toaster } from "@/components/ui/sonner";
import { PWAInstallPrompt } from "./components/PWAInstallPrompt";
import { PWAInstallBanner } from "./components/PWAInstallBanner";
import { OfflineIndicator } from "./components/OfflineIndicator";
import { TooltipProvider } from "@/components/ui/tooltip";
const NotFound = lazy(() => import("@/pages/NotFound"));
const EnergyInsights = lazy(() => import("@/pages/EnergyInsights"));
const DRAutomation = lazy(() => import("@/pages/admin/DRAutomation"));
const WebhookConfig = lazy(() => import("@/pages/admin/WebhookConfig"));
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { RouteShell } from "./components/RouteShell";
import { ThemeProvider } from "./contexts/ThemeContext";
const Home = lazy(() => import("./pages/Home"));
const Assets = lazy(() => import("./pages/Assets"));
const Monitoring = lazy(() => import("./pages/Monitoring"));
const Trading = lazy(() => import("./pages/Trading"));
const Billing = lazy(() => import("./pages/Billing"));
const Payments = lazy(() => import("./pages/Payments"));
const Alerts = lazy(() => import("./pages/Alerts"));
const Settings = lazy(() => import("@/pages/Settings"));
const DemandResponse = lazy(() => import("@/pages/DemandResponse"));
const AdminDashboard = lazy(() => import("./pages/admin/AdminDashboard"));
const UserManagement = lazy(() => import("./pages/admin/UserManagement"));
const AssetApproval = lazy(() => import("./pages/admin/AssetApproval"));
const MarketPricing = lazy(() => import("./pages/admin/MarketPricing"));
const DeviceManagement = lazy(() => import("./pages/admin/DeviceManagement"));
const DRManagement = lazy(() => import("./pages/admin/DRManagement"));
const PaymentCredentials = lazy(() => import("./pages/admin/PaymentCredentials"));
const AdminAnalytics = lazy(() => import("./pages/admin/AdminAnalytics"));
const AnalyticsDashboard = lazy(() => import("./pages/admin/AnalyticsDashboard"));
const ReconciliationDashboard = lazy(() => import("./pages/admin/ReconciliationDashboard"));
const Leaderboard = lazy(() => import("./pages/Leaderboard"));
const Analytics = lazy(() => import("./pages/Analytics"));
const CacheMonitoring = lazy(() => import("./pages/admin/CacheMonitoring"));
const AuditLogs = lazy(() => import("./pages/admin/AuditLogs"));
const MLPredictions = lazy(() => import("./pages/admin/MLPredictions"));
const WorkflowMonitoring = lazy(() => import("./pages/admin/WorkflowMonitoring"));
const GridOperator = lazy(() => import("./pages/admin/GridOperator"));
const PerformanceDashboard = lazy(() => import("./pages/admin/PerformanceDashboard"));
const IoTDeviceMonitoring = lazy(() => import("./pages/admin/IoTDeviceMonitoring"));
const NotificationSettings = lazy(() => import("@/pages/NotificationSettings"));
const TradingStrategies = lazy(() => import("@/pages/TradingStrategies"));
const StrategyTemplates = lazy(() => import("@/pages/StrategyTemplates"));
const PriceAlerts = lazy(() => import("@/pages/PriceAlerts"));
const StrategyComparison = lazy(() => import("@/pages/StrategyComparison"));
const QRPayment = lazy(() => import("./pages/QRPayment"));
const QRDeviceRegistration = lazy(() => import("./pages/QRDeviceRegistration"));
const Referrals = lazy(() => import("./pages/Referrals"));
const QRScanner = lazy(() => import("./pages/QRScanner"));
const BiometricSettings = lazy(() => import("./pages/BiometricSettings"));
const QRGenerator = lazy(() => import("./pages/QRGenerator"));
const ReferralLeaderboard = lazy(() => import("./pages/ReferralLeaderboard"));
const QRHistory = lazy(() => import("@/pages/QRHistory"));
const UserAnalyticsDashboard = lazy(() => import("@/pages/AnalyticsDashboard"));
const EnergyAdvisor = lazy(() => import("@/pages/EnergyAdvisor"));
const Tariffs = lazy(() => import("@/pages/Tariffs"));
const BatteryHealth = lazy(() => import("@/pages/BatteryHealth"));
const OrderBook = lazy(() => import("@/pages/OrderBook"));
const CarbonCredits = lazy(() => import("@/pages/CarbonCredits"));
const GridAnomalies = lazy(() => import("@/pages/GridAnomalies"));
const ControlWindows = lazy(() => import("@/pages/ControlWindows"));
const ForecastAccuracy = lazy(() => import("@/pages/ForecastAccuracy"));
const PriceSignals = lazy(() => import("@/pages/PriceSignals"));
const FleetTelemetry = lazy(() => import("@/pages/FleetTelemetry"));
const DigitalTwin = lazy(() => import("@/pages/DigitalTwin"));
const OperationsWall = lazy(() => import("@/pages/OperationsWall"));
const MatterLoads = lazy(() => import("@/pages/MatterLoads"));
const DegradedOperation = lazy(() => import("@/pages/DegradedOperation"));
const LedgerReconciliation = lazy(() => import("@/pages/LedgerReconciliation"));
const EventStream = lazy(() => import("@/pages/EventStream"));
const Lakehouse = lazy(() => import("@/pages/Lakehouse"));
const ModelHealth = lazy(() => import("@/pages/ModelHealth"));
const Diagnostics = lazy(() => import("@/pages/Diagnostics"));
const LocationalFlexibility = lazy(() => import("@/pages/LocationalFlexibility"));
const NetworkFeasibility = lazy(() => import("@/pages/NetworkFeasibility"));
const ProtocolConformance = lazy(() => import("@/pages/ProtocolConformance"));
const DesignStudy = lazy(() => import("@/pages/DesignStudy"));
const V2G = lazy(() => import("@/pages/V2G"));
const Wallet = lazy(() => import("@/pages/Wallet"));
const CommunityPools = lazy(() => import("@/pages/CommunityPools"));
const MicrogridResilience = lazy(() => import("@/pages/MicrogridResilience"));
const PrepaidEnergy = lazy(() => import("@/pages/PrepaidEnergy"));
const DRForecast = lazy(() => import("@/pages/DRForecast"));
const SmsCenter = lazy(() => import("@/pages/SmsCenter"));
const SolarYield = lazy(() => import("@/pages/SolarYield"));
const NtlDashboard = lazy(() => import("@/pages/NtlDashboard"));
const ComplianceReports = lazy(() => import("@/pages/ComplianceReports"));

function RouteLoading() {
  return (
    <main
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="flex min-h-screen items-center justify-center bg-background p-6 text-muted-foreground"
    >
      Loading page…
    </main>
  );
}

function Router() {
  return (
    <Switch>
      <Route path={"/"} component={Home} />
      <Route path="/energy-insights">
        <RouteShell>
          <EnergyInsights />
        </RouteShell>
      </Route>
      <Route path="/admin/dr-automation">
        <RouteShell adminOnly>
          <DRAutomation />
        </RouteShell>
      </Route>
      <Route path="/admin/webhook-config">
        <RouteShell adminOnly>
          <WebhookConfig />
        </RouteShell>
      </Route>     <Route path="/assets" component={Assets} />
      <Route path="/monitoring" component={Monitoring} />
      <Route path="/trading" component={Trading} />
      <Route path="/billing" component={Billing} />
      <Route path="/payments" component={Payments} />
      <Route path="/alerts" component={Alerts} />
      <Route path={"/settings"} component={Settings} />
      <Route path="/notifications">
        <RouteShell>
          <NotificationSettings />
        </RouteShell>
      </Route>
      <Route path="/notification-settings">
        <RouteShell>
          <NotificationSettings />
        </RouteShell>
      </Route>
      <Route path="/trading/strategies" component={TradingStrategies} />
      <Route path="/trading/templates">
        <RouteShell>
          <StrategyTemplates />
        </RouteShell>
      </Route>
      <Route path="/trading/price-alerts" component={PriceAlerts} />
      <Route path="/trading/comparison" component={StrategyComparison} />
      <Route path="/qr-payment">
        <RouteShell>
          <QRPayment />
        </RouteShell>
      </Route>
      <Route path="/qr-device">
        <RouteShell>
          <QRDeviceRegistration />
        </RouteShell>
      </Route>
      <Route path="/qr-scanner">
        <RouteShell>
          <QRScanner />
        </RouteShell>
      </Route>
      <Route path="/qr-generator">
        <RouteShell>
          <QRGenerator />
        </RouteShell>
      </Route>
      <Route path="/qr-history" component={QRHistory} />
      <Route path="/analytics" component={UserAnalyticsDashboard} />
      <Route path="/referrals">
        <RouteShell>
          <Referrals />
        </RouteShell>
      </Route>
      <Route path="/referral-leaderboard">
        <RouteShell>
          <ReferralLeaderboard />
        </RouteShell>
      </Route>
      <Route path="/biometric-settings">
        <RouteShell>
          <BiometricSettings />
        </RouteShell>
      </Route>
      <Route path={"/demand-response"}>
        <RouteShell>
          <DemandResponse />
        </RouteShell>
      </Route>
      <Route path="/admin">
        <RouteShell adminOnly chrome={false}>
          <AdminDashboard />
        </RouteShell>
      </Route>
      <Route path="/admin/users">
        <RouteShell adminOnly chrome={false}>
          <UserManagement />
        </RouteShell>
      </Route>
      <Route path="/admin/assets">
        <RouteShell adminOnly chrome={false}>
          <AssetApproval />
        </RouteShell>
      </Route>
      <Route path="/admin/pricing">
        <RouteShell adminOnly chrome={false}>
          <MarketPricing />
        </RouteShell>
      </Route>
      <Route path="/admin/devices">
        <RouteShell adminOnly>
          <DeviceManagement />
        </RouteShell>
      </Route>
      <Route path="/admin/demand-response">
        <RouteShell adminOnly>
          <DRManagement />
        </RouteShell>
      </Route>
      <Route path="/admin/payment-credentials">
        <RouteShell adminOnly chrome={false}>
          <PaymentCredentials />
        </RouteShell>
      </Route>
      <Route path="/admin/analytics">
        <RouteShell adminOnly>
          <AdminAnalytics />
        </RouteShell>
      </Route>
      <Route path="/admin/analytics-dashboard">
        <RouteShell adminOnly chrome={false}>
          <AnalyticsDashboard />
        </RouteShell>
      </Route>
      <Route path="/admin/reconciliation">
        <RouteShell adminOnly>
          <ReconciliationDashboard />
        </RouteShell>
      </Route>
      <Route path="/admin/ledger">
        <RouteShell adminOnly chrome={false}>
          <LedgerReconciliation />
        </RouteShell>
      </Route>
      <Route path="/admin/event-stream">
        <RouteShell adminOnly chrome={false}>
          <EventStream />
        </RouteShell>
      </Route>
      <Route path="/admin/lakehouse">
        <RouteShell adminOnly chrome={false}>
          <Lakehouse />
        </RouteShell>
      </Route>
      <Route path="/admin/model-health">
        <RouteShell adminOnly chrome={false}>
          <ModelHealth />
        </RouteShell>
      </Route>
      <Route path="/admin/diagnostics">
        <RouteShell adminOnly chrome={false}>
          <Diagnostics />
        </RouteShell>
      </Route>
      <Route path="/admin/cache-monitoring">
        <RouteShell adminOnly>
          <CacheMonitoring />
        </RouteShell>
      </Route>
      <Route path="/admin/audit-logs">
        <RouteShell adminOnly>
          <AuditLogs />
        </RouteShell>
      </Route>
      <Route path="/admin/ml-predictions">
        <RouteShell adminOnly>
          <MLPredictions />
        </RouteShell>
      </Route>
      <Route path="/admin/workflows">
        <RouteShell adminOnly>
          <WorkflowMonitoring />
        </RouteShell>
      </Route>
      <Route path="/admin/grid-operator">
        <RouteShell adminOnly>
          <GridOperator />
        </RouteShell>
      </Route>
      <Route path="/admin/performance">
        <RouteShell adminOnly>
          <PerformanceDashboard />
        </RouteShell>
      </Route>
      <Route path="/admin/iot-devices">
        <RouteShell adminOnly>
          <IoTDeviceMonitoring />
        </RouteShell>
      </Route>
      <Route path="/leaderboard">
        <RouteShell>
          <Leaderboard />
        </RouteShell>
      </Route>
      <Route path="/insights/advisor" component={EnergyAdvisor} />
      <Route path="/insights/solar-yield" component={SolarYield} />
      <Route path="/insights/battery-health" component={BatteryHealth} />
      <Route path="/insights/carbon" component={CarbonCredits} />
      <Route path="/market/tariffs" component={Tariffs} />
      <Route path="/market/order-book" component={OrderBook} />
      <Route path="/wallet" component={Wallet} />
      <Route path="/v2g" component={V2G} />
      <Route path="/grid/anomalies" component={GridAnomalies} />
      <Route path="/grid/control-windows" component={ControlWindows} />
      <Route path="/grid/forecast-accuracy" component={ForecastAccuracy} />
      <Route path="/grid/price-signals" component={PriceSignals} />
      <Route path="/grid/fleet-telemetry" component={FleetTelemetry} />
      <Route path="/digital-twin" component={DigitalTwin} />
      <Route path="/grid/operations-wall">
        <RouteShell adminOnly chrome={false}>
          <OperationsWall />
        </RouteShell>
      </Route>
      <Route path="/grid/matter-loads" component={MatterLoads} />
      <Route path="/grid/degraded-operation" component={DegradedOperation} />
      <Route path="/grid/locational-flexibility" component={LocationalFlexibility} />
      <Route path="/grid/network-feasibility" component={NetworkFeasibility} />
      <Route path="/grid/protocol-conformance" component={ProtocolConformance} />
      <Route path="/grid/design-studies" component={DesignStudy} />
      <Route path="/grid/dr-forecast" component={DRForecast} />
      <Route path="/grid/ntl" component={NtlDashboard} />
      <Route path="/grid/compliance-reports" component={ComplianceReports} />
      <Route path="/community-pools" component={CommunityPools} />
      <Route path="/community/resilience" component={MicrogridResilience} />
      <Route path="/money/prepaid" component={PrepaidEnergy} />
      <Route path="/sms-center" component={SmsCenter} />
      <Route path="/energy-analytics" component={Analytics} />
      <Route path="/404" component={NotFound} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <Toaster />
          <PWAInstallPrompt />
          <PWAInstallBanner />
          <OfflineIndicator />
          <Suspense fallback={<RouteLoading />}>
            <Router />
          </Suspense>
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
