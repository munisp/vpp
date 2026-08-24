export type MobileNavItem = {
  /** Route name registered in AppNavigator. */
  screen: string;
  label: string;
  icon: string;
  keywords?: string[];
  adminOnly?: boolean;
};

export type MobileNavGroup = {
  id: string;
  label: string;
  items: MobileNavItem[];
  /** Expanded on first render; the rest start collapsed. */
  defaultOpen?: boolean;
  adminOnly?: boolean;
};

/**
 * The destination list behind the dashboard's navigator. It mirrors the web
 * sidebar's grouping so the two apps describe the platform the same way, and
 * exists as data so the screen renders collapsed sections instead of one grid
 * the user has to scroll past.
 */
export const MOBILE_NAV_GROUPS: MobileNavGroup[] = [
  {
    id: 'primary',
    label: 'Quick actions',
    defaultOpen: true,
    items: [
      { screen: 'Assets', label: 'Assets', icon: '⚡', keywords: ['battery', 'solar'] },
      { screen: 'Trading', label: 'Trade', icon: '💱', keywords: ['market'] },
      { screen: 'Payments', label: 'Payments', icon: '💳', keywords: ['mpesa'] },
      { screen: 'Wallet', label: 'Wallet', icon: '👛', keywords: ['balance'] },
      { screen: 'Settings', label: 'Settings', icon: '⚙️' },
    ],
  },
  {
    id: 'energy',
    label: 'Energy & insights',
    items: [
      { screen: 'Advisor', label: 'Advisor', icon: '🤖', keywords: ['recommendation'] },
      { screen: 'SolarYield', label: 'Solar Yield', icon: '☀️', keywords: ['pv'] },
      { screen: 'BatteryHealth', label: 'Battery', icon: '🔋', keywords: ['soh'] },
      { screen: 'Carbon', label: 'Carbon', icon: '🌱', keywords: ['co2'] },
    ],
  },
  {
    id: 'market',
    label: 'Market',
    items: [
      { screen: 'OrderBook', label: 'Order Book', icon: '📖', keywords: ['settlement', 'fills'] },
      { screen: 'P2PTrading', label: 'P2P Market', icon: '🤝', keywords: ['b2b', 'peer'] },
      { screen: 'PriceAlerts', label: 'Price Alerts', icon: '🔔' },
    ],
  },
  {
    id: 'grid',
    label: 'Grid operations',
    items: [
      { screen: 'DigitalTwin', label: 'Digital Twin', icon: '🕸️', keywords: ['diagram'] },
      { screen: 'ControlWindows', label: 'Controls', icon: '🎛️', keywords: ['setpoint'] },
      { screen: 'PriceSignals', label: 'Price Signals', icon: '🏷️' },
      { screen: 'ForecastAccuracy', label: 'Forecasts', icon: '🎯', keywords: ['mape'] },
      { screen: 'LocationalFlexibility', label: 'Local Grid', icon: '📍', keywords: ['feeder'] },
    ],
  },
  {
    id: 'community',
    label: 'Community & rewards',
    items: [
      { screen: 'CommunityTelemetry', label: 'Community', icon: '👥' },
      {
        screen: 'Resilience',
        label: 'Resilience',
        icon: '🛡️',
        keywords: ['island', 'autonomy', 'critical', 'backup', 'outage', 'clinic'],
      },
      { screen: 'Gamification', label: 'Rewards', icon: '🏆' },
      { screen: 'QRPayment', label: 'QR Payment', icon: '📷' },
      { screen: 'QRDeviceRegistration', label: 'Register Device', icon: '📲' },
      { screen: 'ServiceStatus', label: 'Service Status', icon: '🩺', keywords: ['degraded'] },
      { screen: 'NotificationSettings', label: 'Notifications', icon: '🔔', keywords: ['alerts'] },
    ],
  },
  {
    id: 'admin',
    label: 'Admin tools',
    adminOnly: true,
    items: [
      { screen: 'AdminAnalytics', label: 'Analytics', icon: '📊', adminOnly: true },
      { screen: 'AuditLogs', label: 'Audit Logs', icon: '📝', adminOnly: true },
      { screen: 'TradingStrategies', label: 'Strategies', icon: '⚡', adminOnly: true },
      { screen: 'WorkflowMonitor', label: 'Workflows', icon: '🔄', adminOnly: true },
      { screen: 'MatterLoads', label: 'Home Loads', icon: '🏠', adminOnly: true },
      {
        screen: 'LedgerReconciliation',
        label: 'Ledger',
        icon: '⚖️',
        adminOnly: true,
        keywords: ['balance', 'double entry', 'reconciliation'],
      },
      {
        screen: 'Lakehouse',
        label: 'Lakehouse',
        icon: '🗄️',
        adminOnly: true,
        keywords: ['etl', 'ingestion', 'parquet', 'analytics', 'watermark'],
      },
      {
        screen: 'ModelHealth',
        label: 'Model Health',
        icon: '🧠',
        adminOnly: true,
        keywords: ['ml', 'pytorch', 'gnn', 'training', 'drift', 'provenance', 'checkpoint'],
      },
      {
        screen: 'Diagnostics',
        label: 'Diagnostics',
        icon: '🩺',
        adminOnly: true,
        keywords: ['ollama', 'local llm', 'ai', 'troubleshoot', 'root cause', 'evidence'],
      },
    ],
  },
];

export function getMobileNavGroups(userRole?: string): MobileNavGroup[] {
  const isAdmin = userRole === 'admin';
  return MOBILE_NAV_GROUPS.map(group => ({
    ...group,
    items: group.items.filter(item => isAdmin || !item.adminOnly),
  })).filter(group => (isAdmin || !group.adminOnly) && group.items.length > 0);
}

export type MobileNavMatch = { groupLabel: string; item: MobileNavItem };

export function searchMobileNav(groups: MobileNavGroup[], query: string): MobileNavMatch[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const matches: MobileNavMatch[] = [];
  for (const group of groups) {
    for (const item of group.items) {
      const haystack = [item.label, item.screen, ...(item.keywords ?? [])]
        .join(' ')
        .toLowerCase();
      if (haystack.includes(needle)) matches.push({ groupLabel: group.label, item });
    }
  }
  return matches;
}
