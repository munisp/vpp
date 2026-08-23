import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useAuth } from '../contexts/AuthContext';
import { trpc } from '../services/trpc';
import { ActivityIndicator, Text, View, StyleSheet } from 'react-native';

// Import screens
import LoginScreen from '../screens/LoginScreen';
import DashboardScreen from '../screens/DashboardScreen';
import AssetsScreen from '../screens/AssetsScreen';
import MonitoringScreen from '../screens/MonitoringScreen';
import TradingScreen from '../screens/TradingScreen';
import PaymentsScreen from '../screens/PaymentsScreen';
import DRParticipationScreen from '../screens/DRParticipationScreen';
import SettingsScreen from '../screens/SettingsScreen';
import QRPaymentScreen from '../screens/QRPaymentScreen';
import QRDeviceRegistrationScreen from '../screens/QRDeviceRegistrationScreen';
import GamificationScreen from '../screens/GamificationScreen';
import P2PTradingScreen from '../screens/P2PTradingScreen';
import TradingStrategiesScreen from '../screens/TradingStrategiesScreen';
import AdminAnalyticsScreen from '../screens/AdminAnalyticsScreen';
import AuditLogsScreen from '../screens/AuditLogsScreen';
import NotificationSettingsScreen from '../screens/NotificationSettingsScreen';
import OnboardingScreen from '../screens/OnboardingScreen';
import WorkflowMonitorScreen from '../screens/WorkflowMonitorScreen';
import WalletScreen from '../screens/WalletScreen';
import AdvisorScreen from '../screens/AdvisorScreen';
import CarbonScreen from '../screens/CarbonScreen';
import BatteryHealthScreen from '../screens/BatteryHealthScreen';
import SolarYieldScreen from '../screens/SolarYieldScreen';
import PriceAlertsScreen from '../screens/PriceAlertsScreen';
import OrderBookScreen from '../screens/OrderBookScreen';
import ControlWindowsScreen from '../screens/ControlWindowsScreen';
import ForecastAccuracyScreen from '../screens/ForecastAccuracyScreen';
import PriceSignalsScreen from '../screens/PriceSignalsScreen';
import CommunityTelemetryScreen from '../screens/CommunityTelemetryScreen';
import DigitalTwinScreen from '../screens/DigitalTwinScreen';
import LocationalFlexibilityScreen from '../screens/LocationalFlexibilityScreen';
import MatterLoadsScreen from '../screens/MatterLoadsScreen';
import ServiceStatusScreen from '../screens/ServiceStatusScreen';
import LedgerReconciliationScreen from '../screens/LedgerReconciliationScreen';
import LakehouseScreen from '../screens/LakehouseScreen';

const Stack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();

function MainTabs() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: '#10b981',
        tabBarInactiveTintColor: '#6b7280',
        tabBarStyle: {
          paddingBottom: 8,
          paddingTop: 8,
          height: 60,
        },
      }}
    >
      <Tab.Screen
        name="Dashboard"
        component={DashboardScreen}
        options={{
          tabBarLabel: 'Home',
          tabBarIcon: ({ color }) => <TabIcon icon="🏠" color={color} />,
        }}
      />
      <Tab.Screen
        name="Assets"
        component={AssetsScreen}
        options={{
          tabBarLabel: 'Assets',
          tabBarIcon: ({ color }) => <TabIcon icon="⚡" color={color} />,
        }}
      />
      <Tab.Screen
        name="Monitoring"
        component={MonitoringScreen}
        options={{
          tabBarLabel: 'Monitor',
          tabBarIcon: ({ color }) => <TabIcon icon="📊" color={color} />,
        }}
      />
      <Tab.Screen
        name="Trading"
        component={TradingScreen}
        options={{
          tabBarLabel: 'Trade',
          tabBarIcon: ({ color }) => <TabIcon icon="💱" color={color} />,
        }}
      />
      <Tab.Screen
        name="DR"
        component={DRParticipationScreen}
        options={{
          tabBarLabel: 'DR',
          tabBarIcon: ({ color }) => <TabIcon icon="🎯" color={color} />,
        }}
      />
    </Tab.Navigator>
  );
}

function TabIcon({ icon, color }: { icon: string; color: string }) {
  return (
    <View style={styles.tabIcon}>
      <Text style={{ fontSize: 24, color }}>{icon}</Text>
    </View>
  );
}

export default function AppNavigator() {
  const { user, loading } = useAuth();

  // Onboarding completion is a real server-side signal
  // (server/routers/onboarding.ts -> getStatus, backed by the
  // users.onboardingCompleted column). Logged-in users who have not
  // completed onboarding are routed to the Onboarding screen first.
  const { data: onboardingStatus, isLoading: onboardingLoading } =
    trpc.onboarding.getStatus.useQuery(undefined, {
      enabled: !!user,
      retry: 1,
    });

  if (loading || (!!user && onboardingLoading)) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color="#10b981" />
      </View>
    );
  }

  // If the status query fails, fall back to the main app rather than
  // trapping the user on a spinner.
  const needsOnboarding =
    !!user && onboardingStatus != null && onboardingStatus.completed === false;

  return (
    <NavigationContainer>
      <Stack.Navigator
        screenOptions={{ headerShown: false }}
        initialRouteName={
          !user ? 'Login' : needsOnboarding ? 'Onboarding' : 'Main'
        }
      >
        {!user ? (
          <Stack.Screen name="Login" component={LoginScreen} />
        ) : (
          <>
            <Stack.Screen name="Main" component={MainTabs} />
            <Stack.Screen name="Payments" component={PaymentsScreen} />
            <Stack.Screen name="Settings" component={SettingsScreen} />
            <Stack.Screen name="QRPayment" component={QRPaymentScreen} />
            <Stack.Screen name="QRDeviceRegistration" component={QRDeviceRegistrationScreen} />
            <Stack.Screen name="Gamification" component={GamificationScreen} />
            <Stack.Screen name="P2PTrading" component={P2PTradingScreen} />
            <Stack.Screen name="TradingStrategies" component={TradingStrategiesScreen} />
      <Stack.Screen name="AdminAnalytics" component={AdminAnalyticsScreen} />
      <Stack.Screen name="AuditLogs" component={AuditLogsScreen} />
      <Stack.Screen name="NotificationSettings" component={NotificationSettingsScreen} />
      <Stack.Screen name="Onboarding" component={OnboardingScreen} />
      <Stack.Screen name="WorkflowMonitor" component={WorkflowMonitorScreen} />
      <Stack.Screen name="Wallet" component={WalletScreen} />
      <Stack.Screen name="Advisor" component={AdvisorScreen} />
      <Stack.Screen name="Carbon" component={CarbonScreen} />
      <Stack.Screen name="BatteryHealth" component={BatteryHealthScreen} />
      <Stack.Screen name="SolarYield" component={SolarYieldScreen} />
      <Stack.Screen name="PriceAlerts" component={PriceAlertsScreen} />
      <Stack.Screen name="OrderBook" component={OrderBookScreen} />
      <Stack.Screen name="ControlWindows" component={ControlWindowsScreen} />
      <Stack.Screen name="ForecastAccuracy" component={ForecastAccuracyScreen} />
      <Stack.Screen name="PriceSignals" component={PriceSignalsScreen} />
      <Stack.Screen name="CommunityTelemetry" component={CommunityTelemetryScreen} />
      <Stack.Screen name="DigitalTwin" component={DigitalTwinScreen} />
      <Stack.Screen name="LocationalFlexibility" component={LocationalFlexibilityScreen} />
      <Stack.Screen name="MatterLoads" component={MatterLoadsScreen} />
      <Stack.Screen name="ServiceStatus" component={ServiceStatusScreen} />
      <Stack.Screen name="LedgerReconciliation" component={LedgerReconciliationScreen} />
      <Stack.Screen name="Lakehouse" component={LakehouseScreen} />
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f0fdf4',
  },
  tabIcon: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
