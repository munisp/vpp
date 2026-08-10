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

function Router() {
  return (
    <Switch>
      <Route path={"/"} component={Home} />
      <Route path="/energy-insights" component={EnergyInsights} />
      <Route path="/admin/dr-automation" component={DRAutomation} />
      <Route path="/admin/webhook-config" component={WebhookConfig} />     <Route path="/assets" component={Assets} />
      <Route path="/monitoring" component={Monitoring} />
      <Route path="/trading" component={Trading} />
      <Route path="/billing" component={Billing} />
      <Route path="/payments" component={Payments} />
      <Route path="/alerts" component={Alerts} />
      <Route path={"/settings"} component={Settings} />
      <Route path="/notifications" component={NotificationSettings} />
      <Route path="/notification-settings" component={NotificationSettings} />
      <Route path="/trading/strategies" component={TradingStrategies} />
      <Route path="/trading/templates" component={StrategyTemplates} />
      <Route path="/trading/price-alerts" component={PriceAlerts} />
      <Route path="/trading/comparison" component={StrategyComparison} />
      <Route path="/qr-payment" component={QRPayment} />
      <Route path="/qr-device" component={QRDeviceRegistration} />
      <Route path="/qr-scanner" component={QRScanner} />
      <Route path="/qr-generator" component={QRGenerator} />
      <Route path="/qr-history" component={QRHistory} />
      <Route path="/analytics" component={UserAnalyticsDashboard} />
      <Route path="/referrals" component={Referrals} />
      <Route path="/referral-leaderboard" component={ReferralLeaderboard} />
      <Route path="/biometric-settings" component={BiometricSettings} />
      <Route path={"/demand-response"} component={DemandResponse} />
      <Route path="/admin" component={AdminDashboard} />
      <Route path="/admin/users" component={UserManagement} />
      <Route path="/admin/assets" component={AssetApproval} />
      <Route path="/admin/pricing" component={MarketPricing} />
      <Route path="/admin/devices" component={DeviceManagement} />
      <Route path="/admin/demand-response" component={DRManagement} />
      <Route path="/admin/payment-credentials" component={PaymentCredentials} />
      <Route path="/admin/analytics" component={AdminAnalytics} />
      <Route path="/admin/analytics-dashboard" component={AnalyticsDashboard} />
      <Route path="/admin/reconciliation" component={ReconciliationDashboard} />
      <Route path="/admin/cache-monitoring" component={CacheMonitoring} />
      <Route path="/admin/audit-logs" component={AuditLogs} />
      <Route path="/admin/ml-predictions" component={MLPredictions} />
      <Route path="/admin/workflows" component={WorkflowMonitoring} />
      <Route path="/admin/grid-operator" component={GridOperator} />
      <Route path="/admin/performance" component={PerformanceDashboard} />
      <Route path="/admin/iot-devices" component={IoTDeviceMonitoring} />
      <Route path="/leaderboard" component={Leaderboard} />
      <Route path="/analytics" component={Analytics} />
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
