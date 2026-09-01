/**
 * Pinning tests for P16: compliance checks whose evidence source has no data
 * (support_tickets / health_checks have no writer wired anywhere on the
 * platform) are UNVERIFIABLE, not compliant. An empty table yields an
 * EVIDENCE_UNAVAILABLE finding with actualValue 'no_data' and the check is
 * persisted as pending_review — never reported compliant on no evidence.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const dialect = new PgDialect();

function ruleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    rule_code: 'NG-CP-1',
    jurisdiction: 'NG',
    regulatory_body: 'NERC',
    rule_category: 'consumer_protection',
    rule_name: 'Complaint response',
    description: 'Respond to complaints',
    requirements: JSON.stringify({ complaint_response_hours: 24 }),
    check_frequency: 'daily',
    effective_from: new Date('2025-01-01'),
    effective_until: null,
    penalty_description: null,
    automated_check_enabled: true,
    status: 'active',
    ...overrides,
  };
}

function mockDb(rule: Record<string, unknown>) {
  const persisted: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    execute: async (query: unknown) => {
      const { sql: text, params } = dialect.sqlToQuery(query as never);
      const lower = text.toLowerCase();
      if (lower.includes('insert into compliance_checks')) {
        persisted.push({ sql: text, params });
        return { rows: [{ id: 99 }] };
      }
      if (lower.includes('from compliance_rules')) {
        return { rows: [rule] };
      }
      // The empty evidence sources: no support tickets, no health checks.
      if (lower.includes('from support_tickets') || lower.includes('from health_checks')) {
        return { rows: [{ count: 0 }] };
      }
      return { rows: [] };
    },
  };
  vi.doMock('./db', () => ({ getDb: async () => db }));
  vi.doMock('./integration/kafka-publisher', () => ({
    kafkaPublisher: { publishComplianceCheck: async () => undefined },
  }));
  return persisted;
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('./db');
  vi.doUnmock('./integration/kafka-publisher');
});

describe('empty evidence source is unverifiable, not compliant (P16)', () => {
  it('consumer_protection with zero support tickets is pending_review with EVIDENCE_UNAVAILABLE', async () => {
    const persisted = mockDb(ruleRow());
    const { complianceAutomation } = await import('./services/compliance-automation');

    const check = await complianceAutomation.runComplianceCheck(1, { type: 'platform' });

    expect(check.status).toBe('pending_review');
    expect(check.status).not.toBe('compliant');
    const finding = check.findings.find(f => f.findingCode === 'EVIDENCE_UNAVAILABLE');
    expect(finding).toBeDefined();
    expect(finding!.actualValue).toBe('no_data');
    expect(check.evidenceReferences).toContain('complaint_evidence:no_data');

    // The persisted row carries the same honest status (status is the 5th
    // interpolated value in the INSERT).
    expect(persisted).toHaveLength(1);
    expect(persisted[0].params).toContain('pending_review');
    expect(persisted[0].params).not.toContain('compliant');
  });

  it('service availability with zero health checks is pending_review, not compliant', async () => {
    mockDb(
      ruleRow({
        requirements: JSON.stringify({ service_availability: 0.99 }),
      })
    );
    const { complianceAutomation } = await import('./services/compliance-automation');

    const check = await complianceAutomation.runComplianceCheck(1, { type: 'platform' });

    expect(check.status).toBe('pending_review');
    const finding = check.findings.find(f => f.findingCode === 'EVIDENCE_UNAVAILABLE');
    expect(finding).toBeDefined();
    expect(finding!.actualValue).toBe('no_data');
  });

  it('a category with no automated check implemented is pending_review, never silently compliant', async () => {
    mockDb(ruleRow({ rule_category: 'market_rules', requirements: JSON.stringify({}) }));
    const { complianceAutomation } = await import('./services/compliance-automation');

    const check = await complianceAutomation.runComplianceCheck(1, { type: 'platform' });

    expect(check.status).toBe('pending_review');
    expect(check.findings.some(f => f.findingCode === 'CHECK_NOT_IMPLEMENTED')).toBe(true);
  });
});
