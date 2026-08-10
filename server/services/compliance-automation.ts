/**
 * Compliance Automation Service
 * 
 * Manages regulatory compliance rules, automated checks,
 * reporting requirements, and data retention policies.
 */

import { getDb } from '../db';
import { sql } from 'drizzle-orm';
import { kafkaPublisher } from '../integration/kafka-publisher';

// Types for compliance
export interface ComplianceRule {
  id: number;
  ruleCode: string;
  jurisdiction: string;
  regulatoryBody: string | null;
  ruleCategory: 'grid_code' | 'market_rules' | 'data_privacy' | 'safety' | 
                'environmental' | 'consumer_protection' | 'reporting';
  ruleName: string;
  description: string;
  requirements: Record<string, any>;
  checkFrequency: 'realtime' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'annually';
  effectiveFrom: Date;
  effectiveUntil: Date | null;
  penaltyDescription: string | null;
  automatedCheckEnabled: boolean;
  status: 'active' | 'pending' | 'deprecated';
}

export interface ComplianceCheck {
  id: number;
  ruleId: number;
  checkType: 'automated' | 'manual' | 'audit';
  scopeType: 'user' | 'asset' | 'community' | 'platform';
  scopeId: number | null;
  checkedAt: Date;
  status: 'compliant' | 'non_compliant' | 'warning' | 'not_applicable' | 'pending_review';
  findings: ComplianceFinding[];
  evidenceReferences: string[];
  checkedBy: string | null;
  reviewedBy: number | null;
  reviewedAt: Date | null;
  nextCheckDue: Date | null;
}

export interface ComplianceFinding {
  findingCode: string;
  severity: 'info' | 'minor' | 'major' | 'critical';
  description: string;
  requirement: string;
  actualValue: string | null;
  expectedValue: string | null;
  remediation: string | null;
}

export interface ComplianceReport {
  reportId: string;
  reportType: 'periodic' | 'incident' | 'audit' | 'regulatory_filing';
  jurisdiction: string;
  periodStart: Date;
  periodEnd: Date;
  generatedAt: Date;
  submittedAt: Date | null;
  submittedTo: string | null;
  status: 'draft' | 'pending_review' | 'submitted' | 'accepted' | 'rejected';
  sections: ComplianceReportSection[];
  attachments: string[];
}

export interface ComplianceReportSection {
  sectionName: string;
  content: Record<string, any>;
  checkResults: ComplianceCheck[];
}

export interface DataRetentionPolicy {
  id: number;
  dataCategory: string;
  jurisdiction: string;
  retentionPeriodDays: number;
  legalBasis: string;
  deletionMethod: 'hard_delete' | 'soft_delete' | 'anonymize';
  status: 'active' | 'pending' | 'deprecated';
}

// Jurisdiction-specific rule definitions
const JURISDICTION_RULES: Record<string, Array<Omit<ComplianceRule, 'id'>>> = {
  'NG': [
    {
      ruleCode: 'NG-NERC-001',
      jurisdiction: 'NG',
      regulatoryBody: 'NERC',
      ruleCategory: 'grid_code',
      ruleName: 'Grid Connection Standards',
      description: 'DER must comply with Nigerian grid connection standards',
      requirements: {
        voltage_range: { min: 207, max: 253 },
        frequency_range: { min: 49.5, max: 50.5 },
        power_factor: { min: 0.85 },
      },
      checkFrequency: 'realtime',
      effectiveFrom: new Date('2020-01-01'),
      effectiveUntil: null,
      penaltyDescription: 'Disconnection from grid',
      automatedCheckEnabled: true,
      status: 'active',
    },
    {
      ruleCode: 'NG-NERC-002',
      jurisdiction: 'NG',
      regulatoryBody: 'NERC',
      ruleCategory: 'reporting',
      ruleName: 'Monthly Generation Reporting',
      description: 'Report monthly generation and export data to NERC',
      requirements: {
        report_fields: ['total_generation_kwh', 'total_export_kwh', 'peak_power_kw', 'availability_percent'],
        submission_deadline_days: 15,
      },
      checkFrequency: 'monthly',
      effectiveFrom: new Date('2020-01-01'),
      effectiveUntil: null,
      penaltyDescription: 'Fine up to NGN 500,000',
      automatedCheckEnabled: true,
      status: 'active',
    },
    {
      ruleCode: 'NG-NDPR-001',
      jurisdiction: 'NG',
      regulatoryBody: 'NITDA',
      ruleCategory: 'data_privacy',
      ruleName: 'Nigeria Data Protection Regulation',
      description: 'Compliance with NDPR for personal data handling',
      requirements: {
        consent_required: true,
        data_retention_max_years: 6,
        breach_notification_hours: 72,
        dpo_required: true,
      },
      checkFrequency: 'quarterly',
      effectiveFrom: new Date('2019-01-25'),
      effectiveUntil: null,
      penaltyDescription: 'Fine up to 2% of annual gross revenue',
      automatedCheckEnabled: true,
      status: 'active',
    },
  ],
  'TZ': [
    {
      ruleCode: 'TZ-EWURA-001',
      jurisdiction: 'TZ',
      regulatoryBody: 'EWURA',
      ruleCategory: 'grid_code',
      ruleName: 'Tanzania Grid Code Compliance',
      description: 'DER must comply with Tanzania grid code requirements',
      requirements: {
        voltage_range: { min: 207, max: 253 },
        frequency_range: { min: 49.0, max: 51.0 },
        power_factor: { min: 0.9 },
      },
      checkFrequency: 'realtime',
      effectiveFrom: new Date('2018-01-01'),
      effectiveUntil: null,
      penaltyDescription: 'License revocation',
      automatedCheckEnabled: true,
      status: 'active',
    },
    {
      ruleCode: 'TZ-EWURA-002',
      jurisdiction: 'TZ',
      regulatoryBody: 'EWURA',
      ruleCategory: 'consumer_protection',
      ruleName: 'Consumer Protection Standards',
      description: 'Standards for consumer billing and service quality',
      requirements: {
        billing_accuracy: 0.99,
        complaint_response_hours: 48,
        service_availability: 0.95,
      },
      checkFrequency: 'monthly',
      effectiveFrom: new Date('2018-01-01'),
      effectiveUntil: null,
      penaltyDescription: 'Fine and license conditions',
      automatedCheckEnabled: true,
      status: 'active',
    },
  ],
};

export class ComplianceAutomationService {
  
  /**
   * Initialize compliance rules for a jurisdiction
   */
  async initializeJurisdictionRules(jurisdiction: string): Promise<ComplianceRule[]> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const rules = JURISDICTION_RULES[jurisdiction] || [];
    const createdRules: ComplianceRule[] = [];

    for (const rule of rules) {
      // Check if rule already exists
      const existingResult = await db.execute(sql`
        SELECT id FROM compliance_rules WHERE rule_code = ${rule.ruleCode}
      `);

      if ((existingResult as any)[0]?.length > 0) {
        continue; // Skip existing rules
      }

      const result = await db.execute(sql`
        INSERT INTO compliance_rules (
          rule_code, jurisdiction, regulatory_body, rule_category,
          rule_name, description, requirements, check_frequency,
          effective_from, effective_until, penalty_description,
          automated_check_enabled, status, created_at, updated_at
        ) VALUES (
          ${rule.ruleCode}, ${rule.jurisdiction}, ${rule.regulatoryBody},
          ${rule.ruleCategory}, ${rule.ruleName}, ${rule.description},
          ${JSON.stringify(rule.requirements)}, ${rule.checkFrequency},
          ${rule.effectiveFrom}, ${rule.effectiveUntil}, ${rule.penaltyDescription},
          ${rule.automatedCheckEnabled}, ${rule.status}, NOW(), NOW()
        )
      `);

      createdRules.push({
        id: (result as any).insertId,
        ...rule,
      });
    }

    console.log(`[Compliance] Initialized ${createdRules.length} rules for ${jurisdiction}`);
    return createdRules;
  }

  /**
   * Get active rules for a jurisdiction
   */
  async getActiveRules(jurisdiction: string): Promise<ComplianceRule[]> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const result = await db.execute(sql`
      SELECT * FROM compliance_rules
      WHERE jurisdiction = ${jurisdiction}
        AND status = 'active'
        AND effective_from <= NOW()
        AND (effective_until IS NULL OR effective_until > NOW())
      ORDER BY rule_category, rule_code
    `);

    return ((result as any)[0] || []).map(this.mapRowToRule);
  }

  /**
   * Run automated compliance check
   */
  async runComplianceCheck(
    ruleId: number,
    scope: { type: 'user' | 'asset' | 'community' | 'platform'; id?: number }
  ): Promise<ComplianceCheck> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const rule = await this.getRule(ruleId);
    if (!rule) throw new Error('Rule not found');

    const findings: ComplianceFinding[] = [];
    const evidenceReferences: string[] = [];

    // Run category-specific checks
    switch (rule.ruleCategory) {
      case 'grid_code':
        await this.checkGridCodeCompliance(rule, scope, findings, evidenceReferences);
        break;
      case 'data_privacy':
        await this.checkDataPrivacyCompliance(rule, scope, findings, evidenceReferences);
        break;
      case 'reporting':
        await this.checkReportingCompliance(rule, scope, findings, evidenceReferences);
        break;
      case 'consumer_protection':
        await this.checkConsumerProtectionCompliance(rule, scope, findings, evidenceReferences);
        break;
      case 'safety':
        await this.checkSafetyCompliance(rule, scope, findings, evidenceReferences);
        break;
      default:
        findings.push({
          findingCode: 'CHECK_NOT_IMPLEMENTED',
          severity: 'info',
          description: `Automated check not implemented for category ${rule.ruleCategory}`,
          requirement: 'Manual review required',
          actualValue: null,
          expectedValue: null,
          remediation: 'Schedule manual compliance review',
        });
    }

    // Determine overall status
    let status: ComplianceCheck['status'] = 'compliant';
    if (findings.some(f => f.severity === 'critical')) {
      status = 'non_compliant';
    } else if (findings.some(f => f.severity === 'major')) {
      status = 'non_compliant';
    } else if (findings.some(f => f.severity === 'minor')) {
      status = 'warning';
    }

    // Calculate next check due
    const nextCheckDue = this.calculateNextCheckDue(rule.checkFrequency);

    // Store check result
    const result = await db.execute(sql`
      INSERT INTO compliance_checks (
        rule_id, check_type, scope_type, scope_id,
        checked_at, status, findings, evidence_references,
        checked_by, next_check_due, created_at
      ) VALUES (
        ${ruleId}, 'automated', ${scope.type}, ${scope.id || null},
        NOW(), ${status}, ${JSON.stringify(findings)},
        ${JSON.stringify(evidenceReferences)}, 'system',
        ${nextCheckDue}, NOW()
      )
    `);

    console.log(`[Compliance] Check ${rule.ruleCode}: ${status} (${findings.length} findings)`);

    // Publish to Kafka for lakehouse analytics
    try {
      await kafkaPublisher.publishComplianceCheck({
        checkId: ((result as any).insertId).toString(),
        ruleId: ruleId.toString(),
        jurisdiction: rule.jurisdiction,
        subjectType: scope.type,
        subjectId: scope.id?.toString() || 'platform',
        result: status === 'compliant' ? 'pass' : status === 'warning' ? 'warning' : 'fail',
        evidenceRef: evidenceReferences.length > 0 ? evidenceReferences[0] : undefined,
        timestamp: new Date(),
      });
    } catch (error) {
      console.error('[Compliance] Error publishing to Kafka:', error);
    }

    return {
      id: (result as any).insertId,
      ruleId,
      checkType: 'automated',
      scopeType: scope.type,
      scopeId: scope.id || null,
      checkedAt: new Date(),
      status,
      findings,
      evidenceReferences,
      checkedBy: 'system',
      reviewedBy: null,
      reviewedAt: null,
      nextCheckDue,
    };
  }

  /**
   * Check grid code compliance
   */
  private async checkGridCodeCompliance(
    rule: ComplianceRule,
    scope: { type: string; id?: number },
    findings: ComplianceFinding[],
    evidenceReferences: string[]
  ): Promise<void> {
    const db = await getDb();
    if (!db) return;

    const requirements = rule.requirements;

    // Get recent telemetry based on scope
    let telemetryQuery;
    if (scope.type === 'asset' && scope.id) {
      telemetryQuery = sql`
        SELECT voltage, frequency, power FROM telemetry
        WHERE assetId = ${scope.id}
          AND timestamp > DATE_SUB(NOW(), INTERVAL 1 HOUR)
        ORDER BY timestamp DESC
        LIMIT 100
      `;
    } else if (scope.type === 'user' && scope.id) {
      telemetryQuery = sql`
        SELECT t.voltage, t.frequency, t.power FROM telemetry t
        JOIN assets a ON a.id = t.assetId
        WHERE a.userId = ${scope.id}
          AND t.timestamp > DATE_SUB(NOW(), INTERVAL 1 HOUR)
        ORDER BY t.timestamp DESC
        LIMIT 100
      `;
    } else {
      return;
    }

    const telemetryResult = await db.execute(telemetryQuery);
    const telemetry = (telemetryResult as any)[0] || [];

    if (telemetry.length === 0) {
      findings.push({
        findingCode: 'NO_TELEMETRY_DATA',
        severity: 'minor',
        description: 'No recent telemetry data available for compliance check',
        requirement: 'Continuous monitoring required',
        actualValue: '0 readings',
        expectedValue: '> 0 readings',
        remediation: 'Verify device connectivity and telemetry reporting',
      });
      return;
    }

    evidenceReferences.push(`telemetry_count:${telemetry.length}`);

    // Check voltage compliance
    if (requirements.voltage_range) {
      const voltages = telemetry.filter((t: any) => t.voltage !== null).map((t: any) => t.voltage);
      if (voltages.length > 0) {
        const minVoltage = Math.min(...voltages);
        const maxVoltage = Math.max(...voltages);
        const avgVoltage = voltages.reduce((a: number, b: number) => a + b, 0) / voltages.length;

        if (minVoltage < requirements.voltage_range.min || maxVoltage > requirements.voltage_range.max) {
          findings.push({
            findingCode: 'VOLTAGE_OUT_OF_RANGE',
            severity: 'major',
            description: `Voltage readings outside acceptable range`,
            requirement: `Voltage must be between ${requirements.voltage_range.min}V and ${requirements.voltage_range.max}V`,
            actualValue: `Min: ${minVoltage.toFixed(1)}V, Max: ${maxVoltage.toFixed(1)}V, Avg: ${avgVoltage.toFixed(1)}V`,
            expectedValue: `${requirements.voltage_range.min}V - ${requirements.voltage_range.max}V`,
            remediation: 'Check voltage regulation equipment and grid connection',
          });
        }

        evidenceReferences.push(`voltage_range:${minVoltage.toFixed(1)}-${maxVoltage.toFixed(1)}`);
      }
    }

    // Check frequency compliance
    if (requirements.frequency_range) {
      const frequencies = telemetry.filter((t: any) => t.frequency !== null).map((t: any) => t.frequency);
      if (frequencies.length > 0) {
        const minFreq = Math.min(...frequencies);
        const maxFreq = Math.max(...frequencies);

        if (minFreq < requirements.frequency_range.min || maxFreq > requirements.frequency_range.max) {
          findings.push({
            findingCode: 'FREQUENCY_OUT_OF_RANGE',
            severity: 'critical',
            description: `Frequency readings outside acceptable range`,
            requirement: `Frequency must be between ${requirements.frequency_range.min}Hz and ${requirements.frequency_range.max}Hz`,
            actualValue: `Min: ${minFreq.toFixed(2)}Hz, Max: ${maxFreq.toFixed(2)}Hz`,
            expectedValue: `${requirements.frequency_range.min}Hz - ${requirements.frequency_range.max}Hz`,
            remediation: 'Immediate investigation required - potential grid instability',
          });
        }

        evidenceReferences.push(`frequency_range:${minFreq.toFixed(2)}-${maxFreq.toFixed(2)}`);
      }
    }
  }

  /**
   * Check data privacy compliance
   */
  private async checkDataPrivacyCompliance(
    rule: ComplianceRule,
    scope: { type: string; id?: number },
    findings: ComplianceFinding[],
    evidenceReferences: string[]
  ): Promise<void> {
    const db = await getDb();
    if (!db) return;

    const requirements = rule.requirements;

    // Check consent records
    if (requirements.consent_required) {
      const consentResult = await db.execute(sql`
        SELECT COUNT(*) as total,
               SUM(CASE WHEN consent_given = true THEN 1 ELSE 0 END) as consented
        FROM users
        WHERE status = 'active'
      `);
      const consentStats = (consentResult as any)[0]?.[0] || {};

      if (consentStats.total > 0 && consentStats.consented < consentStats.total) {
        findings.push({
          findingCode: 'MISSING_CONSENT',
          severity: 'major',
          description: 'Some users have not provided required consent',
          requirement: 'All users must provide explicit consent for data processing',
          actualValue: `${consentStats.consented}/${consentStats.total} users consented`,
          expectedValue: '100% consent rate',
          remediation: 'Request consent from users without consent records',
        });
      }

      evidenceReferences.push(`consent_rate:${consentStats.consented}/${consentStats.total}`);
    }

    // Check data retention
    if (requirements.data_retention_max_years) {
      const maxRetentionDays = requirements.data_retention_max_years * 365;
      const oldDataResult = await db.execute(sql`
        SELECT COUNT(*) as count FROM telemetry
        WHERE timestamp < DATE_SUB(NOW(), INTERVAL ${maxRetentionDays} DAY)
      `);
      const oldDataCount = (oldDataResult as any)[0]?.[0]?.count || 0;

      if (oldDataCount > 0) {
        findings.push({
          findingCode: 'DATA_RETENTION_EXCEEDED',
          severity: 'minor',
          description: `Data older than ${requirements.data_retention_max_years} years found`,
          requirement: `Data must be deleted after ${requirements.data_retention_max_years} years`,
          actualValue: `${oldDataCount} records exceed retention period`,
          expectedValue: '0 records exceeding retention',
          remediation: 'Run data retention cleanup job',
        });
      }

      evidenceReferences.push(`old_data_count:${oldDataCount}`);
    }
  }

  /**
   * Check reporting compliance
   */
  private async checkReportingCompliance(
    rule: ComplianceRule,
    scope: { type: string; id?: number },
    findings: ComplianceFinding[],
    evidenceReferences: string[]
  ): Promise<void> {
    const db = await getDb();
    if (!db) return;

    const requirements = rule.requirements;

    // Check if required reports have been submitted
    const lastMonth = new Date();
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    const lastMonthStart = new Date(lastMonth.getFullYear(), lastMonth.getMonth(), 1);
    const lastMonthEnd = new Date(lastMonth.getFullYear(), lastMonth.getMonth() + 1, 0);

    const reportResult = await db.execute(sql`
      SELECT * FROM compliance_reports
      WHERE jurisdiction = ${rule.jurisdiction}
        AND report_type = 'periodic'
        AND period_start >= ${lastMonthStart}
        AND period_end <= ${lastMonthEnd}
        AND status IN ('submitted', 'accepted')
      LIMIT 1
    `);

    const report = (reportResult as any)[0]?.[0];

    if (!report) {
      const deadlineDate = new Date(lastMonthEnd);
      deadlineDate.setDate(deadlineDate.getDate() + (requirements.submission_deadline_days || 15));
      const isOverdue = new Date() > deadlineDate;

      findings.push({
        findingCode: 'MISSING_PERIODIC_REPORT',
        severity: isOverdue ? 'major' : 'minor',
        description: `Monthly report for ${lastMonth.toLocaleString('default', { month: 'long', year: 'numeric' })} not submitted`,
        requirement: `Submit monthly report within ${requirements.submission_deadline_days || 15} days`,
        actualValue: 'Report not found',
        expectedValue: 'Report submitted',
        remediation: 'Generate and submit required monthly report',
      });
    }

    evidenceReferences.push(`report_period:${lastMonthStart.toISOString().split('T')[0]}`);
  }

  /**
   * Check consumer protection compliance
   */
  private async checkConsumerProtectionCompliance(
    rule: ComplianceRule,
    scope: { type: string; id?: number },
    findings: ComplianceFinding[],
    evidenceReferences: string[]
  ): Promise<void> {
    const db = await getDb();
    if (!db) return;

    const requirements = rule.requirements;

    // Check complaint response times
    if (requirements.complaint_response_hours) {
      const overdueResult = await db.execute(sql`
        SELECT COUNT(*) as count FROM support_tickets
        WHERE status = 'open'
          AND created_at < DATE_SUB(NOW(), INTERVAL ${requirements.complaint_response_hours} HOUR)
      `);
      const overdueCount = (overdueResult as any)[0]?.[0]?.count || 0;

      if (overdueCount > 0) {
        findings.push({
          findingCode: 'COMPLAINT_RESPONSE_OVERDUE',
          severity: 'minor',
          description: `${overdueCount} complaints exceed response time requirement`,
          requirement: `Respond to complaints within ${requirements.complaint_response_hours} hours`,
          actualValue: `${overdueCount} overdue complaints`,
          expectedValue: '0 overdue complaints',
          remediation: 'Address overdue complaints immediately',
        });
      }

      evidenceReferences.push(`overdue_complaints:${overdueCount}`);
    }

    // Check service availability
    if (requirements.service_availability) {
      // Calculate platform uptime (simplified)
      const uptimeResult = await db.execute(sql`
        SELECT 
          COUNT(*) as total_checks,
          SUM(CASE WHEN status = 'healthy' THEN 1 ELSE 0 END) as healthy_checks
        FROM health_checks
        WHERE checked_at > DATE_SUB(NOW(), INTERVAL 30 DAY)
      `);
      const uptimeStats = (uptimeResult as any)[0]?.[0] || {};

      if (uptimeStats.total_checks > 0) {
        const availability = uptimeStats.healthy_checks / uptimeStats.total_checks;
        if (availability < requirements.service_availability) {
          findings.push({
            findingCode: 'SERVICE_AVAILABILITY_LOW',
            severity: 'major',
            description: `Service availability below required threshold`,
            requirement: `Maintain ${requirements.service_availability * 100}% service availability`,
            actualValue: `${(availability * 100).toFixed(2)}%`,
            expectedValue: `>= ${requirements.service_availability * 100}%`,
            remediation: 'Investigate and address service reliability issues',
          });
        }

        evidenceReferences.push(`availability:${(availability * 100).toFixed(2)}%`);
      }
    }
  }

  /**
   * Check safety compliance
   */
  private async checkSafetyCompliance(
    rule: ComplianceRule,
    scope: { type: string; id?: number },
    findings: ComplianceFinding[],
    evidenceReferences: string[]
  ): Promise<void> {
    const db = await getDb();
    if (!db) return;

    // Check for unresolved critical anomalies
    const criticalAnomaliesResult = await db.execute(sql`
      SELECT COUNT(*) as count FROM anomaly_events
      WHERE severity IN ('critical', 'emergency')
        AND resolved_at IS NULL
    `);
    const criticalCount = (criticalAnomaliesResult as any)[0]?.[0]?.count || 0;

    if (criticalCount > 0) {
      findings.push({
        findingCode: 'UNRESOLVED_SAFETY_ISSUES',
        severity: 'critical',
        description: `${criticalCount} critical safety anomalies unresolved`,
        requirement: 'All critical safety issues must be resolved promptly',
        actualValue: `${criticalCount} unresolved`,
        expectedValue: '0 unresolved',
        remediation: 'Immediately address all critical safety anomalies',
      });
    }

    evidenceReferences.push(`critical_anomalies:${criticalCount}`);
  }

  /**
   * Generate compliance report
   */
  async generateComplianceReport(
    jurisdiction: string,
    periodStart: Date,
    periodEnd: Date,
    reportType: ComplianceReport['reportType'] = 'periodic'
  ): Promise<ComplianceReport> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const reportId = `CR_${jurisdiction}_${Date.now().toString(36)}`;
    const sections: ComplianceReportSection[] = [];

    // Get all checks for the period
    const checksResult = await db.execute(sql`
      SELECT cc.*, cr.rule_code, cr.rule_name, cr.rule_category
      FROM compliance_checks cc
      JOIN compliance_rules cr ON cr.id = cc.rule_id
      WHERE cr.jurisdiction = ${jurisdiction}
        AND cc.checked_at >= ${periodStart}
        AND cc.checked_at <= ${periodEnd}
      ORDER BY cr.rule_category, cc.checked_at DESC
    `);
    const checks = (checksResult as any)[0] || [];

    // Group checks by category
    const checksByCategory: Map<string, ComplianceCheck[]> = new Map();
    for (const check of checks) {
      const category = check.rule_category;
      if (!checksByCategory.has(category)) {
        checksByCategory.set(category, []);
      }
      checksByCategory.get(category)!.push(this.mapRowToCheck(check));
    }

    // Create sections
    for (const [category, categoryChecks] of Array.from(checksByCategory.entries())) {
      const compliantCount = categoryChecks.filter((c: ComplianceCheck) => c.status === 'compliant').length;
      const totalCount = categoryChecks.length;

      sections.push({
        sectionName: category.replace('_', ' ').toUpperCase(),
        content: {
          totalChecks: totalCount,
          compliantChecks: compliantCount,
          complianceRate: totalCount > 0 ? (compliantCount / totalCount * 100).toFixed(1) + '%' : 'N/A',
          summary: `${compliantCount} of ${totalCount} checks passed`,
        },
        checkResults: categoryChecks,
      });
    }

    // Store report
    const result = await db.execute(sql`
      INSERT INTO compliance_reports (
        report_id, report_type, jurisdiction,
        period_start, period_end, generated_at,
        status, sections, attachments, created_at
      ) VALUES (
        ${reportId}, ${reportType}, ${jurisdiction},
        ${periodStart}, ${periodEnd}, NOW(),
        'draft', ${JSON.stringify(sections)}, '[]', NOW()
      )
    `);

    console.log(`[Compliance] Generated report ${reportId} with ${sections.length} sections`);

    return {
      reportId,
      reportType,
      jurisdiction,
      periodStart,
      periodEnd,
      generatedAt: new Date(),
      submittedAt: null,
      submittedTo: null,
      status: 'draft',
      sections,
      attachments: [],
    };
  }

  /**
   * Get rule by ID
   */
  async getRule(ruleId: number): Promise<ComplianceRule | null> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const result = await db.execute(sql`
      SELECT * FROM compliance_rules WHERE id = ${ruleId}
    `);

    const row = (result as any)[0]?.[0];
    return row ? this.mapRowToRule(row) : null;
  }

  /**
   * Get compliance summary for a scope
   */
  async getComplianceSummary(
    scope: { type: 'user' | 'asset' | 'community' | 'platform'; id?: number },
    jurisdiction: string
  ): Promise<{
    overallStatus: 'compliant' | 'non_compliant' | 'warning' | 'unknown';
    totalRules: number;
    compliantRules: number;
    warningRules: number;
    nonCompliantRules: number;
    lastCheckDate: Date | null;
    nextCheckDue: Date | null;
    criticalFindings: ComplianceFinding[];
  }> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    // Get latest check for each rule
    const checksResult = await db.execute(sql`
      SELECT cc.*, cr.rule_code FROM compliance_checks cc
      JOIN compliance_rules cr ON cr.id = cc.rule_id
      WHERE cr.jurisdiction = ${jurisdiction}
        AND cc.scope_type = ${scope.type}
        AND (cc.scope_id = ${scope.id || null} OR cc.scope_id IS NULL)
      ORDER BY cc.rule_id, cc.checked_at DESC
    `);

    const checks = (checksResult as any)[0] || [];
    const latestByRule: Map<number, any> = new Map();
    
    for (const check of checks) {
      if (!latestByRule.has(check.rule_id)) {
        latestByRule.set(check.rule_id, check);
      }
    }

    const latestChecks = Array.from(latestByRule.values());

    let compliantRules = 0;
    let warningRules = 0;
    let nonCompliantRules = 0;
    let lastCheckDate: Date | null = null;
    let nextCheckDue: Date | null = null;
    const criticalFindings: ComplianceFinding[] = [];

    for (const check of latestChecks) {
      if (check.status === 'compliant') compliantRules++;
      else if (check.status === 'warning') warningRules++;
      else if (check.status === 'non_compliant') nonCompliantRules++;

      if (!lastCheckDate || new Date(check.checked_at) > lastCheckDate) {
        lastCheckDate = new Date(check.checked_at);
      }

      if (check.next_check_due) {
        const checkDue = new Date(check.next_check_due);
        if (!nextCheckDue || checkDue < nextCheckDue) {
          nextCheckDue = checkDue;
        }
      }

      // Collect critical findings
      const findings: ComplianceFinding[] = check.findings ? JSON.parse(check.findings) : [];
      criticalFindings.push(...findings.filter(f => f.severity === 'critical'));
    }

    const totalRules = latestChecks.length;
    let overallStatus: 'compliant' | 'non_compliant' | 'warning' | 'unknown' = 'unknown';
    
    if (totalRules > 0) {
      if (nonCompliantRules > 0) overallStatus = 'non_compliant';
      else if (warningRules > 0) overallStatus = 'warning';
      else overallStatus = 'compliant';
    }

    return {
      overallStatus,
      totalRules,
      compliantRules,
      warningRules,
      nonCompliantRules,
      lastCheckDate,
      nextCheckDue,
      criticalFindings,
    };
  }

  /**
   * Calculate next check due date
   */
  private calculateNextCheckDue(frequency: ComplianceRule['checkFrequency']): Date {
    const now = new Date();
    switch (frequency) {
      case 'realtime':
        return new Date(now.getTime() + 5 * 60000); // 5 minutes
      case 'hourly':
        return new Date(now.getTime() + 3600000);
      case 'daily':
        return new Date(now.getTime() + 24 * 3600000);
      case 'weekly':
        return new Date(now.getTime() + 7 * 24 * 3600000);
      case 'monthly':
        return new Date(now.getFullYear(), now.getMonth() + 1, 1);
      case 'quarterly':
        return new Date(now.getFullYear(), now.getMonth() + 3, 1);
      case 'annually':
        return new Date(now.getFullYear() + 1, 0, 1);
      default:
        return new Date(now.getTime() + 24 * 3600000);
    }
  }

  private mapRowToRule(row: any): ComplianceRule {
    return {
      id: row.id,
      ruleCode: row.rule_code,
      jurisdiction: row.jurisdiction,
      regulatoryBody: row.regulatory_body,
      ruleCategory: row.rule_category,
      ruleName: row.rule_name,
      description: row.description,
      requirements: row.requirements ? JSON.parse(row.requirements) : {},
      checkFrequency: row.check_frequency,
      effectiveFrom: row.effective_from,
      effectiveUntil: row.effective_until,
      penaltyDescription: row.penalty_description,
      automatedCheckEnabled: row.automated_check_enabled,
      status: row.status,
    };
  }

  private mapRowToCheck(row: any): ComplianceCheck {
    return {
      id: row.id,
      ruleId: row.rule_id,
      checkType: row.check_type,
      scopeType: row.scope_type,
      scopeId: row.scope_id,
      checkedAt: row.checked_at,
      status: row.status,
      findings: row.findings ? JSON.parse(row.findings) : [],
      evidenceReferences: row.evidence_references ? JSON.parse(row.evidence_references) : [],
      checkedBy: row.checked_by,
      reviewedBy: row.reviewed_by,
      reviewedAt: row.reviewed_at,
      nextCheckDue: row.next_check_due,
    };
  }
}

// Singleton instance
export const complianceAutomation = new ComplianceAutomationService();
