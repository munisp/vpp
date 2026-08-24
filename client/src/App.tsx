import { Toaster } from "@/components/ui/sonner";
import { PWAInstallPrompt } from "./components/PWAInstallPrompt";
import { PWAInstallBanner } from "./components/PWAInstallBanner";
import { OfflineIndicator } from "./components/OfflineIndicator";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import EnergyInsights from "@/pages/EnergyInsights";
import DRAutomation from "@/pages/admin/DRAutomation";
import WebhookConfig from "@/pages/admin/WebhookConfig";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { RouteShell } from "./components/RouteShell";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";
import Assets from "./pages/Assets";
import Monitoring from "./pages/Monitoring";
import Trading from "./pages/Trading";
import Billing from "./pages/Billing";
import Payments from "./pages/Payments";
import Alerts from "./pages/Alerts";
import Settings from "@/pages/Settings";
import DemandResponse from "@/pages/DemandResponse";
import AdminDashboard from "./pages/admin/AdminDashboard";
import UserManagement from "./pages/admin/UserManagement";
import AssetApproval from "./pages/admin/AssetApproval";
import MarketPricing from "./pages/admin/MarketPricing";
import DeviceManagement from "./pages/admin/DeviceManagement";
import DRManagement from "./pages/admin/DRManagement";
import PaymentCredentials from "./pages/admin/PaymentCredentials";
import AdminAnalytics from "./pages/admin/AdminAnalytics";
import AnalyticsDashboard from "./pages/admin/AnalyticsDashboard";
import ReconciliationDashboard from "./pages/admin/ReconciliationDashboard";
import Leaderboard from "./pages/Leaderboard";
import Analytics from "./pages/Analytics";
import CacheMonitoring from "./pages/admin/CacheMonitoring";
import AuditLogs from "./pages/admin/AuditLogs";
import MLPredictions from "./pages/admin/MLPredictions";
import WorkflowMonitoring from "./pages/admin/WorkflowMonitoring";
import GridOperator from "./pages/admin/GridOperator";
import PerformanceDashboard from "./pages/admin/PerformanceDashboard";
import IoTDeviceMonitoring from "./pages/admin/IoTDeviceMonitoring";
import NotificationSettings from "@/pages/NotificationSettings";
import TradingStrategies from "@/pages/TradingStrategies";
import StrategyTemplates from "@/pages/StrategyTemplates";
import PriceAlerts from "@/pages/PriceAlerts";
import StrategyComparison from "@/pages/StrategyComparison";
import QRPayment from "./pages/QRPayment";
import QRDeviceRegistration from "./pages/QRDeviceRegistration";
import Referrals from "./pages/Referrals";
import QRScanner from "./pages/QRScanner";
import BiometricSettings from "./pages/BiometricSettings";
import QRGenerator from "./pages/QRGenerator";
import ReferralLeaderboard from "./pages/ReferralLeaderboard";
import QRHistory from "@/pages/QRHistory";
import UserAnalyticsDashboard from "@/pages/AnalyticsDashboard";
import EnergyAdvisor from "@/pages/EnergyAdvisor";
import Tariffs from "@/pages/Tariffs";
import BatteryHealth from "@/pages/BatteryHealth";
import OrderBook from "@/pages/OrderBook";
import CarbonCredits from "@/pages/CarbonCredits";
import GridAnomalies from "@/pages/GridAnomalies";
import ControlWindows from "@/pages/ControlWindows";
import ForecastAccuracy from "@/pages/ForecastAccuracy";
import PriceSignals from "@/pages/PriceSignals";
import FleetTelemetry from "@/pages/FleetTelemetry";
import DigitalTwin from "@/pages/DigitalTwin";
import OperationsWall from "@/pages/OperationsWall";
import MatterLoads from "@/pages/MatterLoads";
import DegradedOperation from "@/pages/DegradedOperation";
import LedgerReconciliation from "@/pages/LedgerReconciliation";
import EventStream from "@/pages/EventStream";
import Lakehouse from "@/pages/Lakehouse";
import ModelHealth from "@/pages/ModelHealth";
import Diagnostics from "@/pages/Diagnostics";
import LocationalFlexibility from "@/pages/LocationalFlexibility";
import NetworkFeasibility from "@/pages/NetworkFeasibility";
import ProtocolConformance from "@/pages/ProtocolConformance";
import DesignStudy from "@/pages/DesignStudy";
import V2G from "@/pages/V2G";
import Wallet from "@/pages/Wallet";
import CommunityPools from "@/pages/CommunityPools";
import MicrogridResilience from "@/pages/MicrogridResilience";
import PrepaidEnergy from "@/pages/PrepaidEnergy";
import DRForecast from "@/pages/DRForecast";
import SmsCenter from "@/pages/SmsCenter";
import SolarYield from "@/pages/SolarYield";
import NtlDashboard from "@/pages/NtlDashboard";
import ComplianceReports from "@/pages/ComplianceReports";

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
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
