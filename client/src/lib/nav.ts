export type NavItem = {
  label: string;
  path: string;
  /** Keywords the quick filter matches in addition to the label. */
  keywords?: string[];
  adminOnly?: boolean;
};

export type NavGroup = {
  /** Stable key used to persist the expanded/collapsed state. */
  id: string;
  label: string;
  items: NavItem[];
  /** Pinned groups are always shown expanded and cannot be collapsed. */
  pinned?: boolean;
  adminOnly?: boolean;
};

/**
 * The route tree, independent of icons and of the sidebar's rendering, so the
 * grouping and the role filter can be tested without a DOM. Only `primary` is
 * pinned open: every other group collapses, which is what keeps the sidebar
 * from scrolling.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'primary',
    label: 'Overview',
    pinned: true,
    items: [
      { label: 'Dashboard', path: '/', keywords: ['home', 'overview'] },
      { label: 'My Assets', path: '/assets', keywords: ['battery', 'solar', 'device'] },
      { label: 'Monitoring', path: '/monitoring', keywords: ['telemetry', 'live'] },
      { label: 'Trading', path: '/trading', keywords: ['market', 'sell', 'buy'] },
      { label: 'Billing', path: '/billing', keywords: ['invoice'] },
      { label: 'Alerts', path: '/alerts', keywords: ['notification'] },
    ],
  },
  {
    id: 'energy',
    label: 'Energy & insights',
    items: [
      { label: 'Energy Insights', path: '/energy-insights' },
      { label: 'Energy Analytics', path: '/energy-analytics' },
      { label: 'Analytics', path: '/analytics', keywords: ['reports'] },
      { label: 'Energy Advisor', path: '/insights/advisor', keywords: ['recommendation'] },
      { label: 'Solar Yield', path: '/insights/solar-yield', keywords: ['pv'] },
      { label: 'Battery Health', path: '/insights/battery-health', keywords: ['soh', 'degradation'] },
      { label: 'Carbon Credits', path: '/insights/carbon', keywords: ['co2', 'emissions'] },
    ],
  },
  {
    id: 'market',
    label: 'Market',
    items: [
      { label: 'Order Book', path: '/market/order-book', keywords: ['p2p', 'bids', 'settlement'] },
      { label: 'Tariffs', path: '/market/tariffs', keywords: ['price', 'rate'] },
      { label: 'Price Alerts', path: '/trading/price-alerts' },
      { label: 'Trading Strategies', path: '/trading/strategies' },
      { label: 'Strategy Templates', path: '/trading/templates' },
      { label: 'Strategy Comparison', path: '/trading/comparison', keywords: ['backtest'] },
    ],
  },
  {
    id: 'money',
    label: 'Money',
    items: [
      { label: 'Payments', path: '/payments', keywords: ['mpesa', 'gateway'] },
      {
        label: 'Prepaid Energy',
        path: '/money/prepaid',
        keywords: ['payg', 'token', 'openpaygo', 'meter', 'credit', 'vend'],
      },
      { label: 'Wallet', path: '/wallet', keywords: ['balance', 'topup'] },
      { label: 'QR Payment', path: '/qr-payment', keywords: ['scan', 'pay'] },
      { label: 'Referrals', path: '/referrals', keywords: ['invite'] },
    ],
  },
  {
    id: 'grid',
    label: 'Grid operations',
    items: [
      { label: 'Digital Twin', path: '/digital-twin', keywords: ['diagram', 'flow'] },
      { label: 'Control Windows', path: '/grid/control-windows', keywords: ['setpoint', 'dispatch'] },
      { label: 'Demand Response', path: '/demand-response', keywords: ['dr', 'event'] },
      { label: 'V2G Optimizer', path: '/v2g', keywords: ['vehicle', 'ev', 'charging'] },
      { label: 'Price Signals', path: '/grid/price-signals', keywords: ['coordination'] },
      { label: 'Locational Flexibility', path: '/grid/locational-flexibility', keywords: ['feeder', 'node'] },
      {
        label: 'Network Feasibility',
        path: '/grid/network-feasibility',
        adminOnly: true,
        keywords: ['power flow', 'hosting capacity', 'transformer', 'impedance', 'connection', 'pandapower'],
      },
      {
        label: 'Design Studies',
        path: '/grid/design-studies',
        adminOnly: true,
        keywords: ['sizing', 'lcoe', 'payback', 'techno-economic', 'feasibility study', 'minigrid', 'planning', 'capex'],
      },
      { label: 'Forecast Accuracy', path: '/grid/forecast-accuracy', keywords: ['mape', 'variance'] },
      { label: 'Anomalies', path: '/grid/anomalies' },
      { label: 'DR Forecast', path: '/grid/dr-forecast' },
      { label: 'Fleet Telemetry', path: '/grid/fleet-telemetry', adminOnly: true, keywords: ['aggregate', 'coverage'] },
      { label: 'Smart-Home Loads', path: '/grid/matter-loads', adminOnly: true, keywords: ['matter'] },
      { label: 'Degraded Operation', path: '/grid/degraded-operation', adminOnly: true, keywords: ['outage', 'offline'] },
      { label: 'NTL Detection', path: '/grid/ntl', adminOnly: true, keywords: ['theft', 'loss'] },
      { label: 'Compliance Reports', path: '/grid/compliance-reports', adminOnly: true },
    ],
  },
  {
    id: 'operations',
    label: 'Operations centre',
    adminOnly: true,
    items: [{ label: 'Operations Wall', path: '/grid/operations-wall', adminOnly: true, keywords: ['noc', 'soc', 'wall'] }],
  },
  {
    id: 'community',
    label: 'Community',
    items: [
      { label: 'Community Pools', path: '/community-pools' },
      {
        label: 'Microgrid Resilience',
        path: '/community/resilience',
        keywords: ['island', 'autonomy', 'critical', 'backup', 'outage', 'clinic'],
      },
      { label: 'Leaderboard', path: '/leaderboard', keywords: ['ranking'] },
      { label: 'Referral Leaderboard', path: '/referral-leaderboard' },
      { label: 'SMS Center', path: '/sms-center', keywords: ['message'] },
    ],
  },
  {
    id: 'tools',
    label: 'Tools & account',
    items: [
      { label: 'QR Scanner', path: '/qr-scanner' },
      { label: 'QR Generator', path: '/qr-generator' },
      { label: 'QR History', path: '/qr-history' },
      { label: 'Register Device', path: '/qr-device', keywords: ['commission'] },
      { label: 'Settings', path: '/settings', keywords: ['profile', 'preferences'] },
      { label: 'Notification Settings', path: '/notifications', keywords: ['push', 'email'] },
      { label: 'Biometric Sign-in', path: '/biometric-settings', keywords: ['passkey', 'webauthn'] },
    ],
  },
  {
    // These pages existed but were reachable only from inside the admin
    // dashboard or by typing the URL.
    id: 'admin',
    label: 'Administration',
    adminOnly: true,
    items: [
      { label: 'Admin Home', path: '/admin', adminOnly: true },
      { label: 'Users', path: '/admin/users', adminOnly: true },
      { label: 'Asset Approval', path: '/admin/assets', adminOnly: true },
      { label: 'Market Pricing', path: '/admin/pricing', adminOnly: true },
      { label: 'Devices', path: '/admin/devices', adminOnly: true },
      { label: 'IoT Devices', path: '/admin/iot-devices', adminOnly: true },
      { label: 'DR Management', path: '/admin/demand-response', adminOnly: true },
      { label: 'DR Automation', path: '/admin/dr-automation', adminOnly: true },
      { label: 'Grid Operator', path: '/admin/grid-operator', adminOnly: true },
      { label: 'Payment Credentials', path: '/admin/payment-credentials', adminOnly: true },
      { label: 'Reconciliation', path: '/admin/reconciliation', adminOnly: true, keywords: ['settlement'] },
      { label: 'Ledger Reconciliation', path: '/admin/ledger', adminOnly: true, keywords: ['double entry', 'tigerbeetle', 'balance'] },
      { label: 'Event Stream', path: '/admin/event-stream', adminOnly: true, keywords: ['kafka', 'outbox', 'dead letter', 'topics'] },
      { label: 'Lakehouse', path: '/admin/lakehouse', adminOnly: true, keywords: ['etl', 'parquet', 'ingestion', 'analytics', 'watermark'] },
      { label: 'Model Health', path: '/admin/model-health', adminOnly: true, keywords: ['ml', 'pytorch', 'gnn', 'training', 'drift', 'provenance', 'checkpoint', 'synthetic'] },
      { label: 'Diagnostics', path: '/admin/diagnostics', adminOnly: true, keywords: ['ollama', 'local llm', 'ai', 'troubleshoot', 'root cause', 'evidence'] },
      { label: 'Webhook Config', path: '/admin/webhook-config', adminOnly: true, keywords: ['callback'] },
      { label: 'Admin Analytics', path: '/admin/analytics', adminOnly: true },
      { label: 'Analytics Dashboard', path: '/admin/analytics-dashboard', adminOnly: true },
      { label: 'ML Predictions', path: '/admin/ml-predictions', adminOnly: true },
      { label: 'Workflows', path: '/admin/workflows', adminOnly: true, keywords: ['temporal'] },
      { label: 'Audit Logs', path: '/admin/audit-logs', adminOnly: true },
      { label: 'Cache Monitoring', path: '/admin/cache-monitoring', adminOnly: true, keywords: ['redis'] },
      { label: 'Performance', path: '/admin/performance', adminOnly: true },
    ],
  },
];

/**
 * Drops admin-only groups and items for anyone who is not an admin. A group
 * whose every item is filtered out disappears rather than rendering an empty,
 * clickable heading.
 */
export function getNavGroups(userRole?: string): NavGroup[] {
  const isAdmin = userRole === 'admin';
  return NAV_GROUPS.map(group => ({
    ...group,
    items: group.items.filter(item => isAdmin || !item.adminOnly),
  })).filter(group => (isAdmin || !group.adminOnly) && group.items.length > 0);
}

export function findNavItem(groups: NavGroup[], path: string): NavItem | undefined {
  for (const group of groups) {
    const item = group.items.find(candidate => candidate.path === path);
    if (item) return item;
  }
  return undefined;
}

/** The group that owns `path`, so the sidebar can reveal the current route. */
export function groupIdForPath(groups: NavGroup[], path: string): string | undefined {
  return groups.find(group => group.items.some(item => item.path === path))?.id;
}

export type NavMatch = { groupLabel: string; item: NavItem };

/**
 * Matches the query against labels, keywords and paths. An empty query matches
 * nothing: the caller shows the grouped tree instead of a flat result list.
 */
export function searchNavItems(groups: NavGroup[], query: string): NavMatch[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const matches: NavMatch[] = [];
  for (const group of groups) {
    for (const item of group.items) {
      const haystack = [item.label, item.path, ...(item.keywords ?? [])].join(' ').toLowerCase();
      if (haystack.includes(needle)) matches.push({ groupLabel: group.label, item });
    }
  }
  return matches;
}

const OPEN_GROUPS_KEY = 'sidebar-open-groups';

type MinimalStorage = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * Reads the persisted expanded groups. Unknown ids are dropped so a renamed or
 * removed group cannot resurrect itself, and a corrupt value falls back to the
 * group holding the current route rather than throwing on navigation.
 */
export function readOpenGroups(
  storage: MinimalStorage,
  groups: NavGroup[],
  activePath: string
): string[] {
  // A pinned group is always expanded, so it never takes part in the state.
  const collapsible = groups.filter(group => !group.pinned);
  const fallback = groupIdForPath(collapsible, activePath);
  const known = new Set(collapsible.map(group => group.id));
  let stored: unknown;
  try {
    stored = JSON.parse(storage.getItem(OPEN_GROUPS_KEY) ?? 'null');
  } catch {
    stored = null;
  }
  if (!Array.isArray(stored)) return fallback ? [fallback] : [];
  const open = stored.filter((id): id is string => typeof id === 'string' && known.has(id));
  if (fallback && !open.includes(fallback)) open.push(fallback);
  return open;
}

export function writeOpenGroups(storage: MinimalStorage, openGroupIds: string[]): void {
  try {
    storage.setItem(OPEN_GROUPS_KEY, JSON.stringify(openGroupIds));
  } catch {
    // A full or blocked storage must not break navigation.
  }
}
