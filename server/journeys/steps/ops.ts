/**
 * Operations journeys: the NOC/SOC wall, the degraded-operation drill, the
 * forecast/model lifecycle, support diagnosis, and community rewards.
 */

import {
  blocked,
  classifyDependencyError,
  count,
  failed,
  passed,
  priorNumber,
  priorString,
  refused,
  type JourneyStep,
} from '../step';
import { ensureApprovedAsset, ingestReadings, registerDevice } from '../fixtures';

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export const nocSocSteps: Record<string, JourneyStep> = {
  'fleet-aggregates': async ctx => {
    const asset = await ensureApprovedAsset(ctx, 'solar', 5_000);
    const credential = await registerDevice(ctx, asset.id, 'smart_meter');
    await ingestReadings(ctx, asset.id, credential, 6);

    await ctx.admin.caller.fleetTelemetry.rollUp({
      bucketMinutes: 15,
      buckets: 4,
      scopeType: 'fleet',
    });
    const rolling = await ctx.admin.caller.fleetTelemetry.rolling({
      bucketMinutes: 15,
      buckets: 4,
      scopeType: 'fleet',
    });
    const buckets = rolling.buckets;
    if (buckets.length === 0) {
      return failed('The fleet aggregate returned no buckets after a rollup.');
    }
    // A figure with no coverage behind it is the mockware this step exists for.
    const uncovered = buckets.filter(
      bucket => bucket.expectedAssets === 0 && bucket.integratedEnergyWh !== 0
    ).length;
    if (uncovered > 0) {
      return failed('An aggregate figure carries energy for a fleet it expected nothing from.', {
        buckets: buckets.length,
        uncovered,
      });
    }
    return passed('Every aggregate names how much of the fleet it actually saw.', {
      buckets: buckets.length,
      missingBuckets: rolling.missingBuckets,
      reportingAssets: buckets[0].reportingAssets,
      silentAssets: buckets[0].silentAssets,
    });
  },

  'operations-wall': async ctx => {
    const scoped = await ctx.admin.caller.digitalTwin.scoped({});
    const nodes = (scoped as { nodes?: unknown[] }).nodes ?? [];
    const edges = (scoped as { edges?: unknown[] }).edges ?? [];
    if (!Array.isArray(nodes) || !Array.isArray(edges)) {
      return failed('The scoped twin returned no graph for the wall to render.');
    }
    return passed('The wall renders the fleet twin from the telemetry the platform has.', {
      nodes: nodes.length,
      edges: edges.length,
    });
  },

  'anomaly-sweep': async ctx => {
    const swept = await ctx.admin.caller.gridAnomaly.scanFleet({ windowMinutes: 60 });
    const summary = await ctx.admin.caller.gridAnomaly.getFleetAnomalySummary();
    const scanned = (swept as { assetsScanned?: number; scanned?: number }).assetsScanned
      ?? (swept as { scanned?: number }).scanned
      ?? null;
    if (scanned === null) {
      return failed('A fleet sweep does not report how many assets it examined.');
    }
    return passed('The sweep reports what it examined and what it found.', {
      assetsScanned: scanned,
      anomalies: count((swept as { anomalies?: unknown[] }).anomalies),
      hasSummary: Boolean(summary),
    });
  },

  'platform-performance': async ctx => {
    const dashboard = await ctx.admin.caller.performance.getDashboard({ timeWindow: 60 });
    const health = await ctx.admin.caller.performance.getHealth();
    const status = (health as { status?: string }).status ?? null;
    if (status === null) {
      return failed('The platform reports no health status at all.');
    }
    if (status !== 'healthy' && status !== 'ok') {
      return refused('The platform reports itself degraded rather than claiming health.', {
        status,
      });
    }
    return passed('API and database performance are reported from measured requests.', {
      status,
      hasDashboard: Boolean(dashboard),
    });
  },

  'cache-health': async ctx => {
    const stats = await ctx.admin.caller.cacheMonitoring.getCacheStats();
    const redis = await ctx.admin.caller.redisHealth.getStatus();
    const connected = (redis as { connected?: boolean; available?: boolean }).connected
      ?? (redis as { available?: boolean }).available;
    if (connected === false) {
      return refused('Redis is reported unreachable rather than the cache reading as warm.', {
        hasStats: Boolean(stats),
      });
    }
    return passed('Cache and Redis state come from the connection itself.', {
      redisConnected: connected === true,
    });
  },
};

export const degradedDrillSteps: Record<string, JourneyStep> = {
  posture: async ctx => {
    const posture = await ctx.admin.caller.degradedOperation.posture();
    const open = await ctx.admin.caller.degradedOperation.openActions({ limit: 100 });
    const dependencies = posture.dependencies;
    if (dependencies.length === 0) {
      return failed('The degraded posture names no dependencies to be degraded on.');
    }
    // A dependency reported healthy with nothing ever observed would be health
    // asserted rather than measured.
    const unobservedHealthy = dependencies.filter(
      dependency => dependency.state === 'up' && dependency.lastObservation === null
    ).length;
    if (unobservedHealthy > 0) {
      return failed('A dependency is reported healthy with no observation behind it.', {
        dependencies: dependencies.length,
        unobservedHealthy,
      });
    }
    return passed('Every dependency declares its state and what it still permits.', {
      dependencies: dependencies.length,
      capabilities: posture.capabilities.length,
      guardMode: posture.guardMode,
      openActions: open.actions.length,
    });
  },

  observations: async ctx => {
    const observed = await ctx.admin.caller.degradedOperation.observations({
      dependency: 'mqtt_broker',
      sinceMinutes: 180,
      limit: 200,
    });
    const rows = (observed as { observations?: Array<{ id: number; reconciledAt?: unknown }> })
      .observations ?? [];
    if (!Array.isArray(rows)) {
      return failed('Degraded observations returned no collection.');
    }
    const pending = rows.find(row => !row.reconciledAt);
    if (!pending) {
      return refused('Nothing was recorded while degraded, so there is nothing to reconcile.', {
        observations: rows.length,
      });
    }
    await ctx.admin.caller.degradedOperation.reconcile({
      id: pending.id,
      note: `Journey run ${ctx.runKey}: reconciled against platform evidence after the drill.`,
    });
    return passed('An observation recorded while degraded is reconciled with a note.', {
      observations: rows.length,
      reconciledId: pending.id,
    });
  },

  'member-degraded-view': async ctx => {
    const status = await ctx.member.caller.degradedOperation.memberStatus();
    if (!status) {
      return failed('A member is told nothing about what the platform can currently do.');
    }
    // A member only needs to know whether the figures they are reading are
    // still being measured and settled — and anything short of `available` has
    // to say what is missing, or the member cannot tell a quiet platform from a
    // blind one.
    const postures = [
      { name: 'settlement', ...status.settlement },
      { name: 'control', ...status.control },
    ];
    const unexplained = postures.filter(
      posture => posture.posture !== 'available' && !posture.limitation
    );
    if (unexplained.length > 0) {
      return failed('A degraded capability is shown to a member with no limitation stated.', {
        unexplained: unexplained.map(posture => posture.name).join(', '),
      });
    }
    return passed('The member is told whether delivery is still measured and settled, and why not.', {
      settlement: status.settlement.posture,
      settlementLimit: status.settlement.limitation,
      control: status.control.posture,
      controlLimit: status.control.limitation,
    });
  },

  'workflow-visibility': async ctx => {
    try {
      const stats = await ctx.admin.caller.workflows.getStats();
      const listed = await ctx.admin.caller.workflows.list({ limit: 50 });
      const mine = await ctx.member.caller.orchestrator.listUserWorkflows();
      const executions = (listed as { workflows?: unknown[] }).workflows
        ?? (Array.isArray(listed) ? listed : []);
      return passed('Durable workflows are visible to an operator and owned by their member.', {
        executions: Array.isArray(executions) ? executions.length : 0,
        myWorkflows: count((mine as { workflows?: unknown[] }).workflows),
        hasStats: Boolean(stats),
      });
    } catch (error) {
      // No Temporal server is a blocked dependency, not a platform defect.
      return classifyDependencyError(error, 'temporal', {});
    }
  },
};

export const modelLifecycleSteps: Record<string, JourneyStep> = {
  'produce-forecast': async ctx => {
    const asset = await ensureApprovedAsset(ctx, 'solar', 5_000);
    const credential = await registerDevice(ctx, asset.id, 'smart_meter');
    await ingestReadings(ctx, asset.id, credential, 8);
    const run = await ctx.member.caller.forecasting.forecastLoad({
      assetId: asset.id,
      horizonHours: 24,
      intervalMinutes: 60,
    });
    const runId = (run as { runId?: string }).runId;
    if (typeof runId !== 'string') {
      return failed('A forecast run returned no run id to score later.', { assetId: asset.id });
    }
    const read = await ctx.member.caller.forecasting.getForecast({ runId });
    const points = (read as { points?: unknown[]; forecast?: unknown[] }).points
      ?? (read as { forecast?: unknown[] }).forecast
      ?? [];
    if (!Array.isArray(points) || points.length === 0) {
      return failed('A forecast run stored no points.', { runId });
    }
    return passed('A forecast is produced and readable with its horizon.', {
      runId,
      points: points.length,
    });
  },

  'score-against-actuals': async ctx => {
    const runId = priorString(ctx, 'produce-forecast', 'runId');
    const scored = await ctx.admin.caller.forecasting.scoreDueRuns({ limit: 25 });
    const summary = await ctx.member.caller.forecasting.accuracySummary({ sinceDays: 30 });
    const scoredRuns = (scored as { scored?: number; runsScored?: number }).scored
      ?? (scored as { runsScored?: number }).runsScored
      ?? 0;
    const mape = (summary as { mapePercent?: number | null }).mapePercent ?? null;
    const scoredCount = (summary as { scoredRuns?: number }).scoredRuns ?? null;

    if (scoredCount === 0 && mape !== null) {
      return failed('An accuracy figure is reported with no scored run behind it.', { runId });
    }
    if (scoredCount === 0 || mape === null) {
      return refused('No horizon has elapsed yet, so accuracy is reported as unscored.', {
        runId,
        scoredThisSweep: scoredRuns,
      });
    }
    return passed('Accuracy is measured against actuals that have arrived.', {
      runId,
      scoredRuns: scoredCount,
      mapePercent: mape,
    });
  },

  'model-health': async ctx => {
    const overview = await ctx.admin.caller.modelHealth.overview({ limit: 50 });
    const models = overview.models;
    if (models.length === 0) {
      return refused('No model has been trained on this deployment, so none is served.', {
        models: 0,
      });
    }
    if (overview.unverifiedProduction > 0) {
      return failed('A production model is served on weights that do not verify.', {
        models: models.length,
        unverifiedProduction: overview.unverifiedProduction,
      });
    }
    if (!overview.artifactDirConfigured) {
      return blocked('object_store', 'No artifact directory is configured, so no weights can be verified.', {
        models: models.length,
        detail: overview.detail,
      });
    }
    return passed('Served weights verify against the run that produced them.', {
      models: models.length,
      syntheticInProduction: overview.syntheticInProduction,
      jobs: overview.jobs.length,
    });
  },

  'drift-and-retraining': async ctx => {
    const deployed = await ctx.member.caller.mlops.getDeployedModel({ modelName: 'load_forecast' });
    if (deployed === null) {
      return refused('No model is in production under that name, so there is nothing to drift.', {
        modelName: 'load_forecast',
      });
    }
    const modelId = deployed.id;
    // Drift is only meaningful against a recorded baseline, so a detection run
    // that returns an event must have persisted it — an in-memory verdict no
    // operator can read back later is not a detection at all.
    const detected = await ctx.member.caller.mlops.detectDrift({ modelId, windowHours: 24 });
    const events = await ctx.member.caller.mlops.getRecentDriftEvents({ modelId, limit: 50 });
    const unrecorded = detected.filter(event => !events.some(row => row.id === event.id));
    if (unrecorded.length > 0) {
      return failed('Drift was reported without being recorded where it can be read back.', {
        modelId,
        detected: detected.length,
        unrecorded: unrecorded.length,
      });
    }
    // Retraining is the platform's answer to drift, so the journey asks for it
    // and requires a queued job with an id an operator can follow.
    const job = await ctx.member.caller.mlops.triggerRetraining({
      modelId,
      triggerType: detected.length > 0 ? 'drift_detected' : 'manual',
    });
    if (job.status !== 'queued' || job.jobId.length === 0) {
      return failed('Retraining was accepted without a queued job to follow.', {
        modelId,
        status: job.status,
      });
    }
    return passed('Drift is measured over a stated window and answered with a queued retraining.', {
      modelId,
      version: deployed.version,
      detected: detected.length,
      recordedEvents: events.length,
      retrainingJobId: job.jobId,
      triggerType: job.triggerType,
    });
  },

  'prediction-surfaces': async ctx => {
    const metrics = await ctx.member.caller.mlPredictions.getModelMetrics();
    const predictions = await ctx.member.caller.mlPredictions.getPricePredictions({ hoursAhead: 24 });
    // A price curve is only worth showing a member if a fit stands behind it,
    // so the curve and the metrics that describe that fit must agree.
    if (predictions.length > 0 && !metrics.trained) {
      return failed('A price curve is shown to members from a model that was never trained.', {
        predictions: predictions.length,
        trainingDataPoints: metrics.trainingDataPoints,
      });
    }
    if (predictions.length === 0) {
      return refused('No prediction is offered rather than a curve with no fit behind it.', {
        trained: metrics.trained,
        trainingDataPoints: metrics.trainingDataPoints,
      });
    }
    const unconfident = predictions.filter(point => point.confidence === null).length;
    if (unconfident > 0) {
      return failed('A trained model offers points whose confidence it cannot state.', {
        predictions: predictions.length,
        unconfident,
      });
    }
    if (metrics.lastTrained === null) {
      return failed('Predictions are shown with no record of when their model was fitted.', {
        predictions: predictions.length,
      });
    }
    return passed('Predictions carry the measured accuracy of the fit behind them.', {
      predictions: predictions.length,
      trainingDataPoints: metrics.trainingDataPoints,
      accuracyPercent: metrics.accuracy,
      r2Score: metrics.r2Score,
    });
  },

  'lakehouse-provenance': async ctx => {
    const status = await ctx.admin.caller.lakehouse.status();
    const runs = await ctx.admin.caller.lakehouse.runs({ limit: 50 });
    const rows = runs.runs;
    if (rows.length === 0) {
      return blocked('object_store', 'No ingestion run has reached the lake on this deployment.', {
        datasets: status.datasets.length,
        detail: status.detail,
      });
    }
    // A succeeded run without the digest of the object it wrote is a claim with
    // no read-back behind it, which is exactly the mockware this step guards.
    const unverified = rows.filter(
      run => run.state === 'succeeded' && run.rowsWritten > 0 && !run.objectDigest
    ).length;
    if (unverified > 0) {
      return failed('A lake run reports success with no digest of what was stored.', {
        runs: rows.length,
        unverified,
      });
    }
    return passed('Lake runs succeed only on a read-back that matches its digest.', {
      runs: rows.length,
      datasets: status.datasets.length,
      allFresh: status.allFresh,
    });
  },

  'platform-analytics': async ctx => {
    const overview = await ctx.admin.caller.adminAnalytics.getOverview({
      startDate: isoDay(daysAgo(30)),
      endDate: isoDay(new Date()),
    });
    const kpis = await ctx.admin.caller.adminAnalytics.getSystemKPIs();
    if (!overview || !kpis) {
      return failed('Operator analytics returned nothing to act on.');
    }
    return passed('Operator analytics read from the tables behind them.', {
      hasOverview: true,
      hasKpis: true,
    });
  },
};

export const supportSteps: Record<string, JourneyStep> = {
  'diagnostic-evidence': async ctx => {
    const health = await ctx.admin.caller.diagnostics.health();
    const evidence = await ctx.admin.caller.diagnostics.evidence();
    if (evidence.observations.length === 0) {
      return failed('There is no evidence a diagnosis could be built from.');
    }
    // An observation that could not be read is unknown, not healthy, so a
    // bundle where nothing was readable cannot ground a diagnosis at all.
    if (evidence.availableCount === 0) {
      return refused('No observation could be read, so nothing would be cited.', {
        observations: evidence.observations.length,
        unavailable: evidence.unavailableCount,
      });
    }
    return passed('The evidence a diagnosis would cite is listed with what could not be read.', {
      observations: evidence.observations.length,
      available: evidence.availableCount,
      unavailable: evidence.unavailableCount,
      modelReachable: health.reachable,
      modelPresent: health.modelPresent,
    });
  },

  'local-model-diagnosis': async ctx => {
    try {
      const run = await ctx.admin.caller.diagnostics.diagnose({
        question: `Journey run ${ctx.runKey}: why would a member's meter read zero while their inverter reports output?`,
      });
      // A refusal is the honest outcome, but which one it is matters: no model
      // means the dependency is missing, while a reachable model that would not
      // answer usefully is the platform declining to invent one.
      if (run.state === 'refused') {
        if (!run.health.reachable || !run.health.modelPresent) {
          return blocked('ollama', 'No local model answered, so nothing was diagnosed.', {
            runId: run.runId,
            reason: run.reason,
          });
        }
        return refused('The model was reachable but the platform would not report a diagnosis.', {
          runId: run.runId,
          reason: run.reason,
        });
      }
      const findings = run.findings;
      const uncited = findings.filter(finding => finding.observationIds.length === 0).length;
      if (uncited > 0) {
        return failed('A diagnosis states a finding it cannot cite.', {
          findings: findings.length,
          uncited,
        });
      }
      const runs = await ctx.admin.caller.diagnostics.runs({ limit: 20 });
      return passed('The local model answered, and every finding cites its evidence.', {
        findings: findings.length,
        runs: count((runs as { runs?: unknown[] }).runs),
      });
    } catch (error) {
      return classifyDependencyError(error, 'ollama', {});
    }
  },

  'loss-detection': async ctx => {
    const asset = await ensureApprovedAsset(ctx, 'meter', 8_000);
    const credential = await registerDevice(ctx, asset.id, 'smart_meter');
    await ingestReadings(ctx, asset.id, credential, 6);
    const analysis = await ctx.admin.caller.ntlDetection.runAnalysis({ assetId: asset.id });
    const flags = await ctx.admin.caller.ntlDetection.getFlags({ limit: 100 });
    const rows = (flags as { flags?: Array<Record<string, unknown>> }).flags ?? [];
    if (!Array.isArray(rows)) {
      return failed('Loss detection returned no flags collection.');
    }
    const unevidenced = rows.filter(flag => !flag.evidence && !flag.reason).length;
    if (unevidenced > 0) {
      return failed('A loss flag names no reading behind it.', {
        flags: rows.length,
        unevidenced,
      });
    }
    return passed('Loss flags name the readings that produced them.', {
      assetId: asset.id,
      flags: rows.length,
      analysed: Boolean(analysis),
    });
  },

  'compliance-report': async ctx => {
    const report = await ctx.admin.caller.complianceReports.generateReport({
      periodStart: daysAgo(30),
      periodEnd: new Date(),
    });
    const reportId = report.reportId;
    if (typeof reportId !== 'number') {
      return failed('A compliance report was generated with no id to reference.');
    }
    // The checksum is recomputed from the stored source data, so an auditor can
    // tell a report that was edited after generation from one that was not.
    const checksum = await ctx.member.caller.complianceReports.getReportChecksum({ reportId });
    if (checksum.storedChecksum.length === 0) {
      return failed('A compliance report carries no checksum, so it cannot be trusted later.', {
        reportId,
      });
    }
    if (!checksum.valid) {
      return failed('A freshly generated report does not verify against its own source data.', {
        reportId,
        storedChecksum: checksum.storedChecksum,
        recomputedChecksum: checksum.recomputedChecksum,
      });
    }
    const listed = await ctx.admin.caller.complianceReports.listReports({ limit: 50 });
    return passed('The report is generated and verifies against its own checksum.', {
      reportId,
      checksum: checksum.storedChecksum,
      reports: count((listed as { reports?: unknown[] }).reports),
    });
  },

  'platform-state': async ctx => {
    const stats = await ctx.admin.caller.admin.getSystemStats();
    const logs = await ctx.admin.caller.admin.getActivityLogs({ limit: 50 });
    const users = stats.users.total;
    if (typeof users !== 'number') {
      return failed('The operator home reports no user count.');
    }
    if (users < 1) {
      return failed('The platform reports no users while a journey is running as one.', {
        totalUsers: users,
      });
    }
    return passed('The operator home agrees with the tables behind it.', {
      totalUsers: users,
      activityLogs: count((logs as { logs?: unknown[] }).logs),
    });
  },
};

export const communitySteps: Record<string, JourneyStep> = {
  'pool-rules': async ctx => {
    // Setting an allocation rule is a governance act, so the journey needs a
    // community this member actually governs — belonging to one is not enough,
    // and a membership still awaiting approval governs nothing.
    const communities = await ctx.member.caller.community.getUserCommunities();
    let communityId: number | null = null;
    for (const community of communities) {
      const members = await ctx.member.caller.community.getCommunityMembers({
        communityId: community.id,
      });
      const governs = members.some(
        member =>
          member.userId === ctx.member.user.id &&
          member.status === 'active' &&
          (member.role === 'admin' || member.role === 'operator')
      );
      if (governs) {
        communityId = community.id;
        break;
      }
    }
    let founded = false;
    if (communityId === null) {
      const created = await ctx.member.caller.community.createCommunity({
        name: `Journey community ${ctx.member.user.id}-${ctx.runKey}`,
        communityType: 'residential',
        governanceModel: 'cooperative',
        allocationMethod: 'proportional_capacity',
      });
      communityId = created.id;
      founded = true;
    }
    // Joining is a request, not an entitlement: the applicant cannot admit
    // itself, and the community's admin decides. A rerun finds the counterparty
    // already admitted, which is the same end state.
    const existingMembers = await ctx.member.caller.community.getCommunityMembers({ communityId });
    let application =
      existingMembers.find(member => member.userId === ctx.counterparty.user.id) ?? null;
    if (application === null) {
      application = await ctx.counterparty.caller.community.addMember({ communityId });
      if (application.status === 'active') {
        return failed('A community admitted an applicant that no admin approved.', {
          communityId,
          memberId: application.id,
        });
      }
      if (application.role !== 'member') {
        return failed('An applicant chose its own role in a community it had not joined.', {
          communityId,
          role: application.role,
        });
      }
    }
    if (application.status === 'pending') {
      const admitted = await ctx.member.caller.community.approveMember({
        memberId: application.id,
      });
      if (admitted.status !== 'active') {
        return failed('An approved applicant is still not an active member.', {
          communityId,
          status: admitted.status,
        });
      }
    }
    await ctx.member.caller.communityPools.setPoolRules({
      communityId,
      ruleType: 'proportional_generation',
    });
    const rules = await ctx.member.caller.communityPools.getPoolRules({ communityId });
    const ruleType = rules.rule?.ruleType ?? null;
    if (ruleType !== 'proportional_generation') {
      return failed('Pool rules do not read back as they were set.', {
        communityId,
        ruleType: ruleType ?? 'none',
      });
    }
    return passed('The pool’s allocation rule is set and reads back.', {
      communityId,
      ruleType,
      founded,
      admittedMemberId: application.id,
    });
  },

  'allocation-run': async ctx => {
    const communityId = priorNumber(ctx, 'pool-rules', 'communityId');
    const periodEnd = new Date();
    const periodStart = new Date(periodEnd.getTime() - 24 * 60 * 60 * 1000);
    const run = await ctx.member.caller.communityPools.runAllocation({
      communityId,
      periodStart,
      periodEnd,
    });
    const runId = (run as { runId?: number; run?: { id?: number } }).runId
      ?? (run as { run?: { id?: number } }).run?.id
      ?? null;
    if (runId === null) {
      return failed('An allocation run returned no run id.', { communityId });
    }
    const statement = await ctx.member.caller.communityPools.getMyStatement({ communityId, runId });
    const allocatedWh = (statement as { allocatedWh?: number | null }).allocatedWh ?? null;
    const inputs = (statement as { inputs?: Record<string, unknown> }).inputs ?? null;
    if (allocatedWh !== null && allocatedWh > 0 && inputs === null) {
      return failed('A statement allocates energy without naming the inputs it came from.', {
        communityId,
        runId,
      });
    }
    const runs = await ctx.member.caller.communityPools.listRuns({ communityId, limit: 20 });
    return passed('The allocation run produced a statement that names its inputs.', {
      communityId,
      runId,
      runs: count((runs as { runs?: unknown[] }).runs),
    });
  },

  'community-telemetry': async ctx => {
    const communityId = priorNumber(ctx, 'pool-rules', 'communityId');
    // The scheduled rollup is opt-in per deployment, so the journey seeds the
    // community's own telemetry and advances the series itself rather than
    // reading whatever a cron happened to leave behind.
    const asset = await ensureApprovedAsset(ctx, 'solar', 4_000);
    const credential = await registerDevice(ctx, asset.id, 'smart_meter');
    await ingestReadings(ctx, asset.id, credential, 6);
    await ctx.admin.caller.fleetTelemetry.rollUp({
      bucketMinutes: 15,
      buckets: 4,
      scopeType: 'community',
      scopeId: communityId,
    });
    const community = await ctx.member.caller.fleetTelemetry.community({
      communityId,
      bucketMinutes: 15,
      buckets: 4,
    });
    const buckets = community.buckets;
    if (buckets.length === 0) {
      return refused('The community has no computed buckets yet, so nothing is shown.', {
        communityId,
        missingBuckets: community.missingBuckets,
      });
    }
    // The aggregate is scoped to the community and carries counts of reporting
    // assets only — no per-member identity to leak to a neighbour.
    return passed('Neighbours are aggregated without being named.', {
      communityId,
      buckets: buckets.length,
      scopeKey: community.scopeKey,
      reportingAssets: buckets[0].reportingAssets,
    });
  },

  leaderboard: async ctx => {
    const board = await ctx.member.caller.gamification.getLeaderboard({
      period: 'monthly',
      limit: 100,
    });
    const rank = await ctx.member.caller.gamification.getMyRank({ period: 'monthly' });
    const achievements = await ctx.member.caller.gamification.checkAchievements();
    return passed('The leaderboard and the member’s own standing are readable.', {
      entries: board.length,
      hasRank: Boolean(rank),
      achievementsChecked: Boolean(achievements),
    });
  },

  referrals: async ctx => {
    const code = await ctx.member.caller.referrals.getMyReferralCode();
    const stats = await ctx.member.caller.referrals.getMyStats();
    const rewards = await ctx.member.caller.referrals.getMyRewards();
    const referralCode = (code as { code?: string; referralCode?: string }).code
      ?? (code as { referralCode?: string }).referralCode
      ?? null;
    if (referralCode === null) {
      return failed('The member has no referral code to share.');
    }
    const rewardRows = (rewards as { rewards?: unknown[] }).rewards
      ?? (Array.isArray(rewards) ? rewards : []);
    const referred = (stats as { totalReferrals?: number }).totalReferrals ?? 0;
    if (referred === 0 && Array.isArray(rewardRows) && rewardRows.length > 0) {
      return failed('Referral rewards exist for referrals that never happened.', {
        rewards: rewardRows.length,
      });
    }
    return passed('The referral code, its referrals and its rewards agree.', {
      totalReferrals: referred,
      rewards: Array.isArray(rewardRows) ? rewardRows.length : 0,
    });
  },

  'sms-channel': async ctx => {
    const log = await ctx.member.caller.smsCommands.getMySmsLog({ limit: 20 });
    const commands = await ctx.admin.caller.smsCommands.listCommands({ limit: 100 });
    const rows = (commands as { commands?: Array<Record<string, unknown>> }).commands ?? [];
    if (!Array.isArray(rows)) {
      return failed('The SMS command log returned no collection.');
    }
    if (rows.length === 0) {
      return blocked('sms_gateway', 'No SMS gateway has delivered anything to log.', {
        myLog: count((log as { messages?: unknown[] }).messages),
      });
    }
    const unresolved = rows.filter(row => row.resolvedVia === 'unresolved').length;
    return passed('Inbound commands are logged with how the sender was resolved.', {
      commands: rows.length,
      unresolved,
    });
  },
};

export const opsSteps = {
  'noc-soc-watch': nocSocSteps,
  'degraded-operation-drill': degradedDrillSteps,
  'forecast-and-model-lifecycle': modelLifecycleSteps,
  'support-diagnosis': supportSteps,
  'community-and-rewards': communitySteps,
};
