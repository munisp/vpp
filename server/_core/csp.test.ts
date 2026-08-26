import { afterEach, describe, expect, it } from 'vitest';
import { getAnalyticsConfig, productionCspDirectives } from './csp';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
});

describe('production CSP construction', () => {
  it('permits only self and the configured analytics origin for scripts', () => {
    const directives = productionCspDirectives({
      endpoint: 'https://analytics.example.com',
      websiteId: 'website',
      origin: 'https://analytics.example.com',
    });

    expect(directives.scriptSrc).toEqual(["'self'", 'https://analytics.example.com']);
    expect(directives.scriptSrc).not.toContain("'unsafe-inline'");
    expect(directives.scriptSrc).not.toContain("'unsafe-eval'");
    expect(directives.scriptSrcAttr).toEqual(["'none'"]);
  });

  it('rejects a partial analytics configuration instead of widening policy with an undefined URL', () => {
    process.env.ANALYTICS_ENDPOINT = 'https://analytics.example.com';
    delete process.env.ANALYTICS_WEBSITE_ID;
    delete process.env.VITE_ANALYTICS_WEBSITE_ID;

    expect(() => getAnalyticsConfig()).toThrow('must be configured together');
  });
});
