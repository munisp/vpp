package workflows

import (
"time"
"go.temporal.io/sdk/temporal"
"go.temporal.io/sdk/workflow"
)

// AutoTradingWorkflow handles automatic energy export based on rules
func AutoTradingWorkflow(ctx workflow.Context, userID string, assetID string) error {
logger := workflow.GetLogger(ctx)
logger.Info("Starting auto-trading workflow", "userID", userID, "assetID", assetID)

ao := workflow.ActivityOptions{
StartToCloseTimeout: 5 * time.Minute,
RetryPolicy: &temporal.RetryPolicy{
MaximumAttempts: 3,
},
}
ctx = workflow.WithActivityOptions(ctx, ao)

	// Get active trading strategies
	var strategies []map[string]interface{}
	err := workflow.ExecuteActivity(ctx, "GetActiveStrategiesActivity", userID).Get(ctx, &strategies)
	if err != nil {
		logger.Warn("Failed to get strategies, falling back to rules", "error", err)
		// Fallback to old auto-trading rules
		var rules map[string]interface{}
		err = workflow.ExecuteActivity(ctx, "GetAutoTradingRulesActivity", userID).Get(ctx, &rules)
		if err != nil {
			return err
		}
	}
	
	// Get current energy surplus
	var surplus float64
	err = workflow.ExecuteActivity(ctx, "GetEnergySurplusActivity", assetID).Get(ctx, &surplus)
	if err != nil {
		return err
	}
	
	// Get market price
	var price float64
	err = workflow.ExecuteActivity(ctx, "GetMarketPriceActivity").Get(ctx, &price)
	if err != nil {
		return err
	}
	
	// Fetch the real battery state of charge from telemetry. Without it,
	// strategy conditions cannot be evaluated honestly, so skip trading with
	// an explicit reason instead of feeding in a hardcoded value.
	var batterySOC float64
	err = workflow.ExecuteActivity(ctx, "GetBatteryStateOfChargeActivity", assetID).Get(ctx, &batterySOC)
	if err != nil {
		logger.Warn("Skipping trading: battery state of charge unavailable", "assetID", assetID, "error", err)
		return nil
	}

	// Prepare market data for strategy evaluation
	marketData := map[string]interface{}{
		"exportPrice":     price,
		"importPrice":     price * 1.2, // Assume import is 20% higher
		"batterySOC":      batterySOC,
		"availableEnergy": surplus,
	}
	
	// Evaluate strategies
	var strategyToExecute map[string]interface{}
	if len(strategies) > 0 {
		for _, strategy := range strategies {
			var conditionsMet bool
			err = workflow.ExecuteActivity(ctx, "EvaluateStrategyConditionsActivity", strategy, marketData).Get(ctx, &conditionsMet)
			if err != nil {
				logger.Warn("Failed to evaluate strategy", "strategyID", strategy["id"], "error", err)
				continue
			}
			
			if conditionsMet {
				strategyToExecute = strategy
				logger.Info("Strategy conditions met", "strategyID", strategy["id"], "strategyName", strategy["name"])
				break
			}
		}
	}
	
		// Check if surplus meets trading threshold
		if surplus > 0 && (len(strategies) == 0 || strategyToExecute != nil) {
		
		// Create sell order
		var orderID string
		err = workflow.ExecuteActivity(ctx, "CreateSellOrderActivity", userID, surplus, price).Get(ctx, &orderID)
		if err != nil {
			return err
		}
		
		// NOTE: the sell order created above is only PENDING. Strategy
		// performance (and profit) must only be recorded for EXECUTED trades;
		// no execution path exists in this module yet, so nothing is recorded
		// here. Recording surplus*price as profit at this point would be
		// fabricating revenue.

// Publish trading event
err = workflow.ExecuteActivity(ctx, "PublishKafkaEventActivity", "trade.created", orderID).Get(ctx, nil)
if err != nil {
logger.Warn("Failed to publish Kafka event", "error", err)
}

// Send push notification
err = workflow.ExecuteActivity(ctx, "SendPushNotificationActivity", userID, "Trade executed", "Your energy has been sold").Get(ctx, nil)
if err != nil {
logger.Warn("Failed to send push notification", "error", err)
}
}

return nil
}

// ManualTradingWorkflow handles user-initiated energy purchase
func ManualTradingWorkflow(ctx workflow.Context, userID string, amount float64, maxPrice float64) error {
logger := workflow.GetLogger(ctx)
logger.Info("Starting manual trading workflow", "userID", userID, "amount", amount)

ao := workflow.ActivityOptions{
StartToCloseTimeout: 10 * time.Minute,
}
ctx = workflow.WithActivityOptions(ctx, ao)

// Check user wallet balance
var balance float64
err := workflow.ExecuteActivity(ctx, "GetWalletBalanceActivity", userID).Get(ctx, &balance)
if err != nil {
return err
}

// Find best market offer
var offer map[string]interface{}
err = workflow.ExecuteActivity(ctx, "FindBestOfferActivity", amount, maxPrice).Get(ctx, &offer)
if err != nil {
return err
}

// Validate sufficient balance
totalCost := amount * offer["price"].(float64)
if balance < totalCost {
return temporal.NewApplicationError("Insufficient balance", "INSUFFICIENT_BALANCE", nil)
}

// Create buy order
var orderID string
err = workflow.ExecuteActivity(ctx, "CreateBuyOrderActivity", userID, amount, offer["price"]).Get(ctx, &orderID)
if err != nil {
return err
}

// Process payment via TigerBeetle
err = workflow.ExecuteActivity(ctx, "ProcessTigerBeetleTransferActivity", userID, offer["sellerID"], totalCost).Get(ctx, nil)
if err != nil {
// Rollback order
workflow.ExecuteActivity(ctx, "CancelOrderActivity", orderID).Get(ctx, nil)
return err
}

// Update leaderboard
err = workflow.ExecuteActivity(ctx, "UpdateLeaderboardActivity", userID, "trade_completed").Get(ctx, nil)
if err != nil {
logger.Warn("Failed to update leaderboard", "error", err)
}

// Publish event
err = workflow.ExecuteActivity(ctx, "PublishKafkaEventActivity", "trade.completed", orderID).Get(ctx, nil)
if err != nil {
logger.Warn("Failed to publish Kafka event", "error", err)
}

return nil
}

// P2PTradingWorkflow handles peer-to-peer energy trading
func P2PTradingWorkflow(ctx workflow.Context, sellerID string, buyerID string, amount float64, price float64) error {
logger := workflow.GetLogger(ctx)
logger.Info("Starting P2P trading workflow", "sellerID", sellerID, "buyerID", buyerID)

ao := workflow.ActivityOptions{
StartToCloseTimeout: 15 * time.Minute,
}
ctx = workflow.WithActivityOptions(ctx, ao)

// Verify seller has energy available
var available float64
err := workflow.ExecuteActivity(ctx, "VerifyEnergyAvailableActivity", sellerID, amount).Get(ctx, &available)
if err != nil || available < amount {
return temporal.NewApplicationError("Insufficient energy", "INSUFFICIENT_ENERGY", nil)
}

// Verify buyer has sufficient balance
var balance float64
err = workflow.ExecuteActivity(ctx, "GetWalletBalanceActivity", buyerID).Get(ctx, &balance)
if err != nil || balance < (amount * price) {
return temporal.NewApplicationError("Insufficient balance", "INSUFFICIENT_BALANCE", nil)
}

// Create P2P trade agreement
var tradeID string
err = workflow.ExecuteActivity(ctx, "CreateP2PTradeActivity", sellerID, buyerID, amount, price).Get(ctx, &tradeID)
if err != nil {
return err
}

// Process payment
err = workflow.ExecuteActivity(ctx, "ProcessTigerBeetleTransferActivity", buyerID, sellerID, amount*price).Get(ctx, nil)
if err != nil {
workflow.ExecuteActivity(ctx, "CancelP2PTradeActivity", tradeID).Get(ctx, nil)
return err
}

// Transfer energy credits
err = workflow.ExecuteActivity(ctx, "TransferEnergyCreditsActivity", sellerID, buyerID, amount).Get(ctx, nil)
if err != nil {
// Rollback payment
workflow.ExecuteActivity(ctx, "ProcessTigerBeetleTransferActivity", sellerID, buyerID, amount*price).Get(ctx, nil)
workflow.ExecuteActivity(ctx, "CancelP2PTradeActivity", tradeID).Get(ctx, nil)
return err
}

// Update both users' achievements
workflow.ExecuteActivity(ctx, "UpdateAchievementsActivity", sellerID, "p2p_seller").Get(ctx, nil)
workflow.ExecuteActivity(ctx, "UpdateAchievementsActivity", buyerID, "p2p_buyer").Get(ctx, nil)

// Publish event
err = workflow.ExecuteActivity(ctx, "PublishKafkaEventActivity", "p2p.trade.completed", tradeID).Get(ctx, nil)
if err != nil {
logger.Warn("Failed to publish Kafka event", "error", err)
}

// Send notifications to both parties
workflow.ExecuteActivity(ctx, "SendPushNotificationActivity", sellerID, "P2P Trade Completed", "Your energy has been sold").Get(ctx, nil)
workflow.ExecuteActivity(ctx, "SendPushNotificationActivity", buyerID, "P2P Trade Completed", "Energy purchase successful").Get(ctx, nil)

return nil
}
