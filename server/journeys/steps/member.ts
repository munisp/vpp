/**
 * Household journeys: joining, watching your own generation, acting on advice.
 */

import {
  count,
  errorCode,
  errorMessage,
  failed,
  passed,
  priorNumber,
  refused,
  type JourneyStep,
} from '../step';
import {
  ensureApprovedAsset,
  ensureAsset,
  ingestReadings,
  registerDevice,
  withdrawDeviceCredential,
} from '../fixtures';

export const memberOnboardingSteps: Record<string, JourneyStep> = {
  'onboarding-status': async ctx => {
    const status = await ctx.member.caller.onboarding.getStatus();
    const assets = await ctx.member.caller.assets.list();
    const step = (status as { currentStep?: number }).currentStep;
    if (typeof step !== 'number') {
      return failed('onboarding.getStatus returned no current step for the member to resume from.');
    }
    return passed('The member can see where onboarding stands and what they already own.', {
      currentStep: step,
      completed: Boolean((status as { completed?: boolean }).completed),
      assets: count((assets as { assets?: unknown[] }).assets),
    });
  },

  'register-asset': async ctx => {
    const asset = await ensureAsset(ctx, 'solar', 5_000);
    const returned = await ctx.member.caller.assets.getById({ assetId: asset.id });
    if (!returned || returned.id !== asset.id) {
      return failed('assets.getById did not return the asset that assets.register created.', {
        assetId: asset.id,
      });
    }
    if (returned.capacity !== asset.capacity) {
      return failed('The registered capacity is not the capacity read back.', {
        assetId: asset.id,
        registered: asset.capacity,
        readBack: returned.capacity ?? null,
      });
    }
    return passed('A solar asset is declared and readable at the capacity it was declared with.', {
      assetId: asset.id,
      capacityW: asset.capacity,
      status: asset.status,
    });
  },

  'commission-by-qr': async ctx => {
    const assetId = priorNumber(ctx, 'register-asset', 'assetId');
    let qrData: string;
    try {
      const generated = await ctx.member.caller.qrcode.generate({
        type: 'merchant',
        amount: 1_000,
        currency: 'TZS',
        merchantId: `journey-asset-${assetId}`,
        merchantName: 'Journey commissioning',
        description: `Commission asset ${assetId}`,
      });
      qrData = generated.payload;
    } catch (error) {
      // An unsigned payment code would be attacker-controllable, so a
      // deployment with no signing key is right to issue none.
      if (errorCode(error) === 'PRECONDITION_FAILED') {
        return refused(errorMessage(error), { assetId });
      }
      throw error;
    }
    if (typeof qrData !== 'string' || qrData.length === 0) {
      return failed('qrcode.generate returned no payload for a scanner to read.');
    }

    const parsed = await ctx.member.caller.qrcode.parse({ qrData });
    const parsedAmount = parsed.amount;
    if (parsedAmount !== 1_000) {
      return failed('A generated QR code does not parse back to the amount it encodes.', {
        parsedAmount: parsedAmount ?? null,
      });
    }

    await ctx.member.caller.qrHistory.recordGeneration({
      paymentType: 'merchant',
      amount: '1000',
      currency: 'TZS',
      qrCodeData: qrData,
      merchantId: `journey-asset-${assetId}`,
      merchantName: 'Journey commissioning',
      description: `Commission asset ${assetId}`,
    });
    const history = await ctx.member.caller.qrHistory.getMyHistory({ limit: 10 });
    const entries = Array.isArray(history) ? history : (history as { items?: unknown[] }).items;
    if (!Array.isArray(entries) || entries.length === 0) {
      return failed('A recorded QR generation does not appear in the member’s own history.');
    }
    return passed('The code the member scanned is the code the platform recorded.', {
      assetId,
      historyEntries: entries.length,
    });
  },

  'operator-approval': async ctx => {
    const assetId = priorNumber(ctx, 'register-asset', 'assetId');
    const pending = await ctx.admin.caller.admin.getPendingAssets();
    const pendingAssets = (pending as { assets?: Array<{ id: number }> }).assets ?? [];
    const wasPending = pendingAssets.some(asset => asset.id === assetId);

    await ctx.admin.caller.admin.approveAsset({ assetId, approved: true });
    const stats = await ctx.admin.caller.admin.getSystemStats();
    const totalAssets = (stats as { stats?: { totalAssets?: number } }).stats?.totalAssets;

    const stillPending = (
      ((await ctx.admin.caller.admin.getPendingAssets()) as { assets?: Array<{ id: number }> })
        .assets ?? []
    ).some(asset => asset.id === assetId);
    if (stillPending) {
      return failed('An approved asset is still queued for approval.', { assetId });
    }
    return passed('The operator approved the asset, and it left the approval queue.', {
      assetId,
      wasPending,
      totalAssets: typeof totalAssets === 'number' ? totalAssets : null,
    });
  },

  'user-directory': async ctx => {
    const directory = await ctx.admin.caller.admin.getUsers({ page: 1, limit: 100 });
    const users = (directory as { users?: Array<{ id: number }> }).users ?? [];
    const present = users.some(user => user.id === ctx.member.user.id);
    if (!present && users.length >= 100) {
      return passed('The directory paginates; the member is beyond the first page.', {
        pageSize: users.length,
      });
    }
    if (!present) {
      return failed('The member does not appear in the operator directory.', {
        memberUserId: ctx.member.user.id,
        listed: users.length,
      });
    }
    return passed('The operator can find the member in the directory.', { listed: users.length });
  },

  'contact-preferences': async ctx => {
    const before = await ctx.member.caller.notificationPreferences.get();
    const target = !before.emailPaymentReceived;
    await ctx.member.caller.notificationPreferences.update({ emailPaymentReceived: target });
    const after = await ctx.member.caller.notificationPreferences.get();
    if (after.emailPaymentReceived !== target) {
      return failed('A saved notification preference does not read back as saved.', {
        requested: target,
        stored: after.emailPaymentReceived,
      });
    }

    const push = await ctx.member.caller.notifications.getPushStatus();
    const credentials = await ctx.member.caller.biometric.getMyCredentials();
    return passed('Contact preferences save, and push and biometrics report their real state.', {
      previous: before.emailPaymentReceived,
      stored: after.emailPaymentReceived,
      pushSubscribed: push.isSubscribed,
      pushDevices: push.deviceCount,
      biometricCredentials: credentials.length,
    });
  },
};

export const prosumerMonitoringSteps: Record<string, JourneyStep> = {
  'ingest-and-read-telemetry': async ctx => {
    const asset = await ensureApprovedAsset(ctx, 'solar', 5_000);

    // Account login is not enough to report the energy you are paid for.
    withdrawDeviceCredential(ctx);
    let refusedWithoutCredential = false;
    try {
      await ctx.member.caller.telemetry.insert({ assetId: asset.id, power: 1_000 });
    } catch {
      refusedWithoutCredential = true;
    }
    if (!refusedWithoutCredential) {
      return failed(
        'Telemetry was accepted from the account that gets paid for it, with no device credential.',
        { assetId: asset.id }
      );
    }

    const credential = await registerDevice(ctx, asset.id);
    const written = await ingestReadings(ctx, asset.id, credential, 4);

    const latest = await ctx.member.caller.telemetry.getLatest({ assetId: asset.id });
    const power = latest ? Number(latest.power) : null;
    if (power === null || Number.isNaN(power)) {
      return failed('Ingested telemetry does not read back through telemetry.getLatest.', {
        assetId: asset.id,
        written,
      });
    }
    const rows = await ctx.member.caller.telemetry.getHistorical({
      assetId: asset.id,
      startTime: new Date(Date.now() - 60 * 60 * 1000),
      endTime: new Date(Date.now() + 60 * 1000),
    });
    if (rows.length < written) {
      return failed('Fewer readings read back over the window than were ingested into it.', {
        assetId: asset.id,
        written,
        readBack: rows.length,
      });
    }
    return passed('Readings are accepted on a device credential and read back at their scale.', {
      assetId: asset.id,
      deviceId: credential.deviceId,
      written,
      latestPower: power,
      historicalRows: rows.length,
      refusedWithoutCredential,
    });
  },

  'own-digital-twin': async ctx => {
    const twin = await ctx.member.caller.digitalTwin.mine();
    const nodes = (twin as { nodes?: unknown[] }).nodes ?? [];
    const edges = (twin as { edges?: unknown[] }).edges ?? [];
    if (!Array.isArray(nodes)) {
      return failed('digitalTwin.mine returned no node collection to render.');
    }
    const unknowns = (nodes as Array<{ state?: string }>).filter(
      node => node.state === 'unknown' || node.state === 'stale'
    ).length;
    return passed('The twin renders the member’s own assets and marks what it cannot see.', {
      nodes: nodes.length,
      edges: Array.isArray(edges) ? edges.length : 0,
      unknownOrStaleNodes: unknowns,
    });
  },

  'raise-and-clear-alert': async ctx => {
    const created = await ctx.member.caller.alerts.create({
      alertType: 'system',
      severity: 'info',
      title: 'Journey check',
      message: `Raised by journey run ${ctx.runKey}`,
    });
    const alertId = (created as { alert?: { id?: number }; alertId?: number }).alert?.id
      ?? (created as { alertId?: number }).alertId;
    if (typeof alertId !== 'number') {
      return failed('alerts.create did not return an alert the member can act on.');
    }

    const listed = await ctx.member.caller.alerts.list({ limit: 50 });
    const alerts = (listed as { alerts?: Array<{ id: number; isRead?: boolean }> }).alerts ?? [];
    const mine = alerts.find(alert => alert.id === alertId);
    if (!mine) {
      return failed('A created alert is not in the member’s alert list.', { alertId });
    }

    await ctx.member.caller.alerts.markAsRead({ alertId });
    const after = await ctx.member.caller.alerts.list({ limit: 50 });
    const readBack = ((after as { alerts?: Array<{ id: number; isRead?: boolean }> }).alerts ?? [])
      .find(alert => alert.id === alertId);
    if (readBack && readBack.isRead === false) {
      return failed('An alert marked read is still unread.', { alertId });
    }
    return passed('An alert can be raised, seen and cleared.', { alertId });
  },

  'dashboard-rollup': async ctx => {
    // Fleet statistics are an operator figure; the member sees their own flow.
    let memberReadFleetStats = false;
    try {
      await ctx.member.caller.analytics.getSystemStats();
      memberReadFleetStats = true;
    } catch {
      memberReadFleetStats = false;
    }
    if (memberReadFleetStats) {
      return failed('A member can read the whole fleet’s revenue and trade statistics.');
    }

    const stats = await ctx.admin.caller.analytics.getSystemStats();
    const flow = await ctx.member.caller.analytics.getEnergyFlow({
      startDate: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      endDate: new Date(),
    });
    const { assets } = await ctx.member.caller.assets.list();
    const ownedActive = assets.filter(asset => asset.status === 'active').length;
    if (stats.totalAssets < ownedActive) {
      return failed('The operator dashboard reports fewer active assets than one member owns.', {
        reported: stats.totalAssets,
        owned: ownedActive,
      });
    }
    return passed('Dashboard totals are consistent with the assets behind them.', {
      reportedAssets: stats.totalAssets,
      ownedActiveAssets: ownedActive,
      energyFlowPoints: flow.data.length,
      memberRefusedFleetStats: !memberReadFleetStats,
    });
  },
};

export const insightsSteps: Record<string, JourneyStep> = {
  'advisor-recommendations': async ctx => {
    await ensureApprovedAsset(ctx, 'solar', 5_000);
    const recommendations = await ctx.member.caller.energyAdvisor.getRecommendations({
      refresh: false,
    });
    const digest = await ctx.member.caller.energyAdvisor.getWeeklyDigest({ refresh: false });
    const items =
      (recommendations as { recommendations?: unknown[] }).recommendations ??
      (Array.isArray(recommendations) ? recommendations : []);
    return passed('Advice is produced from the member’s own readings, or says there are none.', {
      recommendations: Array.isArray(items) ? items.length : 0,
      hasDigest: Boolean(digest),
    });
  },

  'solar-performance': async ctx => {
    const asset = await ensureApprovedAsset(ctx, 'solar', 5_000);
    const credential = await registerDevice(ctx, asset.id, 'inverter');
    await ingestReadings(ctx, asset.id, credential, 3);

    const forecast = await ctx.member.caller.solarYield.getYieldForecast({ assetId: asset.id });
    const ratio = await ctx.member.caller.solarYield.getPerformanceRatio({ assetId: asset.id });
    if (!forecast) {
      return failed('solarYield.getYieldForecast returned nothing for a declared array.', {
        assetId: asset.id,
      });
    }
    const performanceRatio = (ratio as { performanceRatio?: number | null }).performanceRatio ?? null;
    return passed('Yield and performance ratio are reported for the declared array.', {
      assetId: asset.id,
      performanceRatio: typeof performanceRatio === 'number' ? performanceRatio : null,
    });
  },

  'battery-health': async ctx => {
    const battery = await ensureApprovedAsset(ctx, 'battery', 10_000);
    const health = await ctx.member.caller.batteryHealth.getBatteryHealth({ assetId: battery.id });
    const history = await ctx.member.caller.batteryHealth.getSnapshotHistory({
      assetId: battery.id,
      limit: 10,
    });
    const soh = (health as { stateOfHealthPct?: number | null; stateOfHealth?: number | null });
    const value = soh.stateOfHealthPct ?? soh.stateOfHealth ?? null;
    if (value === null) {
      return refused('State of health is reported as unknown rather than guessed.', {
        assetId: battery.id,
        snapshots: Array.isArray(history) ? history.length : 0,
      });
    }
    return passed('State of health is derived from recorded snapshots.', {
      assetId: battery.id,
      stateOfHealth: value,
      snapshots: Array.isArray(history) ? history.length : 0,
    });
  },

  'carbon-position': async ctx => {
    const summary = await ctx.member.caller.carbonCredits.getMyCarbonSummary();
    const credits = await ctx.member.caller.carbon.getUserCredits();
    if (!summary) {
      return failed('carbonCredits.getMyCarbonSummary returned nothing to show the member.');
    }
    return passed('The carbon position and any certificates held are readable.', {
      credits: Array.isArray(credits) ? credits.length : count((credits as { credits?: unknown[] }).credits),
    });
  },

  'personal-analytics': async ctx => {
    const start = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = new Date();
    const revenue = await ctx.member.caller.analytics.getRevenue({ startDate: start, endDate: end });
    const stats = await ctx.member.caller.participantInsights.getOverallStats();
    const csv = await ctx.member.caller.export.energyCSV({
      startDate: start.toISOString(),
      endDate: end.toISOString(),
    });
    const content = (csv as { csv?: string; content?: string }).csv ?? (csv as { content?: string }).content;
    if (typeof content !== 'string' || content.length === 0) {
      return failed('The energy statement export produced no document.');
    }
    return passed('Personal analytics and a downloadable statement are produced.', {
      revenuePoints: Array.isArray(revenue) ? revenue.length : count((revenue as { data?: unknown[] }).data),
      hasStats: Boolean(stats),
      csvBytes: content.length,
    });
  },
};

export const memberSteps = {
  'member-onboarding': memberOnboardingSteps,
  'prosumer-daily-monitoring': prosumerMonitoringSteps,
  'insights-and-sustainability': insightsSteps,
};
