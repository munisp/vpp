type AnalyticsConfig = {
  endpoint: string;
  websiteId: string;
  origin: string;
};

const SELF = "'self'";

function configuredValue(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * Analytics is optional. When it is enabled, both settings are required and
 * the endpoint must be an HTTPS origin. Keeping this validation server-side
 * prevents a build-time HTML variable from widening CSP at runtime.
 */
export function getAnalyticsConfig(): AnalyticsConfig | null {
  const endpoint = configuredValue('ANALYTICS_ENDPOINT', 'VITE_ANALYTICS_ENDPOINT');
  const websiteId = configuredValue('ANALYTICS_WEBSITE_ID', 'VITE_ANALYTICS_WEBSITE_ID');

  if (!endpoint && !websiteId) return null;
  if (!endpoint || !websiteId) {
    throw new Error(
      'ANALYTICS_ENDPOINT and ANALYTICS_WEBSITE_ID must be configured together when analytics is enabled.'
    );
  }

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('ANALYTICS_ENDPOINT must be an absolute HTTPS URL.');
  }

  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('ANALYTICS_ENDPOINT must be a credential-free HTTPS origin or path.');
  }

  const normalizedEndpoint = url.pathname === '/'
    ? url.origin
    : `${url.origin}${url.pathname.replace(/\/$/, '')}`;

  return { endpoint: normalizedEndpoint, websiteId, origin: url.origin };
}

/**
 * Strict policy for the built SPA. Service-worker registration and analytics
 * loading are external modules, so neither unsafe-inline nor unsafe-eval is
 * necessary in production.
 */
export function productionCspDirectives(analytics: AnalyticsConfig | null): Record<string, string[]> {
  const analyticsOrigin = analytics ? [analytics.origin] : [];

  return {
    defaultSrc: [SELF],
    baseUri: ["'none'"],
    objectSrc: ["'none'"],
    frameAncestors: ["'none'"],
    formAction: [SELF],
    scriptSrc: [SELF, ...analyticsOrigin],
    scriptSrcAttr: ["'none'"],
    styleSrc: [SELF, 'https://fonts.googleapis.com'],
    fontSrc: [SELF, 'data:', 'https://fonts.gstatic.com'],
    imgSrc: [SELF, 'data:', 'blob:'],
    connectSrc: [SELF, ...analyticsOrigin],
    workerSrc: [SELF, 'blob:'],
    manifestSrc: [SELF],
    mediaSrc: [SELF, 'blob:'],
    upgradeInsecureRequests: [],
  };
}

/**
 * Same-origin JavaScript loader so the static HTML never contains an inline
 * script or an environment-expanded third-party script URL.
 */
export function analyticsLoaderSource(analytics: AnalyticsConfig | null): string {
  if (!analytics) return '/* Analytics is not configured. */\n';

  const source = `${analytics.endpoint}/umami`;
  return [
    '(() => {',
    '  const script = document.createElement("script");',
    '  script.defer = true;',
    `  script.src = ${JSON.stringify(source)};`,
    `  script.dataset.websiteId = ${JSON.stringify(analytics.websiteId)};`,
    '  document.head.appendChild(script);',
    '})();',
    '',
  ].join('\n');
}

export type { AnalyticsConfig };
