/**
 * Grid journeys: demand response, bounded dispatch, price signals, locational
 * flexibility, V2G and smart-home loads.
 *
 * The rule these steps enforce is that a broker accepting a publish is not the
 * device having obeyed, and a control with no validity window is not a control.
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
import {
  ensureApprovedAsset,
  ingestFlexibilityWindow,
  ingestHistory,
  ingestReadings,
  registerDevice,
} from '../fixtures';
import { MIN_SITE_HISTORY_SAMPLES } from '../../services/price-signal';

function minutesFromNow(minutes: number): Date {
  return new Date(Date.now() + minutes * 60 * 1000);
}

/**
 * A flexibility delivery window a run can drive end to end: offers close when
 * the window opens, so it starts far enough ahead for the offer and clearing
 * steps, and it is short enough that the run can wait for it to elapse before
 * delivery is measured.
 *
 * The whole wait happens inside one step, so lead + length has to leave room
 * under STEP_ACTIVITY_TIMEOUT_MS. A step that outlives its activity timeout is
 * retried while the timed-out attempt keeps running, and the late attempt then
 * overwrites the retry's result — which is how a run once recorded `failed`
 * with five passed steps. `flexibility-window.test.ts` holds this to that.
 */
export const DELIVERY_WINDOW_LEAD_MS = 30_000;
export const DELIVERY_WINDOW_LENGTH_MS = 60_000;

async function waitUntil(epochMs: number): Promise<void> {
  const remaining = epochMs - Date.now();
  if (remaining <= 0) return;
  await new Promise(resolve => setTimeout(resolve, remaining));
}

/**
 * Whether a service refused because the thing was already done.
 *
 * Journey steps are retried, so a step that clears a requirement or settles an
 * award has to be able to run twice: the second attempt must carry on from the
 * state the first left rather than record the refusal as a defect.
 */
function alreadyDone(error: unknown): boolean {
  return error instanceof Error && /already/i.test(error.message);
}

export const demandResponseSteps: Record<string, JourneyStep> = {
  enrol: async ctx => {
    await ensureApprovedAsset(ctx, 'battery', 10_000);
    // Journeys re-run, so an existing enrolment is updated rather than enrolled
    // twice: two enrolments would be two sets of limits for one member.
    const existing = await ctx.member.caller.demandResponse.getEnrollment();
    if (existing) {
      await ctx.member.caller.demandResponse.updateEnrollment({
        autoOptIn: true,
        minCompensation: 10,
        maxReduction: 5_000,
        status: 'active',
      });
    } else {
      await ctx.member.caller.demandResponse.enroll({
        autoOptIn: true,
        minCompensation: 10,
        maxReduction: 5_000,
      });
    }
    const enrolment = await ctx.member.caller.demandResponse.getEnrollment();
    if (!enrolment) {
      return failed('An enrolment was accepted but the member is not enrolled.');
    }
    if (enrolment.status !== 'active' || enrolment.maxReduction !== 5_000) {
      return failed('An enrolment does not read back with the limits it was given.', {
        status: enrolment.status,
        maxReduction: enrolment.maxReduction ?? null,
      });
    }
    return passed('The member is enrolled in demand response and can see their limits.', {
      status: enrolment.status,
      maxReduction: enrolment.maxReduction ?? null,
      autoOptIn: enrolment.autoOptIn === true,
      alreadyEnrolled: existing !== null,
    });
  },

  'operator-calls-event': async ctx => {
    const gridStatus = await ctx.admin.caller.drForecasting.getGridStatus({ hours: 24 });
    const conditions = await ctx.admin.caller.drAutomation.checkGridConditions({
      loadLevel: 92,
      frequency: 49.6,
      voltage: 230,
      temperature: 34,
    });
    const startTime = minutesFromNow(30);
    const created = await ctx.admin.caller.demandResponse.createEvent({
      eventName: `Journey DR ${ctx.runKey}`,
      eventType: 'peak_shaving',
      targetReduction: 5_000,
      startTime,
      endTime: new Date(startTime.getTime() + 60 * 60 * 1000),
      compensationRate: 25,
    });
    const eventId = created.eventId;
    if (typeof eventId !== 'number') {
      return failed('demandResponse.createEvent returned no event id.');
    }
    return passed('An event is called against the grid conditions the operator can see.', {
      eventId,
      gridStatusPoints: count((gridStatus as { statuses?: unknown[] }).statuses),
      conditionsEvaluated: Boolean(conditions),
    });
  },

  'member-responds': async ctx => {
    const eventId = priorNumber(ctx, 'operator-calls-event', 'eventId');
    const events = await ctx.member.caller.demandResponse.getUpcomingEvents();
    if (!events.some(event => event.id === eventId)) {
      return failed('A called event does not appear among the member’s upcoming events.', {
        eventId,
        upcoming: events.length,
      });
    }
    await ctx.member.caller.demandResponse.respondToEvent({
      eventId,
      participate: true,
      targetReduction: 3_000,
    });
    const rows = await ctx.member.caller.demandResponse.getMyResponses();
    if (!rows.some(response => response.eventId === eventId)) {
      return failed('The member accepted an event but has no response recorded.', { eventId });
    }
    return passed('The member accepted the event and their response is recorded.', {
      eventId,
      responses: rows.length,
    });
  },

  'targeting-and-forecast': async ctx => {
    const eventId = priorNumber(ctx, 'operator-calls-event', 'eventId');
    const recommended = await ctx.admin.caller.drForecast.recommendParticipants({
      targetReductionKw: 50,
      eventId,
      maxParticipants: 50,
    });
    const forecasts = await ctx.admin.caller.drForecast.listForecasts({ limit: 14 });
    const distribution = await ctx.admin.caller.drSegmentation.getSegmentDistribution();
    const participants = recommended.recommendations;
    if (participants.length === 0) {
      return refused('No participant met the targeting criteria, rather than a padded list.', {
        eventId,
        forecasts: forecasts.count,
      });
    }
    // Coverage below the target must be reported as short, not as a met target
    // padded with participants who cannot deliver.
    if (recommended.targetMet && recommended.coverageKw < recommended.targetReductionKw) {
      return failed('Targeting reports the target met on coverage below it.', {
        eventId,
        coverageKw: recommended.coverageKw,
        targetReductionKw: recommended.targetReductionKw,
      });
    }
    return passed('Targeting names the participants it recommends and the coverage they give.', {
      eventId,
      recommended: participants.length,
      coverageKw: recommended.coverageKw,
      targetMet: recommended.targetMet,
      hasSegmentDistribution: Boolean(distribution),
    });
  },

  compensation: async ctx => {
    const rows = await ctx.member.caller.demandResponse.getMyCompensation();
    const analytics = await ctx.member.caller.demandResponse.getMyAnalytics();
    const total = analytics?.totalCompensation ?? null;
    const measured = analytics?.totalEvents ?? null;
    const paidRows = rows.filter(row => row.status === 'paid');
    const paidTotal = paidRows.reduce((sum, row) => sum + row.amount, 0);
    if (total !== null && paidTotal !== total) {
      return failed('Compensation analytics report a different total than the paid rows.', {
        analyticsTotal: total,
        paidRows: paidRows.length,
        paidTotal,
      });
    }
    if (total === null) {
      return failed('Compensation reports no figure at all, not even zero.');
    }
    // An event that has not happened yet must not be paid. Compensation before
    // any measured event is the defect this step looks for.
    if (total > 0 && measured === 0) {
      return failed('Compensation is owed for events that were never measured.', {
        totalCompensation: total,
        measuredEvents: 0,
      });
    }
    return passed('Compensation follows measured events rather than intentions.', {
      totalCompensation: total,
      measuredEvents: measured ?? 0,
    });
  },
};

export const gridDispatchSteps: Record<string, JourneyStep> = {
  'control-policy': async ctx => {
    const policy = await ctx.admin.caller.controlWindows.policy();
    const health = await ctx.admin.caller.controlWindows.health();
    const cap = (policy as { maxValiditySeconds?: number }).maxValiditySeconds ?? null;
    if (cap === null) {
      return failed('The deployment declares no maximum validity for a control.');
    }
    return passed('Every control is capped by a declared validity window.', {
      maxValiditySeconds: cap,
      sweeperConfigured: Boolean((health as { sweeperEnabled?: boolean }).sweeperEnabled),
    });
  },

  'fleet-controls': async ctx => {
    const fleet = await ctx.admin.caller.controlWindows.fleet({ limit: 50 });
    const mine = await ctx.member.caller.controlWindows.mine({ limit: 25 });
    // Every control carries a validTo by construction; a row without one would
    // be a setpoint nothing ever revokes.
    const unbounded = fleet.assignments.filter(row => !row.assignment.validTo).length;
    if (unbounded > 0) {
      return failed('A control is in force with no expiry.', {
        windows: fleet.count,
        unbounded,
      });
    }
    const awaitingFallback = fleet.assignments.filter(
      row => row.state === 'expired_awaiting_fallback'
    ).length;
    return passed('Fleet controls all carry an expiry, and a member sees only their own.', {
      fleetWindows: fleet.count,
      myWindows: mine.count,
      awaitingFallback,
    });
  },

  'device-command': async ctx => {
    const asset = await ensureApprovedAsset(ctx, 'battery', 10_000);
    const credential = await registerDevice(ctx, asset.id, 'battery_controller');
    const devices = await ctx.admin.caller.devices.list();
    const rows = (devices as { devices?: Array<{ id: number; deviceId?: string }> }).devices ?? [];
    const device = rows.find(row => row.deviceId === credential.deviceId);
    if (!device) {
      return failed('A registered device does not appear in the device list.', {
        deviceId: credential.deviceId,
      });
    }
    try {
      const sent = await ctx.admin.caller.devices.sendCommand({
        deviceId: device.id,
        command: 'set_power',
        payload: { limitWatts: 2_000, validitySeconds: 300, fallback: 'resume_local' },
      });
      const status = (sent as { status?: string }).status ?? 'unknown';
      if (status === 'accepted' || status === 'confirmed') {
        return failed(
          'An MQTT publish is recorded as the device having obeyed, which the broker cannot prove.',
          { deviceId: device.id, status }
        );
      }
      const commands = await ctx.admin.caller.devices.getCommands({
        deviceId: device.id,
        limit: 20,
      });
      return passed('The command is queued at the broker and recorded as receipt-unknown.', {
        deviceId: device.id,
        status,
        commands: count((commands as { commands?: unknown[] }).commands),
      });
    } catch (error) {
      return classifyDependencyError(error, 'mqtt_broker', { deviceId: device.id });
    }
  },

  'expiry-sweep': async ctx => {
    const swept = await ctx.admin.caller.controlWindows.sweepNow();
    if (swept.examined !== swept.applied + swept.held + swept.unconfirmed + swept.failed + swept.skipped) {
      return failed('The expiry sweep examined more controls than it accounts for.', {
        examined: swept.examined,
        applied: swept.applied,
        held: swept.held,
        unconfirmed: swept.unconfirmed,
        failed: swept.failed,
        skipped: swept.skipped,
      });
    }
    return passed('Expired controls are swept into their declared fallback, or reported unsent.', {
      examined: swept.examined,
      applied: swept.applied,
      unconfirmed: swept.unconfirmed,
      failedFallbacks: swept.failed,
      held: swept.held,
    });
  },

  'device-health': async ctx => {
    const health = await ctx.admin.caller.iotDevices.getAllDevicesHealth();
    const broker = await ctx.admin.caller.iotDevices.getBrokerStatus();
    const connected = (broker as { connected?: boolean }).connected;
    const devices = (health as { devices?: unknown[] }).devices
      ?? (Array.isArray(health) ? health : []);
    if (connected === false) {
      return blocked('mqtt_broker', 'The broker is reported disconnected rather than assumed up.', {
        devices: Array.isArray(devices) ? devices.length : 0,
      });
    }
    return passed('Broker and device health are reported from the connection itself.', {
      devices: Array.isArray(devices) ? devices.length : 0,
    });
  },

  'utility-signals': async ctx => {
    const status = await ctx.admin.caller.gridOperator.adminGetStatus();
    const pricing = await ctx.admin.caller.gridOperator.adminGetPricing();
    if (!status || !pricing) {
      return failed('The utility-facing status or pricing feed returned nothing.');
    }
    const live = (status as { source?: string }).source ?? 'unknown';
    if (live === 'unavailable' || live === 'none') {
      return refused('No utility feed is configured, and the platform says so.', { source: live });
    }
    return passed('The utility status and pricing feed are readable with their source.', {
      source: live,
    });
  },
};

export const priceSignalSteps: Record<string, JourneyStep> = {
  coordinate: async ctx => {
    const asset = await ensureApprovedAsset(ctx, 'battery', 10_000);
    const credential = await registerDevice(ctx, asset.id, 'battery_controller');
    // A site with fewer than MIN_SITE_HISTORY_SAMPLES measured samples is
    // excluded from the fleet by design — its load is unknown — so the journey
    // gives this one a real history through the device path rather than
    // expecting the platform to plan without one.
    await ingestHistory(credential, 24, Math.ceil((MIN_SITE_HISTORY_SAMPLES + 12) / 24));
    try {
      // A site's response to a price is a mixed-integer plan, so it moves in
      // steps rather than smoothly: a profile the fleet cannot reach comes back
      // `not_converged`, and the journey checks that first so a coordination that
      // missed its target can never be mistaken for one that met it.
      const unreachable = await ctx.admin.caller.priceSignal.coordinate({
        userIds: [ctx.member.user.id],
        intervalMinutes: 15,
        startsAt: minutesFromNow(15),
        targetNetW: [-2_000, -1_500, -1_000, -500],
        sharedImportLimitW: [4_000, 4_000, 4_000, 4_000],
        siteImportLimitW: 6_000,
        siteExportLimitW: 4_000,
        scopeType: 'fleet',
      });
      if (unreachable.converged !== (unreachable.signal.status === 'draft')) {
        return failed('A coordination reports a convergence its stored status contradicts.', {
          signalId: unreachable.signalId,
          converged: unreachable.converged,
          status: unreachable.signal.status,
        });
      }
      // What the fleet does unprompted is the only profile it is certain to be
      // able to follow, so it is what the grid asks for here; anything further
      // is what the flexibility markets are for.
      const baseline = await ctx.admin.caller.priceSignal.baseline({
        userIds: [ctx.member.user.id],
        intervalMinutes: 15,
        horizon: 4,
        siteImportLimitW: 6_000,
        siteExportLimitW: 4_000,
        scopeType: 'fleet',
      });
      const signal = await ctx.admin.caller.priceSignal.coordinate({
        userIds: [ctx.member.user.id],
        intervalMinutes: 15,
        startsAt: minutesFromNow(15),
        targetNetW: baseline.netW,
        sharedImportLimitW: baseline.netW.map(() => 6_000),
        siteImportLimitW: 6_000,
        siteExportLimitW: 4_000,
        scopeType: 'fleet',
      });
      if (signal.signal.sites.length === 0) {
        return refused('No site had the measured history a fleet plan needs.', {
          signalId: signal.signalId,
          excludedSites: signal.excludedSites.length,
        });
      }
      // A signal that missed its own target must say so rather than read as a
      // plan the fleet can be billed against.
      if (signal.converged && signal.signal.status === 'not_converged') {
        return failed('A signal reports convergence and a not-converged status at once.', {
          signalId: signal.signalId,
        });
      }
      return passed('A price signal is coordinated and carries its convergence state.', {
        signalId: signal.signalId,
        status: signal.signal.status,
        converged: signal.converged,
        sites: signal.signal.sites.length,
        excludedSites: signal.excludedSites.length,
        unreachableSignalId: unreachable.signalId,
        unreachableStatus: unreachable.signal.status,
        unreachableDeviationW: unreachable.signal.maxDeviationW,
      });
    } catch (error) {
      return classifyDependencyError(error, 'optimizer', { stage: 'coordinate' });
    }
  },

  publish: async ctx => {
    const signalId = priorString(ctx, 'coordinate', 'signalId');
    const status = priorString(ctx, 'coordinate', 'status');
    if (status !== 'draft') {
      // Only a converged draft may reach the fleet.
      try {
        await ctx.admin.caller.priceSignal.publish({ signalId });
        return failed('A signal that is not a converged draft was published to the fleet.', {
          signalId,
          status,
        });
      } catch {
        return refused('A signal that did not converge cannot be published.', {
          signalId,
          status,
        });
      }
    }
    try {
      const published = await ctx.admin.caller.priceSignal.publish({ signalId });
      const applied = published.signal.sites.filter(
        site => site.response === 'followed' || site.response === 'deviated'
      ).length;
      if (applied > 0) {
        return failed('A broker publish is recorded as the site having answered the signal.', {
          signalId,
          applied,
        });
      }
      if (published.queued === 0 && published.failed > 0) {
        // The signal reached nobody. The platform is right to leave it a draft,
        // but nothing about publication is proven without a broker.
        return blocked('mqtt_broker', 'No site could be sent the price: every publish failed.', {
          signalId,
          failed: published.failed,
          status: published.signal.status,
        });
      }
      return passed('The signal is sent, with delivery recorded as receipt-unknown.', {
        signalId,
        queued: published.queued,
        failed: published.failed,
        status: published.signal.status,
      });
    } catch (error) {
      return classifyDependencyError(error, 'mqtt_broker', { signalId });
    }
  },

  'member-view': async ctx => {
    const signalId = priorString(ctx, 'coordinate', 'signalId');
    const mine = await ctx.member.caller.priceSignal.mySignals({ limit: 20 });
    const rows = mine.signals;
    const seen = rows.some(row => row.signalId === signalId);
    if (!seen) {
      return refused('The signal was not published to this site, so the site does not see it.', {
        signalId,
        signals: rows.length,
      });
    }
    const mineRow = rows.find(row => row.signalId === signalId);
    const priced = mineRow?.intervals.every(
      interval => typeof interval.signalAdjustmentCentsPerKwh === 'number'
    );
    if (!priced) {
      return failed('A site was sent a signal with no price on one of its intervals.', {
        signalId,
        intervals: mineRow?.intervals.length ?? 0,
      });
    }
    return passed('A site sees the price it was actually sent, interval by interval.', {
      signalId,
      signals: rows.length,
      intervals: mineRow?.intervals.length ?? 0,
    });
  },

  score: async ctx => {
    const signalId = priorString(ctx, 'coordinate', 'signalId');
    // Scoring compares a site's meter against a price it was sent, so it depends
    // on publication having happened: reading the publish step's own fact means a
    // run with no broker reports scoring as blocked on the broker, not refused.
    priorNumber(ctx, 'publish', 'queued');
    const asset = await ensureApprovedAsset(ctx, 'battery', 10_000);
    const credential = await registerDevice(ctx, asset.id, 'battery_controller');
    await ingestReadings(ctx, asset.id, credential, 4);
    try {
      const scored = await ctx.admin.caller.priceSignal.score({ signalId });
      const listed = await ctx.admin.caller.priceSignal.list({ limit: 10 });
      const unmeasured = scored.sites.filter(
        site => site.response === 'unmeasured' || site.response === 'no_telemetry'
      ).length;
      // A verdict of followed or deviated has to rest on measured energy.
      const unevidenced = scored.sites.filter(
        site =>
          (site.response === 'followed' || site.response === 'deviated') &&
          (site.actualNetWh === null || site.telemetrySamples === 0)
      ).length;
      if (unevidenced > 0) {
        return failed('A site is scored as having followed or deviated with no measured energy.', {
          signalId,
          unevidenced,
        });
      }
      return passed('Scoring measures each site across all its meters, or says it could not.', {
        signalId,
        sitesScored: scored.sites.length,
        unmeasured,
        signals: listed.signals.length,
      });
    } catch (error) {
      return classifyDependencyError(error, 'optimizer', { signalId, stage: 'score' });
    }
  },
};

export const flexibilitySteps: Record<string, JourneyStep> = {
  topology: async ctx => {
    const asset = await ensureApprovedAsset(ctx, 'battery', 10_000);
    const code = `JRNY-FEEDER-${ctx.member.user.id}`;
    const existing = await ctx.admin.caller.locationalFlexibility.nodes({});
    let nodeId = existing.find(node => node.code === code)?.nodeId ?? null;
    if (nodeId === null) {
      const created = await ctx.admin.caller.locationalFlexibility.createNode({
        code,
        name: `Journey feeder ${ctx.member.user.id}`,
        kind: 'feeder',
        region: 'TZ-DAR',
        firmCapacityW: 250_000,
      });
      nodeId = created.nodeId;
    }
    await ctx.admin.caller.locationalFlexibility.linkAsset({
      nodeId,
      assetId: asset.id,
      linkSource: 'operator_declared',
      evidence: `Journey run ${ctx.runKey}: operator-declared connection, not utility-verified.`,
    });
    const headroom = await ctx.admin.caller.locationalFlexibility.nodes({});
    const node = headroom.find(row => row.nodeId === nodeId);
    if (!node) {
      return failed('A node that was just created does not appear in the topology.', { nodeId });
    }
    if (node.awardableAssets > node.linkedAssets) {
      return failed('A node reports more awardable assets than are linked to it.', {
        nodeId,
        linkedAssets: node.linkedAssets,
        awardableAssets: node.awardableAssets,
      });
    }
    return passed('The node exists and the asset link carries how it was established.', {
      nodeId,
      assetId: asset.id,
      linkSource: 'operator_declared',
      linkedAssets: node.linkedAssets,
      awardableAssets: node.awardableAssets,
      unverifiedAssets: node.unverifiedAssets,
    });
  },

  requirement: async ctx => {
    const nodeId = priorNumber(ctx, 'topology', 'nodeId');
    // A window the run can see through end to end: it opens far enough ahead
    // that offers are still accepted, and closes soon enough that the run can
    // report telemetry inside it and then measure an elapsed window.
    const startsAt = new Date(Date.now() + DELIVERY_WINDOW_LEAD_MS);
    const endsAt = new Date(startsAt.getTime() + DELIVERY_WINDOW_LENGTH_MS);
    const created = await ctx.admin.caller.locationalFlexibility.createRequirement({
      nodeId,
      direction: 'import_reduction',
      startsAt,
      endsAt,
      requiredPowerW: 8_000,
      priceCapCentsPerKwh: 40,
      currency: 'TZS',
      notes: `Journey run ${ctx.runKey}`,
    });
    const requirementId = created.requirementId;
    const listed = await ctx.admin.caller.locationalFlexibility.requirements({ nodeId, limit: 50 });
    const mine = listed.find(row => row.id === requirementId);
    if (!mine) {
      return failed('A requirement that was just opened is not listed at its node.', {
        nodeId,
        requirementId,
      });
    }
    if (mine.requiredPowerW !== 8_000 || mine.priceCapCentsPerKwh !== 40) {
      return failed('A requirement does not read back with the power and cap it was given.', {
        requirementId,
        requiredPowerW: mine.requiredPowerW,
        priceCapCentsPerKwh: mine.priceCapCentsPerKwh,
      });
    }
    return passed('A located requirement is open, priced and time-bounded.', {
      nodeId,
      requirementId,
      open: listed.length,
      status: mine.status,
      windowStartsAtMs: startsAt.getTime(),
      windowEndsAtMs: endsAt.getTime(),
    });
  },

  'member-offers': async ctx => {
    const requirementId = priorNumber(ctx, 'requirement', 'requirementId');
    const asset = await ensureApprovedAsset(ctx, 'battery', 10_000);
    const opportunities = await ctx.member.caller.locationalFlexibility.myOpportunities();
    const visible = opportunities.some(row => row.requirementId === requirementId);
    if (!visible) {
      // An owner who cannot see the requirement cannot offer into it; that is a
      // topology or eligibility defect, not a refusal.
      return failed('An open requirement at the member’s own node is not offered to them.', {
        requirementId,
        opportunities: opportunities.length,
      });
    }
    const offered = await ctx.member.caller.locationalFlexibility.offer({
      requirementId,
      assetId: asset.id,
      offeredPowerW: 4_000,
      priceCentsPerKwh: 30,
    });
    return passed('The member sees the located opportunity and offers into it.', {
      requirementId,
      offerId: offered.offerId,
      opportunities: opportunities.length,
    });
  },

  'clear-and-measure': async ctx => {
    const requirementId = priorNumber(ctx, 'requirement', 'requirementId');
    const windowStartsAtMs = priorNumber(ctx, 'requirement', 'windowStartsAtMs');
    const windowEndsAtMs = priorNumber(ctx, 'requirement', 'windowEndsAtMs');
    // A retry of this step meets a requirement it cleared itself, so a repeat
    // clearing is the earlier attempt's result rather than a failure; the awards
    // it wrote are read back from the measurement below.
    let cleared: Awaited<
      ReturnType<typeof ctx.admin.caller.locationalFlexibility.clear>
    > | null = null;
    try {
      cleared = await ctx.admin.caller.locationalFlexibility.clear({ requirementId });
    } catch (error) {
      if (!alreadyDone(error)) throw error;
    }
    if (cleared && cleared.awards.length === 0) {
      return refused('The requirement cleared short rather than awarding unverified capacity.', {
        requirementId,
        status: cleared.status,
        ineligible: cleared.ineligible.length,
      });
    }

    // Delivery is graded only on an elapsed window, against the asset's own
    // history in the same clock window, so the run waits for the window to close
    // and reports the samples through the device path before measuring.
    const awardedAsset = await ensureApprovedAsset(ctx, 'battery', 10_000);
    const credential = await registerDevice(ctx, awardedAsset.id, 'battery_controller');
    await waitUntil(windowEndsAtMs + 1_000);
    const samples = await ingestFlexibilityWindow(credential, windowStartsAtMs, windowEndsAtMs);
    const measured = await ctx.admin.caller.locationalFlexibility.measure({ requirementId });
    const results = measured.results;
    if (results.length === 0) {
      if (!cleared) {
        return refused('The requirement cleared short rather than awarding unverified capacity.', {
          requirementId,
          reclearRefused: true,
        });
      }
      return failed('A cleared requirement measured no awards.', { requirementId });
    }
    const first = results[0];
    if (first.deliveryStatus === 'unverified') {
      // Real history is missing rather than the platform mis-grading it: report
      // what the run gave it so the caveat is checkable.
      return refused('Too little telemetry to verify delivery: neither paid nor treated as breach.', {
        requirementId,
        awardId: first.awardId,
        deliveryStatus: first.deliveryStatus,
        unverifiedReason: first.unverifiedReason ?? null,
        baselineSamples: samples.baselineSamples,
        windowSamples: samples.windowSamples,
      });
    }
    if (first.deliveryStatus === 'not_delivered') {
      return refused('The window measured no reduction, so nothing is owed for it.', {
        requirementId,
        awardId: first.awardId,
        baselinePowerW: first.baselinePowerW,
        measuredPowerW: first.measuredPowerW,
      });
    }
    // Same reasoning as the clearing above: an award this step already settled
    // must not be settled twice, and the refusal that prevents that is the
    // evidence the first attempt paid it.
    let settledAmountCents: number | null = null;
    try {
      const settled = await ctx.admin.caller.locationalFlexibility.settle({
        awardId: first.awardId,
      });
      settledAmountCents = settled.amount;
    } catch (error) {
      if (!alreadyDone(error)) throw error;
      settledAmountCents = first.earnedAmount ?? null;
    }
    return passed('Merit-order clearing, measured delivery, then settlement of measured energy.', {
      requirementId,
      awardId: first.awardId,
      clearingPriceCentsPerKwh: cleared?.clearingPriceCentsPerKwh ?? null,
      deliveryStatus: first.deliveryStatus,
      baselineSamples: first.baselineSamples,
      measuredSamples: first.measuredSamples,
      deliveredEnergyWh: first.deliveredEnergyWh,
      settledAmountCents,
    });
  },

  'member-awards': async ctx => {
    const rows = await ctx.member.caller.locationalFlexibility.myAwards({ limit: 25 });
    const paidWithoutVerification = rows.filter(
      row => row.settled && row.deliveryStatus === 'unverified'
    ).length;
    if (paidWithoutVerification > 0) {
      return failed('An award was paid on delivery the platform could not verify.', {
        awards: rows.length,
        paidWithoutVerification,
      });
    }
    return passed('The member’s awards state what was verified before anything was paid.', {
      awards: rows.length,
    });
  },
};

export const v2gSteps: Record<string, JourneyStep> = {
  'register-ev': async ctx => {
    const evs = await ctx.member.caller.evCharging.getUserEVs();
    if (evs.length > 0) {
      return passed('The member already has an EV registered with its capabilities.', {
        evId: evs[0].id,
        evs: evs.length,
      });
    }
    const registered = await ctx.member.caller.evCharging.registerEV({
      make: 'Journey',
      model: 'V2G',
      batteryCapacityKwh: 60,
      usableBatteryKwh: 56,
      maxChargingPowerKw: 11,
      maxDischargingPowerKw: 10,
      v2gCapable: true,
    });
    return passed('The EV is registered with the power limits a plan must respect.', {
      evId: registered.id,
    });
  },

  'plan-schedule': async ctx => {
    const evId = priorNumber(ctx, 'register-ev', 'evId');
    const planned = await ctx.member.caller.v2gOptimizer.planSchedule({
      evId,
      departureTime: minutesFromNow(600),
      targetSocPercent: 80,
      minSocReservePercent: 40,
      allowV2g: true,
      batteryCapacityKwh: 60,
      startSocPercent: 60,
      maxChargeKw: 11,
      maxDischargeKw: 10,
    });
    // No plan is computed without a real price series; that is a refusal, not
    // a schedule of made-up prices.
    if (!planned.scheduleAvailable || planned.scheduleId === undefined) {
      return refused('No real price series exists, so no schedule was invented.', {
        evId,
        reason: planned.reason ?? null,
      });
    }
    const scheduleId = planned.scheduleId;
    const schedule = await ctx.member.caller.v2gOptimizer.getSchedule({ scheduleId });
    const intervals: unknown = schedule.intervals;
    if (!Array.isArray(intervals) || intervals.length === 0) {
      return failed('A V2G schedule has no intervals to dispatch.', { scheduleId });
    }
    // The column stores percent * 100.
    const reservePercent = schedule.minSocReservePercent / 100;
    if (reservePercent < 40) {
      return failed('A V2G plan discharges below the reserve the driver set.', {
        scheduleId,
        minSocReservePercent: reservePercent,
      });
    }
    return passed('The plan keeps the driver’s reserve and names every interval.', {
      evId,
      scheduleId,
      intervals: intervals.length,
      priceSource: planned.priceSource ?? null,
    });
  },

  'list-and-cancel': async ctx => {
    const scheduleId = priorNumber(ctx, 'plan-schedule', 'scheduleId');
    const listed = await ctx.member.caller.v2gOptimizer.listSchedules({ limit: 20 });
    const rows = listed.schedules;
    if (!rows.some(row => row.id === scheduleId)) {
      return failed('A planned schedule is not listed for the member who planned it.', {
        scheduleId,
      });
    }
    await ctx.member.caller.v2gOptimizer.cancelSchedule({ scheduleId });
    const after = await ctx.member.caller.v2gOptimizer.getSchedule({ scheduleId });
    if (after.status === 'active' || after.status === 'draft') {
      return failed('A cancelled schedule is still live.', { scheduleId, status: after.status });
    }
    return passed('Schedules are listed and can be cancelled by their owner.', {
      scheduleId,
      schedules: rows.length,
      status: after.status,
    });
  },

  'station-session': async ctx => {
    const evId = priorNumber(ctx, 'register-ev', 'evId');
    const station = await ctx.member.caller.evCharging.registerStation({
      name: `Journey station ${ctx.member.user.id}`,
      connectorType: 'type2',
      maxPowerKw: 11,
      v2gCapable: true,
      ocppVersion: '1.6',
    });
    const stationId = station.id;
    try {
      const session = await ctx.member.caller.evCharging.startSession({
        evId,
        stationId,
        sessionType: 'v2g',
        targetSocPercent: 80,
        departureTime: minutesFromNow(600),
      });
      const read = await ctx.member.caller.evCharging.getSession({
        sessionId: session.sessionId,
      });
      const state = read?.status ?? 'unknown';
      if (state === 'charging' || state === 'discharging') {
        return failed(
          'A session reports the vehicle charging with no charge point having reported anything.',
          { sessionId: session.sessionId, state }
        );
      }
      return passed('The session waits on the charge point rather than assuming it started.', {
        stationId,
        state,
      });
    } catch (error) {
      return classifyDependencyError(error, 'ocpp_station', { stationId });
    }
  },
};

export const smartHomeSteps: Record<string, JourneyStep> = {
  'matter-inventory': async ctx => {
    try {
      const nodes = await ctx.admin.caller.matterLoads.nodes();
      const rows = (nodes as { nodes?: Array<{ lastReportedAt?: unknown }> }).nodes ?? [];
      const controllerConfigured = (nodes as { controllerConfigured?: boolean })
        .controllerConfigured;
      if (controllerConfigured === false) {
        return blocked('matter_controller', 'No Matter controller is configured to inventory.', {
          nodes: rows.length,
        });
      }
      if (!Array.isArray(rows)) {
        return failed('The Matter inventory returned no nodes collection.');
      }
      const silent = rows.filter(node => !node.lastReportedAt).length;
      return passed('Commissioned nodes are listed with when each last reported.', {
        nodes: rows.length,
        neverReported: silent,
      });
    } catch (error) {
      return classifyDependencyError(error, 'matter_controller', {});
    }
  },

  'load-capabilities': async ctx => {
    const asset = await ensureApprovedAsset(ctx, 'battery', 10_000);
    await ctx.member.caller.derCapabilities.registerCapabilities({
      assetId: asset.id,
      maxPowerExport: 5_000,
      maxPowerImport: 5_000,
      minStateOfCharge: 20,
      maxStateOfCharge: 95,
      roundTripEfficiency: 90,
    });
    const capabilities = await ctx.member.caller.derCapabilities.getCapabilities({
      assetId: asset.id,
    });
    const maxExport = (capabilities as {
      capabilities?: { maxPowerExport?: number };
      maxPowerExport?: number;
    }).capabilities?.maxPowerExport
      ?? (capabilities as { maxPowerExport?: number }).maxPowerExport
      ?? null;
    if (maxExport === null) {
      return failed('A load declares no export limit, so no control could be bounded by it.', {
        assetId: asset.id,
      });
    }
    const withCapabilities = await ctx.member.caller.derCapabilities.getUserAssetsWithCapabilities();
    return passed('Controllable loads declare the limits a dispatch must respect.', {
      assetId: asset.id,
      maxPowerExport: maxExport,
      assets: count((withCapabilities as { assets?: unknown[] }).assets),
    });
  },
};

export const gridSteps = {
  'demand-response-event': demandResponseSteps,
  'grid-operator-dispatch': gridDispatchSteps,
  'price-signal-coordination': priceSignalSteps,
  'locational-flexibility-market': flexibilitySteps,
  'ev-v2g-session': v2gSteps,
  'smart-home-load-control': smartHomeSteps,
};
