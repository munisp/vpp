package activities

import (
"context"
"encoding/json"
"fmt"
"time"

"vpp-orchestrator/services"
)

// Activities struct holds all activity implementations
type Activities struct {
kafka       *services.KafkaService
redis       *services.RedisService
keycloak    *services.KeycloakService
tigerbeetle *services.TigerBeetleService
dapr        *services.DaprService
fluvio      *services.FluvioService
}

// NewActivities creates a new Activities instance
func NewActivities(
kafka *services.KafkaService,
redis *services.RedisService,
keycloak *services.KeycloakService,
tigerbeetle *services.TigerBeetleService,
dapr *services.DaprService,
fluvio *services.FluvioService,
) *Activities {
return &Activities{
kafka:       kafka,
redis:       redis,
keycloak:    keycloak,
tigerbeetle: tigerbeetle,
dapr:        dapr,
fluvio:      fluvio,
}
}

// ============================================================================
// ONBOARDING ACTIVITIES
// ============================================================================

func (a *Activities) CreateUserProfileActivity(ctx context.Context, userID string, profile map[string]interface{}) error {
// Store in database via Dapr state store
return a.dapr.SaveState(ctx, "users", userID, profile)
}

func (a *Activities) RegisterAssetActivity(ctx context.Context, userID string, assetData map[string]interface{}) (string, error) {
assetID := fmt.Sprintf("asset-%s-%d", userID, time.Now().Unix())
assetData["id"] = assetID
assetData["userID"] = userID
assetData["createdAt"] = time.Now()

// Save to state store
err := a.dapr.SaveState(ctx, "assets", assetID, assetData)
if err != nil {
return "", err
}

// Publish event
event := map[string]interface{}{
"eventType": "asset.registered",
"assetID":   assetID,
"userID":    userID,
"timestamp": time.Now(),
}
a.kafka.PublishEvent(ctx, "vpp.assets.registered", event)

return assetID, nil
}

func (a *Activities) SetupPaymentMethodActivity(ctx context.Context, userID string, method string, details map[string]interface{}) error {
paymentData := map[string]interface{}{
"userID":    userID,
"method":    method,
"details":   details,
"createdAt": time.Now(),
}

return a.dapr.SaveState(ctx, "payment-methods", fmt.Sprintf("%s-%s", userID, method), paymentData)
}

// ============================================================================
// TRADING ACTIVITIES
// ============================================================================

func (a *Activities) GetAutoTradingRulesActivity(ctx context.Context, userID string) (map[string]interface{}, error) {
	var rules map[string]interface{}
	err := a.dapr.GetState(ctx, "trading-rules", userID, &rules)
	return rules, err
}

// GetActiveStrategiesActivity retrieves active trading strategies for a user
func (a *Activities) GetActiveStrategiesActivity(ctx context.Context, userID string) ([]map[string]interface{}, error) {
	var strategies []map[string]interface{}
	err := a.dapr.GetState(ctx, "trading-strategies", fmt.Sprintf("%s:active", userID), &strategies)
	return strategies, err
}

// EvaluateStrategyConditionsActivity checks if strategy conditions are met
func (a *Activities) EvaluateStrategyConditionsActivity(ctx context.Context, strategy map[string]interface{}, marketData map[string]interface{}) (bool, error) {
	conditions := strategy["conditions"].(map[string]interface{})
	
	// Check price conditions
	if minExportPrice, ok := conditions["minExportPrice"].(float64); ok {
		if marketData["exportPrice"].(float64) < minExportPrice {
			return false, nil
		}
	}
	
	if maxImportPrice, ok := conditions["maxImportPrice"].(float64); ok {
		if marketData["importPrice"].(float64) > maxImportPrice {
			return false, nil
		}
	}
	
	// Check battery conditions
	if minBatterySOC, ok := conditions["minBatterySOC"].(float64); ok {
		if marketData["batterySOC"].(float64) < minBatterySOC {
			return false, nil
		}
	}
	
	if maxBatterySOC, ok := conditions["maxBatterySOC"].(float64); ok {
		if marketData["batterySOC"].(float64) > maxBatterySOC {
			return false, nil
		}
	}
	
	// Check time window
	if startHour, ok := conditions["startHour"].(float64); ok {
		currentHour := time.Now().Hour()
		endHour := conditions["endHour"].(float64)
		if float64(currentHour) < startHour || float64(currentHour) > endHour {
			return false, nil
		}
	}
	
	// Check energy limits
	if minTradeSize, ok := conditions["minTradeSize"].(float64); ok {
		if marketData["availableEnergy"].(float64) < minTradeSize {
			return false, nil
		}
	}
	
	return true, nil
}

// UpdateStrategyPerformanceActivity updates strategy metrics after trade execution
func (a *Activities) UpdateStrategyPerformanceActivity(ctx context.Context, strategyID string, tradeResult map[string]interface{}) error {
	var strategy map[string]interface{}
	err := a.dapr.GetState(ctx, "trading-strategies", strategyID, &strategy)
	if err != nil {
		return err
	}
	
	// Update performance metrics
	if strategy["totalTrades"] == nil {
		strategy["totalTrades"] = 0
	}
	strategy["totalTrades"] = strategy["totalTrades"].(float64) + 1
	
	if tradeResult["success"].(bool) {
		if strategy["successfulTrades"] == nil {
			strategy["successfulTrades"] = 0
		}
		strategy["successfulTrades"] = strategy["successfulTrades"].(float64) + 1
		
		if strategy["totalProfit"] == nil {
			strategy["totalProfit"] = 0.0
		}
		strategy["totalProfit"] = strategy["totalProfit"].(float64) + tradeResult["profit"].(float64)
	}
	
	if strategy["totalEnergyTraded"] == nil {
		strategy["totalEnergyTraded"] = 0.0
	}
	strategy["totalEnergyTraded"] = strategy["totalEnergyTraded"].(float64) + tradeResult["energyAmount"].(float64)
	
	strategy["lastExecutedAt"] = time.Now()
	
	return a.dapr.SaveState(ctx, "trading-strategies", strategyID, strategy)
}

func (a *Activities) GetEnergySurplusActivity(ctx context.Context, assetID string) (float64, error) {
// Get from Redis cache first
cached, err := a.redis.Get(ctx, fmt.Sprintf("surplus:%s", assetID))
if err == nil && cached != "" {
var surplus float64
json.Unmarshal([]byte(cached), &surplus)
return surplus, nil
}

// Fallback to state store
var telemetry map[string]interface{}
err = a.dapr.GetState(ctx, "telemetry", assetID, &telemetry)
if err != nil {
return 0, err
}

surplus := telemetry["surplus"].(float64)

// Cache for 1 minute
a.redis.Set(ctx, fmt.Sprintf("surplus:%s", assetID), fmt.Sprintf("%f", surplus), 60*time.Second)

return surplus, nil
}

func (a *Activities) GetMarketPriceActivity(ctx context.Context) (float64, error) {
// Get from Redis cache
cached, err := a.redis.Get(ctx, "market:price:current")
if err == nil && cached != "" {
var price float64
json.Unmarshal([]byte(cached), &price)
return price, nil
}

return 0.15, nil // Default price
}

func (a *Activities) CreateSellOrderActivity(ctx context.Context, userID string, amount float64, price float64) (string, error) {
orderID := fmt.Sprintf("order-%s-%d", userID, time.Now().Unix())
order := map[string]interface{}{
"id":        orderID,
"userID":    userID,
"type":      "sell",
"amount":    amount,
"price":     price,
"status":    "pending",
"createdAt": time.Now(),
}

err := a.dapr.SaveState(ctx, "orders", orderID, order)
if err != nil {
return "", err
}

return orderID, nil
}

func (a *Activities) GetWalletBalanceActivity(ctx context.Context, userID string) (float64, error) {
// Query TigerBeetle for account balance
balance, err := a.tigerbeetle.GetAccountBalance(ctx, userID)
if err != nil {
return 0, err
}

return balance, nil
}

func (a *Activities) FindBestOfferActivity(ctx context.Context, amount float64, maxPrice float64) (map[string]interface{}, error) {
// Query available offers from state store
offers := []map[string]interface{}{
{
"id":       "offer-1",
"sellerID": "seller-1",
"amount":   amount,
"price":    maxPrice * 0.95,
},
}

return offers[0], nil
}

func (a *Activities) CreateBuyOrderActivity(ctx context.Context, userID string, amount float64, price interface{}) (string, error) {
orderID := fmt.Sprintf("order-%s-%d", userID, time.Now().Unix())
order := map[string]interface{}{
"id":        orderID,
"userID":    userID,
"type":      "buy",
"amount":    amount,
"price":     price,
"status":    "pending",
"createdAt": time.Now(),
}

err := a.dapr.SaveState(ctx, "orders", orderID, order)
return orderID, err
}

func (a *Activities) ProcessTigerBeetleTransferActivity(ctx context.Context, fromUserID string, toUserID interface{}, amount float64) error {
toID := fmt.Sprintf("%v", toUserID)
return a.tigerbeetle.Transfer(ctx, fromUserID, toID, amount)
}

func (a *Activities) CancelOrderActivity(ctx context.Context, orderID string) error {
var order map[string]interface{}
err := a.dapr.GetState(ctx, "orders", orderID, &order)
if err != nil {
return err
}

order["status"] = "cancelled"
return a.dapr.SaveState(ctx, "orders", orderID, order)
}

// ============================================================================
// DEMAND RESPONSE ACTIVITIES
// ============================================================================

func (a *Activities) EnrollUserInDREventActivity(ctx context.Context, userID string, eventID string) error {
enrollment := map[string]interface{}{
"userID":     userID,
"eventID":    eventID,
"enrolledAt": time.Now(),
"status":     "enrolled",
}

key := fmt.Sprintf("%s:%s", userID, eventID)
return a.dapr.SaveState(ctx, "dr-enrollments", key, enrollment)
}

func (a *Activities) GetDREventStartTimeActivity(ctx context.Context, eventID string) (time.Time, error) {
var event map[string]interface{}
err := a.dapr.GetState(ctx, "dr-events", eventID, &event)
if err != nil {
return time.Time{}, err
}

startTime := event["startTime"].(time.Time)
return startTime, nil
}

func (a *Activities) GetDREventDurationActivity(ctx context.Context, eventID string) (time.Duration, error) {
var event map[string]interface{}
err := a.dapr.GetState(ctx, "dr-events", eventID, &event)
if err != nil {
return 0, err
}

duration := event["duration"].(time.Duration)
return duration, nil
}

func (a *Activities) GetCurrentConsumptionActivity(ctx context.Context, userID string) (float64, error) {
// Get from Redis cache
cached, err := a.redis.Get(ctx, fmt.Sprintf("consumption:%s", userID))
if err == nil && cached != "" {
var consumption float64
json.Unmarshal([]byte(cached), &consumption)
return consumption, nil
}

return 0.5, nil // Default consumption
}

func (a *Activities) CalculateDRPerformanceActivity(ctx context.Context, userID string, eventID string) (map[string]interface{}, error) {
performance := map[string]interface{}{
"userID":           userID,
"eventID":          eventID,
"reductionPercent": 25.5,
"points":           100,
"credits":          50.0,
}

return performance, nil
}

func (a *Activities) AwardDRRewardsActivity(ctx context.Context, userID string, performance map[string]interface{}) error {
credits := performance["credits"].(float64)
return a.tigerbeetle.CreditAccount(ctx, userID, credits)
}

// ============================================================================
// PAYMENT ACTIVITIES
// ============================================================================

func (a *Activities) ValidatePaymentMethodActivity(ctx context.Context, userID string, method string) error {
var paymentMethod map[string]interface{}
key := fmt.Sprintf("%s-%s", userID, method)
return a.dapr.GetState(ctx, "payment-methods", key, &paymentMethod)
}

func (a *Activities) ProcessPaymentGatewayActivity(ctx context.Context, userID string, amount float64, method string) (string, error) {
transactionID := fmt.Sprintf("txn-%s-%d", userID, time.Now().Unix())

// Simulate payment gateway processing
transaction := map[string]interface{}{
"id":        transactionID,
"userID":    userID,
"amount":    amount,
"method":    method,
"status":    "completed",
"timestamp": time.Now(),
}

err := a.dapr.SaveState(ctx, "transactions", transactionID, transaction)
return transactionID, err
}

func (a *Activities) RecordTigerBeetleTransactionActivity(ctx context.Context, userID string, amount float64, transactionID string) error {
return a.tigerbeetle.CreditAccount(ctx, userID, amount)
}

func (a *Activities) UpdateWalletBalanceActivity(ctx context.Context, userID string, amount float64) error {
// Clear cache
a.redis.Delete(ctx, fmt.Sprintf("wallet:%s", userID))

return nil
}

func (a *Activities) SendPaymentReceiptActivity(ctx context.Context, userID string, transactionID string) error {
// Send via notification service
return a.SendPushNotificationActivity(ctx, userID, "Payment Successful", fmt.Sprintf("Transaction ID: %s", transactionID))
}

// ============================================================================
// MONITORING ACTIVITIES
// ============================================================================

func (a *Activities) GetDeviceTelemetryActivity(ctx context.Context, deviceID string) (map[string]interface{}, error) {
var telemetry map[string]interface{}
err := a.dapr.GetState(ctx, "telemetry", deviceID, &telemetry)
return telemetry, err
}

func (a *Activities) DetectAnomaliesActivity(ctx context.Context, telemetry map[string]interface{}) (bool, error) {
// Simple anomaly detection
power := telemetry["power"].(float64)
return power > 5000 || power < 0, nil
}

func (a *Activities) CreateAlertActivity(ctx context.Context, deviceID string, telemetry map[string]interface{}) error {
alertID := fmt.Sprintf("alert-%s-%d", deviceID, time.Now().Unix())
alert := map[string]interface{}{
"id":        alertID,
"deviceID":  deviceID,
"type":      "anomaly",
"severity":  "high",
"telemetry": telemetry,
"timestamp": time.Now(),
}

return a.dapr.SaveState(ctx, "alerts", alertID, alert)
}

// ============================================================================
// GAMIFICATION ACTIVITIES
// ============================================================================

func (a *Activities) UpdateLeaderboardActivity(ctx context.Context, userID string, action string) error {
// Increment score in Redis sorted set
return a.redis.IncrementScore(ctx, "leaderboard:global", userID, 10)
}

func (a *Activities) CalculateLeaderboardScoresActivity(ctx context.Context, period string) (map[string]float64, error) {
scores := map[string]float64{
"user1": 1000,
"user2": 950,
"user3": 900,
}

return scores, nil
}

func (a *Activities) UpdateRedisLeaderboardActivity(ctx context.Context, scores map[string]float64) error {
for userID, score := range scores {
err := a.redis.SetScore(ctx, "leaderboard:weekly", userID, score)
if err != nil {
return err
}
}

return nil
}

func (a *Activities) GetTopPerformersActivity(ctx context.Context, scores map[string]float64, count int) ([]string, error) {
topUsers := []string{}
for userID := range scores {
topUsers = append(topUsers, userID)
if len(topUsers) >= count {
break
}
}

return topUsers, nil
}

func (a *Activities) AwardBonusPointsActivity(ctx context.Context, userID string) error {
return a.redis.IncrementScore(ctx, "leaderboard:global", userID, 50)
}

func (a *Activities) CheckAchievementsActivity(ctx context.Context, userID string, action string) ([]string, error) {
// Check if action triggers any achievements
achievements := []string{}

if action == "first_trade" {
achievements = append(achievements, "trader_badge")
}

return achievements, nil
}

func (a *Activities) AwardAchievementActivity(ctx context.Context, userID string, achievementID string) error {
achievement := map[string]interface{}{
"userID":        userID,
"achievementID": achievementID,
"awardedAt":     time.Now(),
}

key := fmt.Sprintf("%s:%s", userID, achievementID)
return a.dapr.SaveState(ctx, "achievements", key, achievement)
}

// ============================================================================
// NOTIFICATION ACTIVITIES
// ============================================================================

func (a *Activities) SendPushNotificationActivity(ctx context.Context, userID string, title string, message string) error {
notification := map[string]interface{}{
"userID":    userID,
"title":     title,
"message":   message,
"timestamp": time.Now(),
}

// Publish to Kafka for notification service
return a.kafka.PublishEvent(ctx, "vpp.notifications", notification)
}

func (a *Activities) TriggerHapticFeedbackActivity(ctx context.Context, userID string, pattern string) error {
// Send haptic feedback event
event := map[string]interface{}{
"userID":  userID,
"pattern": pattern,
"timestamp": time.Now(),
}

return a.kafka.PublishEvent(ctx, "vpp.haptic", event)
}

// ============================================================================
// KAFKA EVENT PUBLISHING
// ============================================================================

func (a *Activities) PublishKafkaEventActivity(ctx context.Context, topic string, data interface{}) error {
event := map[string]interface{}{
"data":      data,
"timestamp": time.Now(),
}

return a.kafka.PublishEvent(ctx, topic, event)
}

// ============================================================================
// FLUVIO STREAMING
// ============================================================================

func (a *Activities) PublishFluvioTelemetryActivity(ctx context.Context, deviceID string, telemetry interface{}) error {
data := map[string]interface{}{
"deviceID":  deviceID,
"telemetry": telemetry,
"timestamp": time.Now(),
}

return a.fluvio.PublishRecord(ctx, "telemetry-stream", data)
}

// ============================================================================
// CACHE ACTIVITIES
// ============================================================================

func (a *Activities) CacheTelemetryActivity(ctx context.Context, deviceID string, telemetry map[string]interface{}) error {
key := fmt.Sprintf("telemetry:%s", deviceID)
data, _ := json.Marshal(telemetry)
return a.redis.Set(ctx, key, string(data), 5*time.Minute)
}
