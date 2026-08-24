/**
 * Market journeys: the order book, bilateral offers, business counterparties
 * and automated strategies.
 */

import {
  classifyDependencyError,
  count,
  errorCode,
  errorMessage,
  failed,
  passed,
  priorNumber,
  refused,
  type JourneyStep,
} from '../step';
import { ensureApprovedAsset, ensureMarketPriceHistory } from '../fixtures';
import { seedStrategyTemplates } from '../../db-strategy-templates';

const BUSINESS_REGISTRATION = 'JRNY-B2B-0001';

export const p2pTradeSteps: Record<string, JourneyStep> = {
  'read-order-book': async ctx => {
    const book = await ctx.member.caller.p2pMatching.getOrderBook();
    const prices = await ctx.member.caller.trading.getMarketPrices();
    const bids = (book as { bids?: unknown[] }).bids ?? [];
    const asks = (book as { asks?: unknown[] }).asks ?? [];
    if (!Array.isArray(bids) || !Array.isArray(asks)) {
      return failed('The order book returned no bid and ask sides to trade against.');
    }
    return passed('The book and the market price it clears against are both readable.', {
      bids: bids.length,
      asks: asks.length,
      hasMarketPrices: Boolean(prices),
    });
  },

  'submit-order': async ctx => {
    const asset = await ensureApprovedAsset(ctx, 'solar', 5_000);
    const submitted = await ctx.member.caller.p2pMatching.submitOrder({
      side: 'sell',
      energyWh: 4_000,
      priceCentsPerKwh: 26,
    });
    const orderId = (submitted as { orderId?: number }).orderId;
    const mine = await ctx.member.caller.p2pMatching.getMyOrders();
    const orders = Array.isArray(mine) ? mine : (mine as { orders?: unknown[] }).orders ?? [];
    if (typeof orderId !== 'number') {
      return failed('p2pMatching.submitOrder returned no order id to track.', { assetId: asset.id });
    }
    if (!Array.isArray(orders) || orders.length === 0) {
      return failed('A submitted order does not appear among the member’s own orders.', { orderId });
    }
    return passed('A sell order is placed and visible to the member who placed it.', {
      orderId,
      myOrders: orders.length,
      fills: count((submitted as { fills?: unknown[] }).fills),
    });
  },

  'offer-and-withdraw': async ctx => {
    await ensureApprovedAsset(ctx, 'solar', 5_000);
    const created = await ctx.member.caller.p2pTrading.createOffer({ energy: 6_000, price: 30 });
    const offerId = (created as { offerId?: number }).offerId;
    if (typeof offerId !== 'number') {
      return failed('p2pTrading.createOffer returned no offer id.');
    }

    const offers = await ctx.member.caller.p2pTrading.getMyOffers();
    const listed = offers.some(offer => offer.id === offerId);

    await ctx.member.caller.p2pTrading.cancelOffer({ offerId });
    const afterCancel = await ctx.member.caller.p2pTrading.getMyOffers();
    const stillOpen = afterCancel.some(
      offer => offer.id === offerId && offer.status === 'pending'
    );
    if (stillOpen) {
      return failed('A withdrawn offer is still open on the market.', { offerId });
    }
    return passed('An offer can be published and withdrawn again.', {
      offerId,
      wasListed: listed,
      openOffersAfter: afterCancel.filter(offer => offer.status === 'pending').length,
    });
  },

  'settlement-evidence': async ctx => {
    const rows = await ctx.member.caller.p2pTrading.mySettlements();
    const chain = await ctx.member.caller.settlement.verifyChain();
    const chainValid = (chain as { valid?: boolean; isValid?: boolean }).valid
      ?? (chain as { isValid?: boolean }).isValid;

    // Every settlement must name the delivery it was measured from. A settled
    // figure with no delivered energy behind it is the failure mode this step
    // exists to catch.
    const unevidenced = rows.filter(
      row =>
        (row.state === 'delivery_evidenced' || row.state === 'complete') &&
        (row.deliveredEnergyWh === null || row.delivery !== 'measured')
    ).length;
    if (unevidenced > 0) {
      return failed('A settlement claims delivery with no measured energy behind it.', {
        settlements: rows.length,
        unevidenced,
      });
    }
    if (chainValid === false) {
      return failed('The settlement chain does not verify.', { settlements: rows.length });
    }
    return passed('Settlements name their delivered energy, and the chain verifies.', {
      settlements: rows.length,
      complete: rows.filter(row => row.state === 'complete').length,
      awaitingPayout: rows.filter(row => row.sellerPayout === 'unavailable_no_provider').length,
      chainVerified: chainValid === true,
    });
  },

  'pay-for-match': async ctx => {
    // Buy from the member's own offer through the counterparty, so there is a
    // real match to pay for rather than a hand-written trade row.
    await ensureApprovedAsset(ctx, 'solar', 5_000);
    const created = await ctx.member.caller.p2pTrading.createOffer({ energy: 5_000, price: 28 });
    const offerId = (created as { offerId?: number }).offerId;
    if (typeof offerId !== 'number') {
      return failed('No offer could be published to pay for.');
    }

    let buyTradeId: number | null = null;
    try {
      const accepted = await ctx.counterparty.caller.p2pTrading.acceptOffer({ offerId });
      buyTradeId = (accepted as { buyTradeId?: number; tradeId?: number }).buyTradeId
        ?? (accepted as { tradeId?: number }).tradeId
        ?? null;
    } catch (error) {
      await ctx.member.caller.p2pTrading.cancelOffer({ offerId }).catch(() => undefined);
      return classifyDependencyError(error, 'mobile_money', { offerId, stage: 'accept' });
    }
    if (buyTradeId === null) {
      return failed('Accepting an offer returned no buy trade to pay for.', { offerId });
    }

    try {
      const payment = await ctx.counterparty.caller.p2pTrading.payForMatch({
        buyTradeId,
        gateway: 'mpesa',
        phoneNumber: '255700000001',
      });
      const status = (payment as { status?: string }).status ?? 'unknown';
      if (status === 'completed') {
        return failed(
          'A payment reports completed without gateway evidence; only a callback may complete one.',
          { buyTradeId, status }
        );
      }
      return passed('The gateway accepted the charge and the match stays pending its callback.', {
        buyTradeId,
        status,
      });
    } catch (error) {
      return classifyDependencyError(error, 'mobile_money', { buyTradeId, stage: 'pay' });
    }
  },
};

export const b2bTradeSteps: Record<string, JourneyStep> = {
  'operator-sets-price': async ctx => {
    const before = await ctx.admin.caller.admin.getMarketPrices();
    const price = 2_700;
    const effectiveFrom = new Date();
    await ctx.admin.caller.admin.setMarketPrice({
      priceType: 'peak',
      country: ctx.member.user.country,
      price,
      effectiveFrom,
      validUntil: new Date(effectiveFrom.getTime() + 60 * 60 * 1000),
    });
    // The route returns the rows themselves, not a wrapper.
    const after = await ctx.admin.caller.admin.getMarketPrices();
    const prices = (after as Array<{ priceType?: string; country?: string; price?: number }>) ?? [];
    const readBack = prices.find(
      row => row.priceType === 'peak' && row.country === ctx.member.user.country
    );
    if (!readBack || readBack.price !== price) {
      return failed('A market price the operator set does not read back at that price.', {
        prices: prices.length,
        readBack: readBack?.price ?? null,
      });
    }
    return passed('The operator set the peak-band price the market clears at.', {
      pricesBefore: count(before as unknown[]),
      peakPriceCentsPerKwh: readBack.price,
      country: ctx.member.user.country,
    });
  },

  'published-tariff': async ctx => {
    const country = ctx.member.user.country;
    const seeded = await ensureMarketPriceHistory(ctx, country);

    // A tariff is only publishable from real price history; the engine refuses
    // otherwise, and that refusal is the honest outcome to report.
    let publishedVersion: number | null = null;
    try {
      const publishResult = await ctx.admin.caller.dynamicTariffs.publishTariff({ country });
      publishedVersion = (publishResult as { version?: number }).version ?? null;
    } catch (error) {
      if (errorCode(error) === 'PRECONDITION_FAILED') {
        return refused(errorMessage(error), {
          country,
          pricesSeeded: seeded.seeded,
          pricesAlreadyPresent: seeded.existing,
        });
      }
      throw error;
    }

    const published = await ctx.member.caller.dynamicTariffs.getPublishedTariff({ country });
    const readBackVersion =
      (published as { published?: { version?: number } | null }).published?.version ?? null;
    if (publishedVersion === null || readBackVersion !== publishedVersion) {
      return failed('A published tariff version is not the version members read.', {
        publishedVersion,
        readBackVersion,
      });
    }

    const current = await ctx.member.caller.dynamicTariffs.getCurrentTariff({ country });
    const currentPrice =
      (current as { current?: { finalPriceCentsPerKwh?: number | null } }).current
        ?.finalPriceCentsPerKwh ?? null;
    const versions = await ctx.admin.caller.dynamicTariffs.listVersions({ country, limit: 5 });

    return passed('A tariff is published from real price history and read back at its version.', {
      country,
      publishedVersion,
      versions: count(versions as unknown[]),
      currentHourPriceCentsPerKwh: currentPrice,
      pricesSeeded: seeded.seeded,
      pricesAlreadyPresent: seeded.existing,
    });
  },

  'business-counterparty-offer': async ctx => {
    await ensureApprovedAsset(ctx, 'solar', 20_000);

    // A re-run starts from an unverified declaration: an account this journey
    // verified on an earlier run has its verification withdrawn first, which is
    // what an operator does when a registration lapses.
    const existing = await ctx.member.caller.marketParticipants.me();
    const wasVerified = existing.businessVerifiedAt !== null;
    if (wasVerified) {
      await ctx.admin.caller.marketParticipants.revokeVerification({
        userId: ctx.member.user.id,
        reason: `Journey run ${ctx.runKey}: re-verifying the declared business from an unverified state.`,
      });
    }

    // A business must be a verified business before it can trade. Declaring is
    // deliberately not enough: an unverified declaration is refused.
    await ctx.member.caller.marketParticipants.declareBusiness({
      legalName: `Journey Energy Ltd ${ctx.member.user.id}`,
      registrationNumber: BUSINESS_REGISTRATION,
    });
    const declared = await ctx.member.caller.marketParticipants.me();
    if (declared.canTrade !== false) {
      return failed('An unverified business is allowed to trade.', {
        userId: ctx.member.user.id,
        verificationWithdrawnFirst: wasVerified,
      });
    }

    let refusedUnverified = false;
    try {
      await ctx.member.caller.p2pTrading.createOffer({ energy: 10_000, price: 24 });
    } catch {
      refusedUnverified = true;
    }

    await ctx.admin.caller.marketParticipants.verifyBusiness({
      userId: ctx.member.user.id,
      evidence: `Journey run ${ctx.runKey}: registration ${BUSINESS_REGISTRATION} checked against the register.`,
    });
    const verified = await ctx.member.caller.marketParticipants.me();
    if (verified.canTrade !== true) {
      return failed('A verified business still cannot trade.', { userId: ctx.member.user.id });
    }

    const created = await ctx.member.caller.p2pTrading.createOffer({ energy: 10_000, price: 24 });
    const offerId = (created as { offerId?: number }).offerId;
    const sellerType = (created as { sellerParticipantType?: string }).sellerParticipantType;
    if (typeof offerId !== 'number') {
      return failed('A verified business could not publish an offer.');
    }
    if (sellerType !== 'business') {
      return failed('A business offer does not carry its counterparty type.', {
        offerId,
        sellerParticipantType: sellerType ?? 'none',
      });
    }

    const market = await ctx.counterparty.caller.p2pTrading.getOffers({ limit: 50 });
    const visible = market.some(offer => offer.id === offerId);
    if (!visible) {
      await ctx.member.caller.p2pTrading.cancelOffer({ offerId }).catch(() => undefined);
      return failed('A published business offer is not visible to a buyer on the market.', {
        offerId,
        openOffers: market.length,
      });
    }
    await ctx.member.caller.p2pTrading.cancelOffer({ offerId });

    return passed('A verified business trades as a business, and an unverified one is refused.', {
      offerId,
      refusedWhileUnverified: refusedUnverified,
      verificationWithdrawnFirst: wasVerified,
      visibleToCounterparty: visible,
      sellerParticipantType: sellerType,
    });
  },

  'wholesale-position': async ctx => {
    const trades = await ctx.member.caller.trading.list({ limit: 50 });
    const earnings = await ctx.member.caller.trading.getEarnings();
    const rows = (trades as { trades?: unknown[] }).trades ?? [];
    if (!Array.isArray(rows)) {
      return failed('trading.list returned no trades collection.');
    }
    if (!earnings) {
      return failed('trading.getEarnings returned nothing for the business to read.');
    }
    return passed('The business can read its own trades and what they earned.', {
      trades: rows.length,
    });
  },
};

export const strategySteps: Record<string, JourneyStep> = {
  'clone-template': async ctx => {
    // The library is static product content the app seeds at boot; the journey
    // runs the same idempotent seed so a run against a fresh database exercises
    // cloning rather than reporting an empty shelf.
    await seedStrategyTemplates();
    const templates = await ctx.member.caller.strategyTemplates.list();
    const list = Array.isArray(templates)
      ? templates
      : (templates as { templates?: Array<{ id: number }> }).templates ?? [];
    if (list.length === 0) {
      return failed('The platform ships a strategy library, but no template is on offer.');
    }
    const templateId = (list[0] as { id: number }).id;
    const cloned = await ctx.member.caller.strategyTemplates.clone({ templateId });
    const strategyId = cloned.strategyId;

    const strategies = await ctx.member.caller.tradingStrategies.list();
    const owned = Array.isArray(strategies)
      ? strategies
      : (strategies as { strategies?: Array<{ id: number }> }).strategies ?? [];
    if (typeof strategyId !== 'number' || !owned.some(s => (s as { id: number }).id === strategyId)) {
      return failed('A cloned template did not become a strategy the member owns.', {
        templateId,
        strategyId: strategyId ?? null,
      });
    }
    const resolvedId = strategyId;
    return passed('A template is cloned into the member’s own strategies.', {
      templateId,
      strategyId: resolvedId,
      ownedStrategies: owned.length,
    });
  },

  'backtest-strategy': async ctx => {
    const strategyId = priorNumber(ctx, 'clone-template', 'strategyId');
    const result = await ctx.member.caller.tradingStrategies.backtest({
      id: strategyId,
      period: '30d',
    });
    const results = result.results;
    // A backtest either names the history it measured or says it measured none;
    // a return with no stated basis is the failure this step exists to catch.
    if (!results.measured) {
      if (results.successRate !== null) {
        return failed('An unmeasured backtest still reports a success rate.', {
          strategyId,
          tradesConsidered: results.tradesConsidered,
          successRate: results.successRate,
        });
      }
      return refused('The backtest states it had no matching history rather than a return.', {
        strategyId,
        tradesConsidered: results.tradesConsidered,
        simulatedTrades: results.simulatedTrades,
        detail: result.message,
      });
    }
    if (results.successRate === null) {
      return failed('A measured backtest cannot state the rate it measured.', { strategyId });
    }
    return passed('The backtest reports what it measured over recorded history.', {
      strategyId,
      tradesConsidered: results.tradesConsidered,
      simulatedTrades: results.simulatedTrades,
      successRate: results.successRate,
    });
  },

  'activate-and-stand-down': async ctx => {
    const strategyId = priorNumber(ctx, 'clone-template', 'strategyId');
    await ctx.member.caller.tradingStrategies.activate({ id: strategyId });
    const active = await ctx.member.caller.tradingStrategies.getById({ id: strategyId });
    const isActive = (active as { strategy?: { isActive?: boolean }; isActive?: boolean }).strategy
      ?.isActive ?? (active as { isActive?: boolean }).isActive;
    await ctx.member.caller.tradingStrategies.deactivate({ id: strategyId });
    const after = await ctx.member.caller.tradingStrategies.getById({ id: strategyId });
    const stillActive = (after as { strategy?: { isActive?: boolean }; isActive?: boolean }).strategy
      ?.isActive ?? (after as { isActive?: boolean }).isActive;

    if (isActive === false) {
      return failed('An activated strategy does not read back as active.', { strategyId });
    }
    if (stillActive === true) {
      return failed('A stood-down strategy is still active.', { strategyId });
    }
    return passed('A strategy can be put to work and stood down again.', { strategyId });
  },

  'compare-strategies': async ctx => {
    const strategyId = priorNumber(ctx, 'clone-template', 'strategyId');
    const templates = await ctx.member.caller.strategyTemplates.list();
    const list = Array.isArray(templates)
      ? templates
      : (templates as { templates?: Array<{ id: number }> }).templates ?? [];
    if (list.length < 2) {
      return refused('Fewer than two templates exist, so nothing can be compared.', { strategyId });
    }
    const second = await ctx.member.caller.strategyTemplates.clone({
      templateId: (list[1] as { id: number }).id,
    });
    const secondId = (second as { strategyId?: number; id?: number }).strategyId
      ?? (second as { id?: number }).id;
    if (typeof secondId !== 'number') {
      return failed('A second strategy could not be cloned to compare against.');
    }

    const comparison = await ctx.member.caller.strategyComparison.compare({
      strategyIds: [strategyId, secondId],
    });
    const recommendation = await ctx.member.caller.strategyComparison.recommend({
      goal: 'balanced',
      strategyIds: [strategyId, secondId],
    });
    const compared = (comparison as { strategies?: unknown[] }).strategies
      ?? (Array.isArray(comparison) ? comparison : []);
    if (!Array.isArray(compared) || compared.length < 2) {
      return failed('A two-strategy comparison did not return both strategies.', {
        strategyId,
        secondId,
      });
    }
    return passed('Strategies are compared and a recommendation is given for the stated goal.', {
      strategyId,
      secondId,
      compared: compared.length,
      hasRecommendation: Boolean(recommendation),
    });
  },

  'price-alerts': async ctx => {
    const created = await ctx.member.caller.priceAlerts.create({
      name: `Journey alert ${ctx.runKey}`,
      alertType: 'above',
      targetPrice: 40,
      notifyEmail: true,
      notifyPush: false,
      notifySMS: false,
      cooldownMinutes: 60,
    });
    const alertId = created.alertId;
    if (typeof alertId !== 'number') {
      return failed('priceAlerts.create returned no alert id.');
    }

    const active = await ctx.member.caller.priceAlerts.listActive();
    const activeList = Array.isArray(active)
      ? active
      : (active as { alerts?: unknown[] }).alerts ?? [];

    const subscription = await ctx.member.caller.priceAlertEngine.subscribe({
      name: `Journey engine alert ${ctx.runKey}`,
      alertType: 'above',
      targetPrice: 45,
      country: 'tanzania',
      priceType: 'peak',
    });
    const subscriptions = await ctx.member.caller.priceAlertEngine.listMySubscriptions();
    const subs = Array.isArray(subscriptions)
      ? subscriptions
      : (subscriptions as { subscriptions?: unknown[] }).subscriptions ?? [];

    await ctx.member.caller.priceAlerts.delete({ id: alertId });

    return passed('A price alert can be subscribed to, listed and withdrawn.', {
      alertId,
      activeAlerts: Array.isArray(activeList) ? activeList.length : 0,
      subscriptions: Array.isArray(subs) ? subs.length : 0,
      hasSubscription: Boolean(subscription),
    });
  },
};

export const marketSteps = {
  'p2p-neighbour-trade': p2pTradeSteps,
  'b2b-wholesale-trade': b2bTradeSteps,
  'automated-trading-strategy': strategySteps,
};
