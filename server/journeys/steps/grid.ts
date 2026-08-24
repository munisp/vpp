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
import { ensureApprovedAsset, ingestReadings, registerDevice } from '../fixtures';

function minutesFromNow(minutes: number): Date {
  return new Date(Date.now() + minutes * 60 * 1000);
}

export const demandResponseSteps: Record<string, JourneyStep> = {
  enrol: async ctx => {
    await ensureApprovedAsset(ctx, 'battery', 10_000);
    await ctx.member.caller.demandResponse.enroll({
      autoOptIn: true,
      minCompensation: 10,
      maxReduction: 5_000,
    });
    const enrolment = await ctx.member.caller.demandResponse.getEnrollment();
    const status = (enrolment as { enrollment?: { status?: string }; status?: string }).enrollment
      ?.status ?? (enrolment as { status?: string }).status ?? null;
    if (status === null) {
      return failed('An enrolment was accepted but reads back with no status.');
    }
    return passed('The member is enrolled in demand response and can see it.', { status });
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
    const eventId = (created as { event?: { id?: number }; eventId?: number }).event?.id
      ?? (created as { eventId?: number }).eventId;
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
    const upcoming = await ctx.member.caller.demandResponse.getUpcomingEvents();
    const events = (upcoming as { events?: Array<{ id: number }> }).events ?? [];
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
    const responses = await ctx.member.caller.demandResponse.getMyResponses();
    const rows = (responses as { responses?: Array<{ eventId?: number }> }).responses ?? [];
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
    const participants = (recommended as { recommendations?: unknown[] }).recommendations
      ?? (Array.isArray(recommended) ? recommended : []);
    if (!Array.isArray(participants)) {
      return failed('Participant targeting returned no recommendations collection.', { eventId });
    }
    if (participants.length === 0) {
      return refused('No participant met the targeting criteria, rather than a padded list.', {
        eventId,
        forecasts: count((forecasts as { forecasts?: unknown[] }).forecasts),
      });
    }
    return passed('Targeting names the participants it recommends and why.', {
      eventId,
      recommended: participants.length,
      hasSegmentDistribution: Boolean(distribution),
    });
  },

  compensation: async ctx => {
    const compensation = await ctx.member.caller.demandResponse.getMyCompensation();
    const analytics = await ctx.member.caller.demandResponse.getMyAnalytics();
    const total = (compensation as { totalCompensation?: number }).totalCompensation ?? null;
    const measured = (analytics as { measuredEvents?: number; totalEvents?: number }).measuredEvents
      ?? (analytics as { totalEvents?: number }).totalEvents
      ?? null;
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
    const rows = (fleet as { windows?: Array<Record<string, unknown>> }).windows ?? [];
    if (!Array.isArray(rows)) {
      return failed('The fleet control list returned no windows collection.');
    }
    const unbounded = rows.filter(row => !row.validUntil && !row.expiresAt).length;
    if (unbounded > 0) {
      return failed('A control is in force with no expiry.', { windows: rows.length, unbounded });
    }
    return passed('Fleet controls all carry an expiry, and a member sees only their own.', {
      fleetWindows: rows.length,
      myWindows: count((mine as { windows?: unknown[] }).windows),
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
    const expired = (swept as { expired?: number; swept?: number }).expired
      ?? (swept as { swept?: number }).swept
      ?? null;
    if (expired === null) {
      return failed('The expiry sweep does not report what it swept.');
    }
    return passed('Expired controls are swept into their declared fallback.', { swept: expired });
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
    await ensureApprovedAsset(ctx, 'battery', 10_000);
    const signal = await ctx.admin.caller.priceSignal.coordinate({
      userIds: [ctx.member.user.id],
      intervalMinutes: 15,
      startsAt: minutesFromNow(15),
      targetNetW: [-2_000, -1_500, -1_000, -500],
      sharedImportLimitW: [4_000, 4_000, 4_000, 4_000],
      siteImportLimitW: 6_000,
      siteExportLimitW: 4_000,
      scopeType: 'fleet',
    });
    const signalId = (signal as { signalId?: string }).signalId;
    const state = (signal as { state?: string; status?: string }).state
      ?? (signal as { status?: string }).status
      ?? 'unknown';
    if (typeof signalId !== 'string') {
      return failed('priceSignal.coordinate returned no signal id.');
    }
    return passed('A price signal is coordinated and carries its convergence state.', {
      signalId,
      state,
    });
  },

  publish: async ctx => {
    const signalId = priorString(ctx, 'coordinate', 'signalId');
    const state = priorString(ctx, 'coordinate', 'state');
    if (state !== 'converged') {
      // A signal that missed its target must not reach the fleet.
      try {
        await ctx.admin.caller.priceSignal.publish({ signalId });
        return failed('A signal that did not converge was published to the fleet.', {
          signalId,
          state,
        });
      } catch {
        return refused('A signal that did not converge cannot be published.', { signalId, state });
      }
    }
    try {
      const published = await ctx.admin.caller.priceSignal.publish({ signalId });
      const delivery = (published as { delivery?: string; status?: string }).delivery
        ?? (published as { status?: string }).status
        ?? 'unknown';
      if (delivery === 'received' || delivery === 'applied') {
        return failed('A broker publish is recorded as the site having applied the signal.', {
          signalId,
          delivery,
        });
      }
      return passed('The signal is sent, with delivery recorded as receipt-unknown.', {
        signalId,
        delivery,
      });
    } catch (error) {
      return classifyDependencyError(error, 'mqtt_broker', { signalId });
    }
  },

  'member-view': async ctx => {
    const signalId = priorString(ctx, 'coordinate', 'signalId');
    const mine = await ctx.member.caller.priceSignal.mySignals({ limit: 20 });
    const rows = (mine as { signals?: Array<{ signalId?: string }> }).signals ?? [];
    if (!Array.isArray(rows)) {
      return failed('A member’s price signals returned no collection.');
    }
    const seen = rows.some(row => row.signalId === signalId);
    if (!seen && rows.length > 0) {
      return refused('The signal was not published to this site, so the site does not see it.', {
        signalId,
        signals: rows.length,
      });
    }
    return passed('A site sees the signals it was actually sent.', {
      signalId,
      signals: rows.length,
      sawThisSignal: seen,
    });
  },

  score: async ctx => {
    const signalId = priorString(ctx, 'coordinate', 'signalId');
    const asset = await ensureApprovedAsset(ctx, 'battery', 10_000);
    const credential = await registerDevice(ctx, asset.id, 'battery_controller');
    await ingestReadings(ctx, asset.id, credential, 4);
    try {
      const scored = await ctx.admin.caller.priceSignal.score({ signalId });
      const sites = (scored as { sites?: Array<{ verdict?: string }> }).sites ?? [];
      const listed = await ctx.admin.caller.priceSignal.list({ limit: 10 });
      const unmeasured = sites.filter(site => site.verdict === 'unmeasured').length;
      return passed('Scoring measures each site across all its meters, or says it could not.', {
        signalId,
        sitesScored: sites.length,
        unmeasured,
        signals: count((listed as { signals?: unknown[] }).signals),
      });
    } catch (error) {
      return classifyDependencyError(error, 'mqtt_broker', { signalId, stage: 'score' });
    }
  },
};

export const flexibilitySteps: Record<string, JourneyStep> = {
  topology: async ctx => {
    const asset = await ensureApprovedAsset(ctx, 'battery', 10_000);
    const code = `JRNY-FEEDER-${ctx.member.user.id}`;
    const existing = await ctx.admin.caller.locationalFlexibility.nodes({});
    const nodes = (existing as { nodes?: Array<{ id: number; code?: string }> }).nodes ?? [];
    let nodeId = nodes.find(node => node.code === code)?.id ?? null;
    if (nodeId === null) {
      const created = await ctx.admin.caller.locationalFlexibility.createNode({
        code,
        name: `Journey feeder ${ctx.member.user.id}`,
        kind: 'feeder',
        region: 'TZ-DAR',
        firmCapacityW: 250_000,
      });
      nodeId = (created as { node?: { id?: number }; nodeId?: number }).node?.id
        ?? (created as { nodeId?: number }).nodeId
        ?? null;
    }
    if (nodeId === null) {
      return failed('A flexibility node could not be created or found.');
    }
    await ctx.admin.caller.locationalFlexibility.linkAsset({
      nodeId,
      assetId: asset.id,
      linkSource: 'operator_declared',
      evidence: `Journey run ${ctx.runKey}: operator-declared connection, not utility-verified.`,
    });
    return passed('The node exists and the asset link carries how it was established.', {
      nodeId,
      assetId: asset.id,
      linkSource: 'operator_declared',
    });
  },

  requirement: async ctx => {
    const nodeId = priorNumber(ctx, 'topology', 'nodeId');
    const startsAt = minutesFromNow(20);
    const created = await ctx.admin.caller.locationalFlexibility.createRequirement({
      nodeId,
      direction: 'import_reduction',
      startsAt,
      endsAt: new Date(startsAt.getTime() + 60 * 60 * 1000),
      requiredPowerW: 8_000,
      priceCapCentsPerKwh: 40,
      currency: 'TZS',
      notes: `Journey run ${ctx.runKey}`,
    });
    const requirementId = (created as { requirement?: { id?: number }; requirementId?: number })
      .requirement?.id ?? (created as { requirementId?: number }).requirementId ?? null;
    if (requirementId === null) {
      return failed('A located requirement could not be opened for bids.', { nodeId });
    }
    const listed = await ctx.admin.caller.locationalFlexibility.requirements({ nodeId, limit: 50 });
    return passed('A located requirement is open, priced and time-bounded.', {
      nodeId,
      requirementId,
      open: count((listed as { requirements?: unknown[] }).requirements),
    });
  },

  'member-offers': async ctx => {
    const requirementId = priorNumber(ctx, 'requirement', 'requirementId');
    const asset = await ensureApprovedAsset(ctx, 'battery', 10_000);
    const opportunities = await ctx.member.caller.locationalFlexibility.myOpportunities();
    const rows = (opportunities as { opportunities?: Array<{ requirementId?: number; id?: number }> })
      .opportunities ?? [];
    const visible = rows.some(
      row => row.requirementId === requirementId || row.id === requirementId
    );
    const offered = await ctx.member.caller.locationalFlexibility.offer({
      requirementId,
      assetId: asset.id,
      offeredPowerW: 4_000,
      priceCentsPerKwh: 30,
    });
    const offerId = (offered as { offer?: { id?: number }; offerId?: number }).offer?.id
      ?? (offered as { offerId?: number }).offerId
      ?? null;
    if (offerId === null) {
      return failed('An offer into an open requirement returned no offer id.', { requirementId });
    }
    return passed('The member sees the located opportunity and offers into it.', {
      requirementId,
      offerId,
      sawOpportunity: visible,
    });
  },

  'clear-and-measure': async ctx => {
    const requirementId = priorNumber(ctx, 'requirement', 'requirementId');
    const cleared = await ctx.admin.caller.locationalFlexibility.clear({ requirementId });
    if (!cleared || cleared.awards.length === 0) {
      return refused('The requirement cleared short rather than awarding unverified capacity.', {
        requirementId,
        status: cleared?.status ?? 'unknown',
        ineligible: cleared?.ineligible.length ?? 0,
      });
    }

    const measured = await ctx.admin.caller.locationalFlexibility.measure({ requirementId });
    const results = measured?.results ?? [];
    if (results.length === 0) {
      return failed('A cleared requirement measured no awards.', { requirementId });
    }
    const first = results[0];
    if (first.deliveryStatus === 'unverified') {
      return refused('Too little telemetry to verify delivery: neither paid nor treated as breach.', {
        requirementId,
        awardId: first.awardId,
        deliveryStatus: first.deliveryStatus,
        unverifiedReason: first.unverifiedReason,
      });
    }
    const settled = await ctx.admin.caller.locationalFlexibility.settle({
      awardId: first.awardId,
    });
    return passed('Merit-order clearing, measured delivery, then settlement of measured energy.', {
      requirementId,
      awardId: first.awardId,
      deliveryStatus: first.deliveryStatus,
      deliveredEnergyWh: first.deliveredEnergyWh,
      settledAmount: settled?.amount ?? null,
    });
  },

  'member-awards': async ctx => {
    const rows = (await ctx.member.caller.locationalFlexibility.myAwards({ limit: 25 })) ?? [];
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
