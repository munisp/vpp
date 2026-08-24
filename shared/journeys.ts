/**
 * Stakeholder journeys: the catalog, plus the pure derivations both apps read.
 *
 * A journey is a named sequence of steps that a real stakeholder performs, run
 * against the platform's own services — not a script written once to produce a
 * screenshot. Each journey is re-runnable on demand or on a schedule, and each
 * step records the evidence it saw, so a journey that passed last week and
 * fails today points at the service that changed.
 *
 * Only metadata lives here: step ids, the services each step calls, the routes
 * it exercises data for, and the external dependencies it needs. The step
 * bodies live in `server/journeys/steps/` because they call server services;
 * keeping the metadata separate is what lets the Temporal workflow, the PWA and
 * the React Native app all read the same catalog.
 */

export type Stakeholder =
  | 'member'
  | 'business'
  | 'grid_operator'
  | 'noc_operator'
  | 'finance'
  | 'data_owner'
  | 'support';

/**
 * Something outside the platform that a step needs. A step whose dependency is
 * unreachable is reported `blocked`, never passed and never failed: the
 * platform cannot be scored on a provider nobody has given it credentials for.
 */
export type ExternalDependency =
  | 'mobile_money'
  | 'payout_provider'
  | 'ocpp_station'
  | 'matter_controller'
  | 'mqtt_broker'
  | 'kafka_broker'
  | 'object_store'
  | 'ollama'
  | 'ray_cluster'
  | 'sms_gateway'
  | 'smtp'
  | 'ledger'
  | 'temporal';

export const EXTERNAL_DEPENDENCY_LABELS: Record<ExternalDependency, string> = {
  mobile_money: 'Mobile-money gateway (M-Pesa / Airtel / Tigo)',
  payout_provider: 'Seller payout provider',
  ocpp_station: 'OCPP charge point',
  matter_controller: 'Matter controller',
  mqtt_broker: 'MQTT broker',
  kafka_broker: 'Kafka broker',
  object_store: 'S3/MinIO object store',
  ollama: 'Ollama server with a pulled model',
  ledger: 'TigerBeetle double-entry ledger',
  temporal: 'Temporal server',
  ray_cluster: 'Ray cluster',
  sms_gateway: 'SMS gateway',
  smtp: 'SMTP server',
};

/**
 * `passed`  — the step ran and the evidence was what the journey requires.
 * `refused` — the platform declined on evidence it does not have, which is the
 *             designed behaviour; the journey continues and still passes.
 * `blocked` — an external dependency is unavailable, so nothing was proven.
 * `failed`  — a defect: the service errored, or returned something the
 *             stakeholder cannot act on.
 */
export type StepOutcome = 'passed' | 'refused' | 'blocked' | 'failed';

export type JourneyStepMeta = {
  id: string;
  title: string;
  /** Existing services the step calls, as `router.procedure` or module names. */
  services: string[];
  /** Routes whose data this step exercises, from the web navigation. */
  navPaths: string[];
  /** Screens in the React Native app that read the same services. */
  mobileScreens?: string[];
  /** Which principal performs the step. */
  acting: 'member' | 'admin';
  /** Writes platform state. Journeys are re-runnable, so writes are repeatable. */
  mutates?: boolean;
  requires?: ExternalDependency[];
};

export type JourneyMeta = {
  id: string;
  title: string;
  stakeholder: Stakeholder;
  /** What the stakeholder is trying to achieve, in their own terms. */
  intent: string;
  steps: JourneyStepMeta[];
};

const member = 'member' as const;
const admin = 'admin' as const;

export const JOURNEYS: JourneyMeta[] = [
  {
    id: 'member-onboarding',
    title: 'A household joins the VPP and gets its first asset approved',
    stakeholder: 'member',
    intent:
      'Register, declare a solar asset, commission it by QR, and have an operator approve it before it can earn.',
    steps: [
      {
        id: 'onboarding-status',
        title: 'Read the onboarding checklist and the account profile',
        services: ['onboarding.getStatus', 'assets.list'],
        navPaths: ['/', '/settings'],
        mobileScreens: ['Settings'],
        acting: member,
      },
      {
        id: 'register-asset',
        title: 'Declare a solar asset',
        services: ['assets.register', 'assets.list', 'assets.getById'],
        navPaths: ['/assets'],
        mobileScreens: ['Assets'],
        acting: member,
        mutates: true,
      },
      {
        id: 'commission-by-qr',
        title: 'Commission the asset from a QR code and keep the scan history',
        services: [
          'qrcode.generate',
          'qrcode.parse',
          'qrHistory.recordGeneration',
          'qrHistory.getMyHistory',
        ],
        navPaths: ['/qr-generator', '/qr-scanner', '/qr-device', '/qr-history'],
        mobileScreens: ['QRDeviceRegistration'],
        acting: member,
        mutates: true,
      },
      {
        id: 'operator-approval',
        title: 'An operator finds the pending asset and approves it',
        services: ['admin.getPendingAssets', 'admin.approveAsset', 'admin.getSystemStats'],
        navPaths: ['/admin', '/admin/assets'],
        acting: admin,
        mutates: true,
      },
      {
        id: 'user-directory',
        title: 'The new member appears in the operator directory',
        services: ['admin.getUsers'],
        navPaths: ['/admin/users'],
        acting: admin,
      },
      {
        id: 'contact-preferences',
        title: 'Choose how the platform is allowed to reach the member',
        services: [
          'notificationPreferences.get',
          'notificationPreferences.update',
          'notifications.getPushStatus',
          'biometric.getMyCredentials',
        ],
        navPaths: ['/notifications', '/biometric-settings'],
        mobileScreens: ['NotificationSettings'],
        acting: member,
        mutates: true,
      },
    ],
  },
  {
    id: 'prosumer-daily-monitoring',
    title: 'A prosumer watches their own generation through the day',
    stakeholder: 'member',
    intent:
      'See live telemetry, follow it through the digital twin, and be alerted when an asset stops reporting.',
    steps: [
      {
        id: 'ingest-and-read-telemetry',
        title: 'A reading arrives and is readable back at the same scale',
        services: ['telemetry.insert', 'telemetry.getLatest', 'telemetry.getHistorical'],
        navPaths: ['/monitoring'],
        acting: member,
        mutates: true,
      },
      {
        id: 'own-digital-twin',
        title: 'The twin renders the member’s own assets and says what it does not know',
        services: ['digitalTwin.mine'],
        navPaths: ['/digital-twin'],
        mobileScreens: ['DigitalTwin'],
        acting: member,
      },
      {
        id: 'raise-and-clear-alert',
        title: 'Raise an alert, see it unread, then clear it',
        services: ['alerts.create', 'alerts.list', 'alerts.markAsRead'],
        navPaths: ['/alerts'],
        acting: member,
        mutates: true,
      },
      {
        id: 'dashboard-rollup',
        title: 'The dashboard totals agree with the assets behind them',
        services: ['analytics.getSystemStats', 'analytics.getEnergyFlow'],
        navPaths: ['/'],
        acting: member,
      },
    ],
  },
  {
    id: 'insights-and-sustainability',
    title: 'A household acts on its own energy insights',
    stakeholder: 'member',
    intent:
      'Get advice worth acting on, check the panels and the battery are healthy, and see the carbon position.',
    steps: [
      {
        id: 'advisor-recommendations',
        title: 'Advice that names the reading behind it',
        services: ['energyAdvisor.getRecommendations', 'energyAdvisor.getWeeklyDigest'],
        navPaths: ['/insights/advisor', '/energy-insights'],
        mobileScreens: ['Advisor'],
        acting: member,
      },
      {
        id: 'solar-performance',
        title: 'Yield forecast and performance ratio for the declared array',
        services: ['solarYield.getYieldForecast', 'solarYield.getPerformanceRatio'],
        navPaths: ['/insights/solar-yield'],
        mobileScreens: ['SolarYield'],
        acting: member,
      },
      {
        id: 'battery-health',
        title: 'State of health, or an explicit unknown',
        services: ['batteryHealth.getBatteryHealth', 'batteryHealth.getSnapshotHistory'],
        navPaths: ['/insights/battery-health'],
        mobileScreens: ['BatteryHealth'],
        acting: member,
      },
      {
        id: 'carbon-position',
        title: 'Carbon summary and any certificates held',
        services: ['carbonCredits.getMyCarbonSummary', 'carbon.getUserCredits'],
        navPaths: ['/insights/carbon'],
        mobileScreens: ['Carbon'],
        acting: member,
      },
      {
        id: 'personal-analytics',
        title: 'Personal analytics and a downloadable statement',
        services: [
          'analytics.getRevenue',
          'participantInsights.getOverallStats',
          'export.energyCSV',
        ],
        navPaths: ['/energy-analytics', '/analytics'],
        acting: member,
      },
    ],
  },
  {
    id: 'p2p-neighbour-trade',
    title: 'A neighbour sells surplus to another household',
    stakeholder: 'member',
    intent:
      'Put surplus on the order book, match a counterparty, and only settle on delivered energy that was paid for.',
    steps: [
      {
        id: 'read-order-book',
        title: 'Read the order book and the market price it clears against',
        services: ['p2pMatching.getOrderBook', 'trading.getMarketPrices'],
        navPaths: ['/market/order-book', '/trading'],
        mobileScreens: ['OrderBook', 'Trading'],
        acting: member,
      },
      {
        id: 'submit-order',
        title: 'Submit a sell order and find it in the member’s own orders',
        services: ['p2pMatching.submitOrder', 'p2pMatching.getMyOrders'],
        navPaths: ['/market/order-book'],
        acting: member,
        mutates: true,
      },
      {
        id: 'offer-and-withdraw',
        title: 'Publish a direct offer, then withdraw it',
        services: ['p2pTrading.createOffer', 'p2pTrading.getMyOffers', 'p2pTrading.cancelOffer'],
        navPaths: ['/trading'],
        mobileScreens: ['P2PTrading'],
        acting: member,
        mutates: true,
      },
      {
        id: 'settlement-evidence',
        title: 'Settlements name their delivered energy and their payment',
        services: ['p2pTrading.mySettlements', 'settlement.verifyChain'],
        navPaths: ['/trading'],
        acting: member,
      },
      {
        id: 'pay-for-match',
        title: 'Paying a match reaches a real gateway or refuses',
        services: ['p2pTrading.payForMatch'],
        navPaths: ['/trading'],
        acting: member,
        requires: ['mobile_money'],
      },
    ],
  },
  {
    id: 'b2b-wholesale-trade',
    title: 'A business buys energy from another business',
    stakeholder: 'business',
    intent:
      'Trade as a typed business counterparty against a published tariff, not as an anonymous household.',
    steps: [
      {
        id: 'published-tariff',
        title: 'Trade against the tariff version that was published',
        services: [
          'dynamicTariffs.getPublishedTariff',
          'dynamicTariffs.getCurrentTariff',
          'dynamicTariffs.listVersions',
        ],
        navPaths: ['/market/tariffs'],
        acting: member,
      },
      {
        id: 'operator-sets-price',
        title: 'An operator sets the market price the trade clears at',
        services: ['admin.getMarketPrices', 'admin.setMarketPrice'],
        navPaths: ['/admin/pricing'],
        acting: admin,
        mutates: true,
      },
      {
        id: 'business-counterparty-offer',
        title: 'An offer carries its counterparty type through to the match',
        services: ['p2pTrading.createOffer', 'p2pTrading.getOffers', 'p2pTrading.cancelOffer'],
        navPaths: ['/trading', '/market/order-book'],
        acting: member,
        mutates: true,
      },
      {
        id: 'wholesale-position',
        title: 'The business reads its own trades and earnings',
        services: ['trading.list', 'trading.getEarnings'],
        navPaths: ['/trading'],
        acting: member,
      },
    ],
  },
  {
    id: 'automated-trading-strategy',
    title: 'A member automates trading and compares strategies',
    stakeholder: 'member',
    intent:
      'Clone a template, backtest it, activate it, and be alerted when the price moves — without hand-trading.',
    steps: [
      {
        id: 'clone-template',
        title: 'Clone a strategy template into the member’s own strategies',
        services: ['strategyTemplates.list', 'strategyTemplates.clone', 'tradingStrategies.list'],
        navPaths: ['/trading/templates', '/trading/strategies'],
        mobileScreens: ['TradingStrategies'],
        acting: member,
        mutates: true,
      },
      {
        id: 'backtest-strategy',
        title: 'Backtest reports what it measured, not a made-up return',
        services: ['tradingStrategies.backtest'],
        navPaths: ['/trading/strategies'],
        acting: member,
      },
      {
        id: 'activate-and-stand-down',
        title: 'Activate the strategy and stand it down again',
        services: ['tradingStrategies.activate', 'tradingStrategies.deactivate'],
        navPaths: ['/trading/strategies'],
        acting: member,
        mutates: true,
      },
      {
        id: 'compare-strategies',
        title: 'Compare strategies and read the recommendation',
        services: ['strategyComparison.compare', 'strategyComparison.recommend'],
        navPaths: ['/trading/comparison'],
        acting: member,
      },
      {
        id: 'price-alerts',
        title: 'Subscribe to a price alert and have the engine evaluate it',
        services: [
          'priceAlerts.create',
          'priceAlerts.listActive',
          'priceAlertEngine.subscribe',
          'priceAlertEngine.listMySubscriptions',
          'priceAlerts.delete',
        ],
        navPaths: ['/trading/price-alerts'],
        mobileScreens: ['PriceAlerts'],
        acting: member,
        mutates: true,
      },
    ],
  },
  {
    id: 'prepaid-energy-purchase',
    title: 'A member buys prepaid energy and tops up a wallet',
    stakeholder: 'member',
    intent:
      'Top up, buy a token, and pay by QR — with every step either reaching a provider or saying it cannot.',
    steps: [
      {
        id: 'wallet-and-balance',
        title: 'Wallet, balance and past top-up attempts',
        services: [
          'energyWallet.getWallet',
          'energyWallet.listTopUpAttempts',
          'payments.getBalance',
        ],
        navPaths: ['/wallet'],
        mobileScreens: ['Wallet'],
        acting: member,
      },
      {
        id: 'method-availability',
        title: 'The platform says which payment methods it can actually charge',
        services: ['paymentProcessing.getSupportedGateways', 'paymentProcessing.getGatewayAvailability'],
        navPaths: ['/payments'],
        mobileScreens: ['Payments'],
        acting: member,
      },
      {
        id: 'initiate-topup',
        title: 'A top-up reaches the gateway or is refused as unavailable',
        services: ['energyWallet.requestTopUp', 'payments.initiate'],
        navPaths: ['/payments', '/wallet'],
        acting: member,
        requires: ['mobile_money'],
        mutates: true,
      },
      {
        id: 'qr-payment-request',
        title: 'A QR payment request is generated and parsed back',
        services: ['qrcode.generate', 'qrcode.parse', 'qrHistory.getMyStats'],
        navPaths: ['/qr-payment'],
        mobileScreens: ['QRPayment'],
        acting: member,
        mutates: true,
      },
      {
        id: 'token-issuance',
        title: 'A token is issued only against a completed payment',
        services: ['payments.listTokens', 'payments.generateToken'],
        navPaths: ['/payments'],
        acting: member,
      },
    ],
  },
  {
    id: 'billing-to-payment',
    title: 'An invoice is issued, paid and evidenced',
    stakeholder: 'finance',
    intent:
      'Issue an invoice, let the member pay it, and hold the payment to gateway evidence rather than to a database row.',
    steps: [
      {
        id: 'issue-invoice',
        title: 'An operator issues an invoice to the member',
        services: ['billing.create', 'billing.list'],
        navPaths: ['/admin', '/billing'],
        acting: admin,
        mutates: true,
      },
      {
        id: 'member-reads-invoice',
        title: 'The member sees the invoice with its amount and due date',
        services: ['billing.list', 'billing.getById'],
        navPaths: ['/billing'],
        acting: member,
      },
      {
        id: 'pay-invoice',
        title: 'Paying the invoice reaches a gateway or refuses',
        services: ['payments.initiate'],
        navPaths: ['/payments'],
        acting: member,
        requires: ['mobile_money'],
        mutates: true,
      },
      {
        id: 'gateway-credentials',
        title: 'Configured gateway credentials are reported honestly',
        services: ['paymentCredentials.list', 'paymentCredentials.getLogs'],
        navPaths: ['/admin/payment-credentials'],
        acting: admin,
      },
      {
        id: 'callback-configuration',
        title: 'The callback the gateway will use is configured and reachable',
        services: ['webhookConfig.getConfig'],
        navPaths: ['/admin/webhook-config'],
        acting: admin,
      },
    ],
  },
  {
    id: 'finance-daily-close',
    title: 'Finance closes the day and reconciles independently',
    stakeholder: 'finance',
    intent:
      'Reconcile the ledger against the payments and against what members were shown, and account for every event.',
    steps: [
      {
        id: 'payment-reconciliation',
        title: 'Reconcile payments and list what does not agree',
        services: [
          'reconciliation.generateDailyReport',
          'reconciliation.getStatistics',
          'reconciliation.getUnresolvedDiscrepancies',
        ],
        navPaths: ['/admin/reconciliation'],
        acting: admin,
        mutates: true,
      },
      {
        id: 'double-entry-ledger',
        title: 'The double-entry ledger balances, and unposted entries are visible',
        services: ['ledger.status', 'ledger.unposted', 'ledger.reconciliation'],
        navPaths: ['/admin/ledger'],
        mobileScreens: ['LedgerReconciliation'],
        acting: admin,
        requires: ['ledger'],
      },
      {
        id: 'event-accountability',
        title: 'Every fact has its event, published or explicitly undeliverable',
        services: ['eventStream.status', 'eventStream.undeliverable', 'eventStream.deadLetters'],
        navPaths: ['/admin/event-stream'],
        acting: admin,
      },
      {
        id: 'audit-trail',
        title: 'The day’s money actions are in the audit trail',
        services: ['auditLogs.getStats', 'auditLogs.list'],
        navPaths: ['/admin/audit-logs'],
        mobileScreens: ['AuditLogs'],
        acting: admin,
      },
    ],
  },
  {
    id: 'demand-response-event',
    title: 'A member is called on for a demand-response event',
    stakeholder: 'member',
    intent:
      'Enrol, be called, respond, and be compensated on measured reduction rather than on a promise.',
    steps: [
      {
        id: 'enrol',
        title: 'Enrol in demand response and read the enrolment back',
        services: ['demandResponse.enroll', 'demandResponse.getEnrollment'],
        navPaths: ['/demand-response'],
        acting: member,
        mutates: true,
      },
      {
        id: 'operator-calls-event',
        title: 'An operator calls an event against forecast grid conditions',
        services: [
          'drForecasting.getGridStatus',
          'drAutomation.checkGridConditions',
          'demandResponse.createEvent',
        ],
        navPaths: ['/admin/demand-response', '/admin/dr-automation'],
        acting: admin,
        mutates: true,
      },
      {
        id: 'member-responds',
        title: 'The member accepts the event and it appears in their responses',
        services: [
          'demandResponse.getUpcomingEvents',
          'demandResponse.respondToEvent',
          'demandResponse.getMyResponses',
        ],
        navPaths: ['/demand-response'],
        acting: member,
        mutates: true,
      },
      {
        id: 'targeting-and-forecast',
        title: 'Participant targeting and the event forecast name their inputs',
        services: [
          'drForecast.recommendParticipants',
          'drForecast.listForecasts',
          'drSegmentation.getSegmentDistribution',
        ],
        navPaths: ['/grid/dr-forecast'],
        acting: admin,
      },
      {
        id: 'compensation',
        title: 'Compensation follows measured compliance',
        services: ['demandResponse.getMyCompensation', 'demandResponse.getMyAnalytics'],
        navPaths: ['/demand-response'],
        acting: member,
      },
    ],
  },
  {
    id: 'grid-operator-dispatch',
    title: 'A grid operator dispatches the fleet within bounded controls',
    stakeholder: 'grid_operator',
    intent:
      'Command devices with a validity window and a declared fallback, and never read a broker publish as obedience.',
    steps: [
      {
        id: 'control-policy',
        title: 'The deployment’s control policy and its validity cap',
        services: ['controlWindows.policy', 'controlWindows.health'],
        navPaths: ['/grid/control-windows'],
        mobileScreens: ['ControlWindows'],
        acting: admin,
      },
      {
        id: 'fleet-controls',
        title: 'Live controls across the fleet, with their evidence state',
        services: ['controlWindows.fleet', 'controlWindows.mine'],
        navPaths: ['/grid/control-windows'],
        acting: admin,
      },
      {
        id: 'device-command',
        title: 'A device command is bounded, or refused',
        services: ['devices.list', 'devices.sendCommand', 'devices.getCommands'],
        navPaths: ['/admin/devices'],
        acting: admin,
        mutates: true,
        requires: ['mqtt_broker'],
      },
      {
        id: 'expiry-sweep',
        title: 'Expired controls fall back rather than staying in force',
        services: ['controlWindows.sweepNow'],
        navPaths: ['/grid/control-windows'],
        acting: admin,
        mutates: true,
      },
      {
        id: 'device-health',
        title: 'Device and broker health are reported, not assumed',
        services: ['iotDevices.getAllDevicesHealth', 'iotDevices.getBrokerStatus'],
        navPaths: ['/admin/iot-devices'],
        acting: admin,
      },
      {
        id: 'utility-signals',
        title: 'The utility-facing status and pricing feed',
        services: ['gridOperator.adminGetStatus', 'gridOperator.adminGetPricing'],
        navPaths: ['/admin/grid-operator'],
        acting: admin,
      },
    ],
  },
  {
    id: 'price-signal-coordination',
    title: 'The fleet is coordinated by price rather than by setpoint',
    stakeholder: 'grid_operator',
    intent:
      'Publish a price per interval, let sites return their own plans, and score what they actually did.',
    steps: [
      {
        id: 'coordinate',
        title: 'Coordinate a price signal across participating sites',
        services: ['priceSignal.coordinate'],
        navPaths: ['/grid/price-signals'],
        acting: admin,
        mutates: true,
      },
      {
        id: 'publish',
        title: 'A converged signal can be published; a diverged one cannot',
        services: ['priceSignal.publish'],
        navPaths: ['/grid/price-signals'],
        acting: admin,
        mutates: true,
      },
      {
        id: 'member-view',
        title: 'A site sees the signal it was sent',
        services: ['priceSignal.mySignals'],
        navPaths: ['/grid/price-signals'],
        mobileScreens: ['PriceSignals'],
        acting: member,
      },
      {
        id: 'score',
        title: 'Scoring measures the site across all its meters',
        services: ['priceSignal.score', 'priceSignal.list'],
        navPaths: ['/grid/price-signals'],
        acting: admin,
        mutates: true,
      },
    ],
  },
  {
    id: 'locational-flexibility-market',
    title: 'Flexibility is bought at a constrained feeder',
    stakeholder: 'grid_operator',
    intent:
      'Buy flexibility where the network needs it, pay only for measured delivery, and never award unverified topology.',
    steps: [
      {
        id: 'topology',
        title: 'Nodes and asset links carry their provenance',
        services: [
          'locationalFlexibility.createNode',
          'locationalFlexibility.nodes',
          'locationalFlexibility.linkAsset',
        ],
        navPaths: ['/grid/locational-flexibility'],
        acting: admin,
        mutates: true,
      },
      {
        id: 'requirement',
        title: 'A located requirement is opened for bids',
        services: ['locationalFlexibility.createRequirement', 'locationalFlexibility.requirements'],
        navPaths: ['/grid/locational-flexibility'],
        acting: admin,
        mutates: true,
      },
      {
        id: 'member-offers',
        title: 'A member sees the opportunity and offers into it',
        services: ['locationalFlexibility.myOpportunities', 'locationalFlexibility.offer'],
        navPaths: ['/grid/locational-flexibility'],
        mobileScreens: ['LocationalFlexibility'],
        acting: member,
        mutates: true,
      },
      {
        id: 'clear-and-measure',
        title: 'Merit-order clearing, then measurement from telemetry',
        services: [
          'locationalFlexibility.clear',
          'locationalFlexibility.measure',
          'locationalFlexibility.settle',
        ],
        navPaths: ['/grid/locational-flexibility'],
        acting: admin,
        mutates: true,
      },
      {
        id: 'member-awards',
        title: 'The member reads their awards and what was verified',
        services: ['locationalFlexibility.myAwards'],
        navPaths: ['/grid/locational-flexibility'],
        acting: member,
      },
    ],
  },
  {
    id: 'ev-v2g-session',
    title: 'An EV charges smartly and discharges back to the grid',
    stakeholder: 'member',
    intent:
      'Plan a V2G schedule that respects the driver’s minimum state of charge, and dispatch it only through a real station.',
    steps: [
      {
        id: 'register-ev',
        title: 'Register an EV and read its capabilities back',
        services: ['evCharging.registerEV', 'evCharging.getUserEVs'],
        navPaths: ['/v2g'],
        acting: member,
        mutates: true,
      },
      {
        id: 'plan-schedule',
        title: 'A V2G plan respects the minimum state of charge',
        services: ['v2gOptimizer.planSchedule', 'v2gOptimizer.getSchedule'],
        navPaths: ['/v2g'],
        acting: member,
        mutates: true,
      },
      {
        id: 'list-and-cancel',
        title: 'Schedules are listable and cancellable',
        services: ['v2gOptimizer.listSchedules', 'v2gOptimizer.cancelSchedule'],
        navPaths: ['/v2g'],
        acting: member,
        mutates: true,
      },
      {
        id: 'station-session',
        title: 'A charging session needs a real charge point',
        services: ['evCharging.startSession', 'evCharging.getSession'],
        navPaths: ['/v2g'],
        acting: member,
        requires: ['ocpp_station'],
      },
    ],
  },
  {
    id: 'smart-home-load-control',
    title: 'Smart-home loads are enrolled as flexibility',
    stakeholder: 'grid_operator',
    intent:
      'Enrol Matter loads through a real controller and show each node with the evidence behind it.',
    steps: [
      {
        id: 'matter-inventory',
        title: 'Commissioned nodes, each with when it last reported',
        services: ['matterLoads.nodes'],
        navPaths: ['/grid/matter-loads'],
        mobileScreens: ['MatterLoads'],
        acting: admin,
        requires: ['matter_controller'],
      },
      {
        id: 'load-capabilities',
        title: 'Controllable loads declare what they can actually do',
        services: ['derCapabilities.getUserAssetsWithCapabilities', 'derCapabilities.getCapabilities'],
        navPaths: ['/grid/matter-loads'],
        acting: member,
      },
    ],
  },
  {
    id: 'noc-soc-watch',
    title: 'A NOC operator watches the whole fleet on the wall',
    stakeholder: 'noc_operator',
    intent:
      'See fleet aggregates with their coverage, spot anomalies, and know when a figure is stale rather than calm.',
    steps: [
      {
        id: 'fleet-aggregates',
        title: 'Rolling aggregates carry the coverage behind every figure',
        services: ['fleetTelemetry.rollUp', 'fleetTelemetry.rolling'],
        navPaths: ['/grid/fleet-telemetry', '/grid/operations-wall'],
        acting: admin,
        mutates: true,
      },
      {
        id: 'operations-wall',
        title: 'The wall renders the scoped twin for the fleet',
        services: ['digitalTwin.scoped'],
        navPaths: ['/grid/operations-wall'],
        acting: admin,
      },
      {
        id: 'anomaly-sweep',
        title: 'Fleet anomaly sweep and its summary',
        services: ['gridAnomaly.scanFleet', 'gridAnomaly.getFleetAnomalySummary'],
        navPaths: ['/grid/anomalies'],
        acting: admin,
        mutates: true,
      },
      {
        id: 'platform-performance',
        title: 'API and database performance as the operator sees it',
        services: ['performance.getDashboard', 'performance.getHealth'],
        navPaths: ['/admin/performance'],
        acting: admin,
      },
      {
        id: 'cache-health',
        title: 'Cache and Redis health, including an unreachable store',
        services: ['cacheMonitoring.getCacheStats', 'redisHealth.getStatus'],
        navPaths: ['/admin/cache-monitoring'],
        acting: admin,
      },
    ],
  },
  {
    id: 'degraded-operation-drill',
    title: 'An operator rehearses losing the platform',
    stakeholder: 'noc_operator',
    intent:
      'Know what the fleet does when the platform, broker or optimizer is unreachable, and what it refuses to decide.',
    steps: [
      {
        id: 'posture',
        title: 'The degraded posture and what each capability may still do',
        services: ['degradedOperation.posture', 'degradedOperation.openActions'],
        navPaths: ['/grid/degraded-operation'],
        acting: admin,
      },
      {
        id: 'observations',
        title: 'Observations recorded while degraded are marked as such',
        services: ['degradedOperation.observations', 'degradedOperation.reconcile'],
        navPaths: ['/grid/degraded-operation'],
        acting: admin,
        mutates: true,
      },
      {
        id: 'member-degraded-view',
        title: 'A member is told what the platform cannot currently do',
        services: ['degradedOperation.memberStatus'],
        navPaths: ['/grid/degraded-operation'],
        mobileScreens: ['ServiceStatus'],
        acting: member,
      },
      {
        id: 'workflow-visibility',
        title: 'Durable workflows are visible and owned',
        services: [
          'workflows.getStats',
          'workflows.list',
          'orchestrator.listUserWorkflows',
          'journeys.report',
        ],
        navPaths: ['/admin/workflows', '/admin/journeys'],
        mobileScreens: ['WorkflowMonitor', 'JourneyAssurance'],
        acting: admin,
      },
    ],
  },
  {
    id: 'forecast-and-model-lifecycle',
    title: 'A data owner keeps forecasts and models honest',
    stakeholder: 'data_owner',
    intent:
      'Score forecasts against actuals, check the served weights verify, and retrain when drift is real.',
    steps: [
      {
        id: 'produce-forecast',
        title: 'Produce a forecast and read it back with its horizon',
        services: ['forecasting.forecastLoad', 'forecasting.getForecast'],
        navPaths: ['/grid/forecast-accuracy'],
        acting: member,
        mutates: true,
      },
      {
        id: 'score-against-actuals',
        title: 'Accuracy comes from actuals, or is reported as unscored',
        services: ['forecasting.scoreDueRuns', 'forecasting.accuracySummary'],
        navPaths: ['/grid/forecast-accuracy'],
        mobileScreens: ['ForecastAccuracy'],
        acting: admin,
        mutates: true,
      },
      {
        id: 'model-health',
        title: 'Served weights verify against the run that produced them',
        services: ['modelHealth.overview'],
        navPaths: ['/admin/model-health'],
        mobileScreens: ['ModelHealth'],
        acting: admin,
      },
      {
        id: 'drift-and-retraining',
        title: 'Drift detection, and a retraining trigger with a real worker',
        services: ['mlops.getDeployedModel', 'mlops.detectDrift', 'mlops.getRecentDriftEvents'],
        navPaths: ['/admin/model-health', '/admin/ml-predictions'],
        acting: member,
      },
      {
        id: 'prediction-surfaces',
        title: 'Predictions shown to members name their model version',
        services: ['mlPredictions.getModelMetrics', 'mlPredictions.getPricePredictions'],
        navPaths: ['/admin/ml-predictions'],
        acting: member,
      },
      {
        id: 'lakehouse-provenance',
        title: 'Lake ingestion runs report what was actually stored',
        services: ['lakehouse.status', 'lakehouse.runs'],
        navPaths: ['/admin/lakehouse'],
        mobileScreens: ['Lakehouse'],
        acting: admin,
        requires: ['object_store'],
      },
      {
        id: 'platform-analytics',
        title: 'Operator analytics agree with the tables behind them',
        services: ['adminAnalytics.getOverview', 'adminAnalytics.getSystemKPIs'],
        navPaths: ['/admin/analytics', '/admin/analytics-dashboard'],
        mobileScreens: ['AdminAnalytics'],
        acting: admin,
      },
    ],
  },
  {
    id: 'support-diagnosis',
    title: 'Support diagnoses a member problem from evidence',
    stakeholder: 'support',
    intent:
      'Answer "why is this member’s meter wrong" from platform evidence, and refuse to guess when there is none.',
    steps: [
      {
        id: 'diagnostic-evidence',
        title: 'The evidence a diagnosis would be built from',
        services: ['diagnostics.health', 'diagnostics.evidence'],
        navPaths: ['/admin/diagnostics'],
        acting: admin,
      },
      {
        id: 'local-model-diagnosis',
        title: 'A local model answers with citations, or refuses',
        services: ['diagnostics.diagnose', 'diagnostics.runs'],
        navPaths: ['/admin/diagnostics'],
        mobileScreens: ['Diagnostics'],
        acting: admin,
        requires: ['ollama'],
        mutates: true,
      },
      {
        id: 'loss-detection',
        title: 'Non-technical loss flags name the readings behind them',
        services: ['ntlDetection.runAnalysis', 'ntlDetection.getFlags'],
        navPaths: ['/grid/ntl'],
        acting: admin,
        mutates: true,
      },
      {
        id: 'compliance-report',
        title: 'A compliance report is generated and checksummed',
        services: [
          'complianceReports.generateReport',
          'complianceReports.listReports',
          'complianceReports.getReportChecksum',
        ],
        navPaths: ['/grid/compliance-reports'],
        acting: admin,
        mutates: true,
      },
      {
        id: 'platform-state',
        title: 'The operator home reflects the platform’s real counts',
        services: ['admin.getSystemStats', 'admin.getActivityLogs'],
        navPaths: ['/admin'],
        acting: admin,
      },
    ],
  },
  {
    id: 'community-and-rewards',
    title: 'A community shares generation and earns together',
    stakeholder: 'member',
    intent:
      'Pool generation with neighbours, see the allocation that produced each statement, and earn from referrals.',
    steps: [
      {
        id: 'pool-rules',
        title: 'Pool rules are set and read back',
        services: ['communityPools.setPoolRules', 'communityPools.getPoolRules'],
        navPaths: ['/community-pools'],
        acting: member,
        mutates: true,
      },
      {
        id: 'allocation-run',
        title: 'An allocation run produces a statement that names its inputs',
        services: [
          'communityPools.runAllocation',
          'communityPools.getMyStatement',
          'communityPools.listRuns',
        ],
        navPaths: ['/community-pools'],
        acting: member,
        mutates: true,
      },
      {
        id: 'community-telemetry',
        title: 'The community view aggregates neighbours without naming them',
        services: ['fleetTelemetry.community'],
        navPaths: ['/community-pools'],
        mobileScreens: ['CommunityTelemetry'],
        acting: member,
      },
      {
        id: 'leaderboard',
        title: 'The leaderboard and the member’s own rank',
        services: ['gamification.getLeaderboard', 'gamification.getMyRank', 'gamification.checkAchievements'],
        navPaths: ['/leaderboard'],
        mobileScreens: ['Gamification'],
        acting: member,
      },
      {
        id: 'referrals',
        title: 'A referral code, its referrals and its rewards',
        services: ['referrals.getMyReferralCode', 'referrals.getMyStats', 'referrals.getMyRewards'],
        navPaths: ['/referrals', '/referral-leaderboard'],
        acting: member,
      },
      {
        id: 'sms-channel',
        title: 'SMS commands are logged whether or not a gateway answered',
        services: ['smsCommands.getMySmsLog', 'smsCommands.listCommands'],
        navPaths: ['/sms-center'],
        acting: admin,
        requires: ['sms_gateway'],
      },
    ],
  },
];

export function journeyById(id: string): JourneyMeta | undefined {
  return JOURNEYS.find(journey => journey.id === id);
}

export function journeyStepMeta(journeyId: string, stepId: string): JourneyStepMeta | undefined {
  return journeyById(journeyId)?.steps.find(step => step.id === stepId);
}

export type StepResult = {
  stepId: string;
  outcome: StepOutcome;
  detail: string;
  /** Named values the step observed, so a later failure can be compared. */
  facts: Record<string, string | number | boolean | null>;
  durationMs: number;
};

export type JourneyStatus = 'passed' | 'failed' | 'blocked' | 'running' | 'not_run';

/**
 * A journey passes when every step either passed or was correctly refused. One
 * failure fails the journey; otherwise a blocked step downgrades it to
 * `blocked`, because part of it was never exercised.
 */
export function journeyStatus(steps: StepResult[], expectedStepIds: string[]): JourneyStatus {
  if (steps.length === 0) return 'not_run';
  if (steps.some(step => step.outcome === 'failed')) return 'failed';
  const seen = new Set(steps.map(step => step.stepId));
  if (expectedStepIds.some(id => !seen.has(id))) return 'running';
  return steps.some(step => step.outcome === 'blocked') ? 'blocked' : 'passed';
}

export type SuiteSummary = {
  journeys: number;
  passed: number;
  failed: number;
  blocked: number;
  notRun: number;
  steps: number;
  stepsPassed: number;
  stepsRefused: number;
  stepsBlocked: number;
  stepsFailed: number;
  /**
   * Steps that were exercisable and behaved, over all exercisable steps. Steps
   * blocked on an absent external dependency are excluded rather than counted
   * as passes — they are reported separately.
   */
  exercisableScorePct: number | null;
};

export function suiteSummary(
  runs: Array<{ journeyId: string; steps: StepResult[] }>
): SuiteSummary {
  let passed = 0;
  let failed = 0;
  let blocked = 0;
  let notRun = 0;
  const counts = { passed: 0, refused: 0, blocked: 0, failed: 0 };

  for (const journey of JOURNEYS) {
    const run = runs.find(candidate => candidate.journeyId === journey.id);
    const status = journeyStatus(
      run?.steps ?? [],
      journey.steps.map(step => step.id)
    );
    if (status === 'passed') passed += 1;
    else if (status === 'failed') failed += 1;
    else if (status === 'blocked') blocked += 1;
    else notRun += 1;
    for (const step of run?.steps ?? []) counts[step.outcome] += 1;
  }

  const exercisable = counts.passed + counts.refused + counts.failed;
  return {
    journeys: JOURNEYS.length,
    passed,
    failed,
    blocked,
    notRun,
    steps: counts.passed + counts.refused + counts.blocked + counts.failed,
    stepsPassed: counts.passed,
    stepsRefused: counts.refused,
    stepsBlocked: counts.blocked,
    stepsFailed: counts.failed,
    exercisableScorePct:
      exercisable === 0
        ? null
        : Math.round(((counts.passed + counts.refused) / exercisable) * 1000) / 10,
  };
}

export type NavCoverage = {
  covered: Array<{ navPath: string; journeyIds: string[] }>;
  uncovered: string[];
};

/**
 * Which navigation routes the catalog exercises. `navPaths` is supplied by the
 * caller so this stays independent of the web and mobile navigation trees, and
 * so a route added to either app shows up here as uncovered.
 */
export function navCoverage(navPaths: string[]): NavCoverage {
  const byPath = new Map<string, Set<string>>();
  for (const journey of JOURNEYS) {
    for (const step of journey.steps) {
      for (const path of step.navPaths) {
        const journeys = byPath.get(path) ?? new Set<string>();
        journeys.add(journey.id);
        byPath.set(path, journeys);
      }
    }
  }
  const covered: NavCoverage['covered'] = [];
  const uncovered: string[] = [];
  for (const path of navPaths) {
    const journeys = byPath.get(path);
    if (journeys && journeys.size > 0) {
      covered.push({ navPath: path, journeyIds: [...journeys].sort() });
    } else {
      uncovered.push(path);
    }
  }
  return { covered, uncovered };
}

/**
 * Which React Native screens the catalog exercises. Same contract as
 * `navCoverage`: the caller supplies the app's screen list, so a screen added
 * to the mobile navigator shows up here as uncovered.
 */
export function mobileScreenCoverage(screens: string[]): NavCoverage {
  const byScreen = new Map<string, Set<string>>();
  for (const journey of JOURNEYS) {
    for (const step of journey.steps) {
      for (const screen of step.mobileScreens ?? []) {
        const journeys = byScreen.get(screen) ?? new Set<string>();
        journeys.add(journey.id);
        byScreen.set(screen, journeys);
      }
    }
  }
  const covered: NavCoverage['covered'] = [];
  const uncovered: string[] = [];
  for (const screen of screens) {
    const journeys = byScreen.get(screen);
    if (journeys && journeys.size > 0) {
      covered.push({ navPath: screen, journeyIds: [...journeys].sort() });
    } else {
      uncovered.push(screen);
    }
  }
  return { covered, uncovered };
}

/** Every service the catalog names, for the coverage matrix. */
export function catalogServices(): string[] {
  const services = new Set<string>();
  for (const journey of JOURNEYS) {
    for (const step of journey.steps) {
      for (const service of step.services) services.add(service);
    }
  }
  return [...services].sort();
}

export function catalogDependencies(): ExternalDependency[] {
  const dependencies = new Set<ExternalDependency>();
  for (const journey of JOURNEYS) {
    for (const step of journey.steps) {
      for (const dependency of step.requires ?? []) dependencies.add(dependency);
    }
  }
  return [...dependencies].sort();
}
