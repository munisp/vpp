package activities

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"sort"
	"strconv"
	"time"

	"go.temporal.io/sdk/temporal"

	"github.com/vpp-platform/orchestrator/services"
)

// errLedgerNotConfigured is returned by every activity that would move money
// through the TigerBeetle ledger. The TigerBeetle service was removed during
// mockware remediation (see services/services.go) because its account mapping
// could not be implemented without inventing unsafe behavior. Money movement
// is therefore disabled until a reviewed integration lands.
var errLedgerNotConfigured = errors.New("TigerBeetle ledger integration not configured: money movement is disabled")

// Activities struct holds all activity implementations.
type Activities struct {
	kafka *services.KafkaService
	redis *services.RedisService
	dapr  *services.DaprService
	db    *services.DBService
}

// NewActivities creates a new Activities instance.
func NewActivities(
	kafka *services.KafkaService,
	redis *services.RedisService,
	dapr *services.DaprService,
	db *services.DBService,
) *Activities {
	return &Activities{
		kafka: kafka,
		redis: redis,
		dapr:  dapr,
		db:    db,
	}
}

// parseUserID converts the orchestrator's string user ID to the numeric
// userId used by the PostgreSQL schema (drizzle/schema.ts). It fails loudly for
// non-numeric IDs rather than guessing a mapping.
func parseUserID(userID string) (int64, error) {
	id, err := strconv.ParseInt(userID, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("user ID %q is not a numeric platform user ID: %w", userID, err)
	}
	return id, nil
}

// parseEventTime accepts a time.Time or an RFC3339 string (JSON round trip).
func parseEventTime(v interface{}) (time.Time, error) {
	switch t := v.(type) {
	case time.Time:
		return t, nil
	case string:
		parsed, err := time.Parse(time.RFC3339, t)
		if err != nil {
			return time.Time{}, fmt.Errorf("unparseable event time %q: %w", t, err)
		}
		return parsed, nil
	default:
		return time.Time{}, fmt.Errorf("unsupported event time type %T", v)
	}
}

// parseEventDuration accepts a time.Duration, a JSON number (nanoseconds),
// or a Go duration string.
func parseEventDuration(v interface{}) (time.Duration, error) {
	switch d := v.(type) {
	case time.Duration:
		return d, nil
	case float64:
		return time.Duration(d), nil
	case string:
		parsed, err := time.ParseDuration(d)
		if err != nil {
			return 0, fmt.Errorf("unparseable event duration %q: %w", d, err)
		}
		return parsed, nil
	default:
		return 0, fmt.Errorf("unsupported event duration type %T", v)
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
	conditions, ok := strategy["conditions"].(map[string]interface{})
	if !ok {
		return false, fmt.Errorf("strategy %v has no valid conditions block", strategy["id"])
	}

	// Check price conditions
	if minExportPrice, ok := conditions["minExportPrice"].(float64); ok {
		exportPrice, ok := marketData["exportPrice"].(float64)
		if !ok {
			return false, errors.New("market data missing exportPrice")
		}
		if exportPrice < minExportPrice {
			return false, nil
		}
	}

	if maxImportPrice, ok := conditions["maxImportPrice"].(float64); ok {
		importPrice, ok := marketData["importPrice"].(float64)
		if !ok {
			return false, errors.New("market data missing importPrice")
		}
		if importPrice > maxImportPrice {
			return false, nil
		}
	}

	// Check battery conditions
	if minBatterySOC, ok := conditions["minBatterySOC"].(float64); ok {
		soc, ok := marketData["batterySOC"].(float64)
		if !ok {
			return false, errors.New("market data missing batterySOC")
		}
		if soc < minBatterySOC {
			return false, nil
		}
	}

	if maxBatterySOC, ok := conditions["maxBatterySOC"].(float64); ok {
		soc, ok := marketData["batterySOC"].(float64)
		if !ok {
			return false, errors.New("market data missing batterySOC")
		}
		if soc > maxBatterySOC {
			return false, nil
		}
	}

	// Check time window
	if startHour, ok := conditions["startHour"].(float64); ok {
		endHour, ok := conditions["endHour"].(float64)
		if !ok {
			return false, errors.New("strategy conditions set startHour without endHour")
		}
		currentHour := time.Now().Hour()
		if float64(currentHour) < startHour || float64(currentHour) > endHour {
			return false, nil
		}
	}

	// Check energy limits
	if minTradeSize, ok := conditions["minTradeSize"].(float64); ok {
		available, ok := marketData["availableEnergy"].(float64)
		if !ok {
			return false, errors.New("market data missing availableEnergy")
		}
		if available < minTradeSize {
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
		strategy["totalTrades"] = 0.0
	}
	strategy["totalTrades"] = strategy["totalTrades"].(float64) + 1

	if success, ok := tradeResult["success"].(bool); ok && success {
		if strategy["successfulTrades"] == nil {
			strategy["successfulTrades"] = 0.0
		}
		strategy["successfulTrades"] = strategy["successfulTrades"].(float64) + 1

		if strategy["totalProfit"] == nil {
			strategy["totalProfit"] = 0.0
		}
		if profit, ok := tradeResult["profit"].(float64); ok {
			strategy["totalProfit"] = strategy["totalProfit"].(float64) + profit
		}
	}

	if strategy["totalEnergyTraded"] == nil {
		strategy["totalEnergyTraded"] = 0.0
	}
	if energy, ok := tradeResult["energyAmount"].(float64); ok {
		strategy["totalEnergyTraded"] = strategy["totalEnergyTraded"].(float64) + energy
	}

	strategy["lastExecutedAt"] = time.Now()

	return a.dapr.SaveState(ctx, "trading-strategies", strategyID, strategy)
}

func (a *Activities) GetEnergySurplusActivity(ctx context.Context, assetID string) (float64, error) {
	// Get from Redis cache first
	cached, err := a.redis.Get(ctx, fmt.Sprintf("surplus:%s", assetID))
	if err == nil && cached != "" {
		var surplus float64
		if err := json.Unmarshal([]byte(cached), &surplus); err == nil {
			return surplus, nil
		}
	}

	// Fallback to state store
	var telemetry map[string]interface{}
	err = a.dapr.GetState(ctx, "telemetry", assetID, &telemetry)
	if err != nil {
		return 0, err
	}

	surplus, ok := telemetry["surplus"].(float64)
	if !ok {
		return 0, fmt.Errorf("telemetry for asset %s has no numeric surplus reading", assetID)
	}

	// Cache for 1 minute
	a.redis.Set(ctx, fmt.Sprintf("surplus:%s", assetID), fmt.Sprintf("%f", surplus), 60*time.Second)

	return surplus, nil
}

// GetMarketPriceActivity returns the current market price in currency per
// kWh. On a cache miss it reads the latest still-valid row from the real
// marketPrices table (schema stores integer cents per kWh). If no price is
// available it returns an error: trading must never run on a made-up price.
func (a *Activities) GetMarketPriceActivity(ctx context.Context) (float64, error) {
	// Get from Redis cache
	cached, err := a.redis.Get(ctx, "market:price:current")
	if err == nil && cached != "" {
		var price float64
		if err := json.Unmarshal([]byte(cached), &price); err == nil {
			return price, nil
		}
	}

	row, err := a.db.QueryRowContext(ctx, `
		SELECT price FROM "marketPrices"
		WHERE "validUntil" > NOW()
		ORDER BY "timestamp" DESC
		LIMIT 1`)
	if err != nil {
		return 0, fmt.Errorf("market price unavailable: %w", err)
	}
	var priceCents int64
	if err := row.Scan(&priceCents); err != nil {
		return 0, fmt.Errorf("market price unavailable: %w", err)
	}

	price := float64(priceCents) / 100.0
	a.redis.Set(ctx, "market:price:current", fmt.Sprintf("%f", price), 60*time.Second)
	return price, nil
}

// GetBatteryStateOfChargeActivity returns the latest battery state of charge
// (in percent) for an asset from the real telemetry table. The schema stores
// stateOfCharge as percent * 100. Unavailable telemetry is an error: callers
// must skip trading rather than assume a value.
func (a *Activities) GetBatteryStateOfChargeActivity(ctx context.Context, assetID string) (float64, error) {
	id, err := strconv.ParseInt(assetID, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("asset ID %q is not a numeric platform asset ID: %w", assetID, err)
	}

	row, err := a.db.QueryRowContext(ctx, `
		SELECT "stateOfCharge" FROM telemetry
		WHERE "assetId" = $1 AND "stateOfCharge" IS NOT NULL
		ORDER BY "timestamp" DESC
		LIMIT 1`, id)
	if err != nil {
		return 0, fmt.Errorf("battery state of charge unavailable for asset %s: %w", assetID, err)
	}
	var soc int64
	if err := row.Scan(&soc); err != nil {
		return 0, fmt.Errorf("battery state of charge unavailable for asset %s: %w", assetID, err)
	}
	return float64(soc) / 100.0, nil
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

// GetWalletBalanceActivity queries the user's ledger balance.
// The TigerBeetle ledger integration was removed during mockware remediation,
// so this fails loudly instead of returning a fabricated balance.
func (a *Activities) GetWalletBalanceActivity(ctx context.Context, userID string) (float64, error) {
	return 0, errLedgerNotConfigured
}

// FindBestOfferActivity queries the real P2P order book (trades table) for
// the cheapest pending p2p_sell offer that covers the requested amount and
// respects the buyer's maximum price.
//
// Unit conventions (drizzle/schema.ts): trades.energy is watt-hours,
// trades.price is integer cents per kWh. The workflow-facing API uses kWh
// and currency per kWh, so values are converted on the way in and out.
//
// If no offer matches, a typed NO_OFFER_FOUND application error is returned.
// An offer is never invented.
func (a *Activities) FindBestOfferActivity(ctx context.Context, amount float64, maxPrice float64) (map[string]interface{}, error) {
	minWattHours := int64(amount * 1000.0)
	maxPriceCents := int64(maxPrice * 100.0)

	row, err := a.db.QueryRowContext(ctx, `
		SELECT id, "userId", energy, price FROM trades
		WHERE "tradeType" = 'p2p_sell'
		  AND status = 'pending'
		  AND energy >= $1
		  AND price <= $2
		ORDER BY price ASC, "timestamp" ASC
		LIMIT 1`, minWattHours, maxPriceCents)
	if err != nil {
		return nil, fmt.Errorf("failed to query the order book: %w", err)
	}

	var tradeID, sellerID, energyWh, priceCents int64
	if err := row.Scan(&tradeID, &sellerID, &energyWh, &priceCents); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, temporal.NewApplicationError(
				fmt.Sprintf("no pending sell offer covers %.3f kWh at or below %.4f/kWh", amount, maxPrice),
				"NO_OFFER_FOUND")
		}
		return nil, fmt.Errorf("failed to read the order book: %w", err)
	}

	return map[string]interface{}{
		"id":       strconv.FormatInt(tradeID, 10),
		"sellerID": strconv.FormatInt(sellerID, 10),
		"amount":   float64(energyWh) / 1000.0, // kWh
		"price":    float64(priceCents) / 100.0,
	}, nil
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

// ProcessTigerBeetleTransferActivity moves funds between two ledger accounts.
// The TigerBeetle ledger integration was removed during mockware remediation,
// so this fails loudly: transfers are never simulated.
func (a *Activities) ProcessTigerBeetleTransferActivity(ctx context.Context, fromUserID string, toUserID interface{}, amount float64) error {
	return fmt.Errorf("transfer of %.2f from %s to %v refused: %w", amount, fromUserID, toUserID, errLedgerNotConfigured)
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
	if err := a.dapr.GetState(ctx, "dr-events", eventID, &event); err != nil {
		return time.Time{}, err
	}

	return parseEventTime(event["startTime"])
}

func (a *Activities) GetDREventDurationActivity(ctx context.Context, eventID string) (time.Duration, error) {
	var event map[string]interface{}
	if err := a.dapr.GetState(ctx, "dr-events", eventID, &event); err != nil {
		return 0, err
	}

	return parseEventDuration(event["duration"])
}

// GetCurrentConsumptionActivity returns the user's current average
// consumption in kW, computed from the real telemetry of the user's assets
// over the last 5 minutes. On a cache miss with no telemetry available it
// returns an error: DR logic must never run on a made-up consumption value.
func (a *Activities) GetCurrentConsumptionActivity(ctx context.Context, userID string) (float64, error) {
	// Get from Redis cache
	cached, err := a.redis.Get(ctx, fmt.Sprintf("consumption:%s", userID))
	if err == nil && cached != "" {
		var consumption float64
		if err := json.Unmarshal([]byte(cached), &consumption); err == nil {
			return consumption, nil
		}
	}

	uid, err := parseUserID(userID)
	if err != nil {
		return 0, err
	}

	row, err := a.db.QueryRowContext(ctx, `
		SELECT AVG(t.power)
		FROM telemetry t
		JOIN assets a ON a.id = t."assetId"
		WHERE a."userId" = $1
		  AND t.timestamp >= NOW() - INTERVAL '5 minutes'`, uid)
	if err != nil {
		return 0, fmt.Errorf("consumption telemetry unavailable for user %s: %w", userID, err)
	}
	var avgWatts sql.NullFloat64
	if err := row.Scan(&avgWatts); err != nil {
		return 0, fmt.Errorf("consumption telemetry unavailable for user %s: %w", userID, err)
	}
	if !avgWatts.Valid {
		return 0, fmt.Errorf("no recent telemetry for user %s; consumption unknown", userID)
	}

	consumptionKW := avgWatts.Float64 / 1000.0
	a.redis.Set(ctx, fmt.Sprintf("consumption:%s", userID), fmt.Sprintf("%f", consumptionKW), 60*time.Second)
	return consumptionKW, nil
}

// CalculateDRPerformanceActivity computes the participant's real demand
// reduction for a DR event from telemetry: average power of the user's
// assets during the event window versus the baseline window of equal length
// immediately before the event.
//
// Points are derived from the measured reduction percentage; credits are the
// measured energy reduction (kWh) priced at the real current market price.
// If telemetry or market price data is unavailable the activity errors out
// and AwardDRRewardsActivity never runs: rewards are never fabricated.
func (a *Activities) CalculateDRPerformanceActivity(ctx context.Context, userID string, eventID string) (map[string]interface{}, error) {
	uid, err := parseUserID(userID)
	if err != nil {
		return nil, err
	}

	// Resolve the real event window.
	var event map[string]interface{}
	if err := a.dapr.GetState(ctx, "dr-events", eventID, &event); err != nil {
		return nil, fmt.Errorf("cannot compute DR performance without the event window: %w", err)
	}
	start, err := parseEventTime(event["startTime"])
	if err != nil {
		return nil, fmt.Errorf("cannot compute DR performance: %w", err)
	}
	duration, err := parseEventDuration(event["duration"])
	if err != nil {
		return nil, fmt.Errorf("cannot compute DR performance: %w", err)
	}
	if duration <= 0 {
		return nil, fmt.Errorf("cannot compute DR performance: event %s has a non-positive duration", eventID)
	}
	end := start.Add(duration)

	avgPower := func(from, to time.Time) (float64, error) {
		row, err := a.db.QueryRowContext(ctx, `
			SELECT AVG(t.power)
			FROM telemetry t
			JOIN assets a ON a.id = t."assetId"
			WHERE a."userId" = $1
			  AND t.timestamp >= $2 AND t.timestamp < $3`, uid, from, to)
		if err != nil {
			return 0, err
		}
		var avg sql.NullFloat64
		if err := row.Scan(&avg); err != nil {
			return 0, err
		}
		if !avg.Valid {
			return 0, fmt.Errorf("no telemetry rows for user %s between %s and %s",
				userID, from.Format(time.RFC3339), to.Format(time.RFC3339))
		}
		return avg.Float64, nil
	}

	baseline, err := avgPower(start.Add(-duration), start)
	if err != nil {
		return nil, fmt.Errorf("baseline telemetry unavailable: %w", err)
	}
	actual, err := avgPower(start, end)
	if err != nil {
		return nil, fmt.Errorf("event-window telemetry unavailable: %w", err)
	}
	if baseline <= 0 {
		return nil, fmt.Errorf("baseline consumption for user %s is zero; reduction cannot be computed", userID)
	}

	reductionPercent := (baseline - actual) / baseline * 100.0
	points := 0
	credits := 0.0
	if reductionPercent > 0 {
		points = int(reductionPercent)

		energyReducedKWh := (baseline - actual) * duration.Hours() / 1000.0

		// Price the measured reduction at the real current market price.
		row, err := a.db.QueryRowContext(ctx, `
			SELECT price FROM "marketPrices"
			WHERE "validUntil" > NOW()
			ORDER BY "timestamp" DESC
			LIMIT 1`)
		if err != nil {
			return nil, fmt.Errorf("market price unavailable; refusing to fabricate DR credits: %w", err)
		}
		var priceCents int64
		if err := row.Scan(&priceCents); err != nil {
			return nil, fmt.Errorf("market price unavailable; refusing to fabricate DR credits: %w", err)
		}
		credits = energyReducedKWh * float64(priceCents) / 100.0
	}

	return map[string]interface{}{
		"userID":           userID,
		"eventID":          eventID,
		"baselineWatts":    baseline,
		"actualWatts":      actual,
		"reductionPercent": reductionPercent,
		"points":           points,
		"credits":          credits,
	}, nil
}

// AwardDRRewardsActivity credits the earned DR rewards to the user's ledger
// account. The TigerBeetle ledger integration was removed during mockware
// remediation, so this fails loudly: credits are never simulated.
func (a *Activities) AwardDRRewardsActivity(ctx context.Context, userID string, performance map[string]interface{}) error {
	return fmt.Errorf("cannot award DR rewards to user %s: %w", userID, errLedgerNotConfigured)
}

// ============================================================================
// PAYMENT ACTIVITIES
// ============================================================================

func (a *Activities) ValidatePaymentMethodActivity(ctx context.Context, userID string, method string) error {
	var paymentMethod map[string]interface{}
	key := fmt.Sprintf("%s-%s", userID, method)
	return a.dapr.GetState(ctx, "payment-methods", key, &paymentMethod)
}

// ProcessPaymentGatewayActivity charges the user through a real payment
// gateway. The gateway endpoint must be configured via the PAYMENT_GATEWAY_URL
// and PAYMENT_GATEWAY_API_KEY environment variables; without them the
// activity fails loudly. A transaction is only persisted as "completed" when
// the gateway confirms the charge — a completed transaction is never minted
// locally.
func (a *Activities) ProcessPaymentGatewayActivity(ctx context.Context, userID string, amount float64, method string) (string, error) {
	gatewayURL := os.Getenv("PAYMENT_GATEWAY_URL")
	apiKey := os.Getenv("PAYMENT_GATEWAY_API_KEY")
	if gatewayURL == "" || apiKey == "" {
		return "", errors.New("payment gateway integration not configured: set PAYMENT_GATEWAY_URL and PAYMENT_GATEWAY_API_KEY")
	}

	payload, err := json.Marshal(map[string]interface{}{
		"userID": userID,
		"amount": amount,
		"method": method,
	})
	if err != nil {
		return "", err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, gatewayURL, bytes.NewReader(payload))
	if err != nil {
		return "", fmt.Errorf("invalid payment gateway URL: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)

	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		return "", fmt.Errorf("payment gateway charge failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("payment gateway rejected the charge with HTTP %d", resp.StatusCode)
	}

	var gatewayResp struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&gatewayResp); err != nil {
		return "", fmt.Errorf("unparseable payment gateway response: %w", err)
	}
	if gatewayResp.ID == "" || (gatewayResp.Status != "completed" && gatewayResp.Status != "succeeded") {
		return "", fmt.Errorf("payment gateway did not confirm the charge (id=%q status=%q)", gatewayResp.ID, gatewayResp.Status)
	}

	// Only now is it safe to persist a completed transaction.
	transaction := map[string]interface{}{
		"id":        gatewayResp.ID,
		"userID":    userID,
		"amount":    amount,
		"method":    method,
		"status":    "completed",
		"timestamp": time.Now().UTC(),
	}
	if err := a.dapr.SaveState(ctx, "transactions", gatewayResp.ID, transaction); err != nil {
		return "", fmt.Errorf("charge %s confirmed by gateway but failed to persist: %w", gatewayResp.ID, err)
	}

	return gatewayResp.ID, nil
}

// RecordTigerBeetleTransactionActivity records a confirmed payment in the
// ledger. The TigerBeetle ledger integration was removed during mockware
// remediation, so this fails loudly: the workflow's refund compensation runs
// and no balance is ever credited without a real ledger posting.
func (a *Activities) RecordTigerBeetleTransactionActivity(ctx context.Context, userID string, amount float64, transactionID string) error {
	return fmt.Errorf("cannot record transaction %s for user %s: %w", transactionID, userID, errLedgerNotConfigured)
}

// UpdateWalletBalanceActivity previously deleted a Redis key and reported
// success — a silent no-op on a money path. A real implementation requires
// the (removed) ledger integration to read the authoritative balance and
// refresh the cache, so this now fails loudly instead.
func (a *Activities) UpdateWalletBalanceActivity(ctx context.Context, userID string, amount float64) error {
	return fmt.Errorf("wallet balance update not implemented for user %s: %w", userID, errLedgerNotConfigured)
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
	power, ok := telemetry["power"].(float64)
	if !ok {
		return false, errors.New("telemetry has no numeric power reading")
	}
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

// CalculateLeaderboardScoresActivity aggregates real scores from executed
// trades: each user's score is the sum of totalAmount (cents) over their
// executed trades in the requested period ("daily", "weekly", "monthly";
// anything else, e.g. "all_time", aggregates everything). An empty dataset
// yields an empty leaderboard — names are never fabricated.
func (a *Activities) CalculateLeaderboardScoresActivity(ctx context.Context, period string) (map[string]float64, error) {
	query := `SELECT "userId", COALESCE(SUM("totalAmount"), 0) FROM trades WHERE status = 'executed'`
	var args []interface{}
	if since, bounded := periodStart(period); bounded {
		query += ` AND "timestamp" >= $1`
		args = append(args, since)
	}
	query += ` GROUP BY "userId"`

	rows, err := a.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to aggregate leaderboard scores: %w", err)
	}
	defer rows.Close()

	scores := map[string]float64{}
	for rows.Next() {
		var userID int64
		var score float64
		if err := rows.Scan(&userID, &score); err != nil {
			return nil, fmt.Errorf("failed to read leaderboard row: %w", err)
		}
		scores[strconv.FormatInt(userID, 10)] = score
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed to aggregate leaderboard scores: %w", err)
	}
	return scores, nil
}

// periodStart maps a leaderboard period to its lower time bound.
func periodStart(period string) (time.Time, bool) {
	var d time.Duration
	switch period {
	case "daily":
		d = 24 * time.Hour
	case "weekly":
		d = 7 * 24 * time.Hour
	case "monthly":
		d = 30 * 24 * time.Hour
	default: // "all_time" and unknown periods aggregate everything
		return time.Time{}, false
	}
	return time.Now().Add(-d), true
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

// GetTopPerformersActivity sorts users by score descending and returns the
// top count user IDs.
func (a *Activities) GetTopPerformersActivity(ctx context.Context, scores map[string]float64, count int) ([]string, error) {
	type entry struct {
		userID string
		score  float64
	}
	entries := make([]entry, 0, len(scores))
	for userID, score := range scores {
		entries = append(entries, entry{userID: userID, score: score})
	}
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].score > entries[j].score
	})

	if count > len(entries) {
		count = len(entries)
	}
	top := make([]string, 0, count)
	for i := 0; i < count; i++ {
		top = append(top, entries[i].userID)
	}
	return top, nil
}

func (a *Activities) AwardBonusPointsActivity(ctx context.Context, userID string) error {
	return a.redis.IncrementScore(ctx, "leaderboard:global", userID, 50)
}

// CheckAchievementsActivity evaluates the real achievements table against the
// user's recorded metrics. Metrics come from the user's latest all-time
// leaderboard_entries row (eventsParticipated, totalReduction,
// reliabilityScore, compensationEarned); achievements already present in
// user_achievements are excluded. If the user has no recorded metrics yet,
// an empty list is returned honestly. The "consecutive_events" criterion is
// not evaluated because no table tracks it.
func (a *Activities) CheckAchievementsActivity(ctx context.Context, userID string, action string) ([]string, error) {
	uid, err := parseUserID(userID)
	if err != nil {
		return nil, err
	}

	row, err := a.db.QueryRowContext(ctx, `
		SELECT events_participated, total_reduction, reliability_score, compensation_earned
		FROM leaderboard_entries
		WHERE user_id = $1 AND period = 'all_time'
		ORDER BY period_end DESC
		LIMIT 1`, uid)
	if err != nil {
		return nil, fmt.Errorf("failed to load achievement metrics: %w", err)
	}
	var eventsParticipated, totalReduction, reliabilityScore, compensationEarned int64
	if err := row.Scan(&eventsParticipated, &totalReduction, &reliabilityScore, &compensationEarned); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			// No metrics recorded yet: honestly nothing can be unlocked.
			return []string{}, nil
		}
		return nil, fmt.Errorf("failed to load achievement metrics: %w", err)
	}
	metrics := map[string]int64{
		"events_participated": eventsParticipated,
		"total_reduction":     totalReduction,
		"reliability_score":   reliabilityScore,
		"compensation_earned": compensationEarned,
	}

	rows, err := a.db.QueryContext(ctx, `
		SELECT name, criteria_type, criteria_value FROM achievements WHERE is_active = true`)
	if err != nil {
		return nil, fmt.Errorf("failed to load achievements: %w", err)
	}
	defer rows.Close()

	var eligible []string
	for rows.Next() {
		var name, criteriaType string
		var criteriaValue int64
		if err := rows.Scan(&name, &criteriaType, &criteriaValue); err != nil {
			return nil, fmt.Errorf("failed to read achievements: %w", err)
		}
		if metric, ok := metrics[criteriaType]; ok && metric >= criteriaValue {
			eligible = append(eligible, name)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed to load achievements: %w", err)
	}
	if len(eligible) == 0 {
		return []string{}, nil
	}

	awardedRows, err := a.db.QueryContext(ctx, `
		SELECT a.name FROM user_achievements ua
		JOIN achievements a ON a.id = ua.achievement_id
		WHERE ua.user_id = $1`, uid)
	if err != nil {
		return nil, fmt.Errorf("failed to load awarded achievements: %w", err)
	}
	defer awardedRows.Close()

	awarded := map[string]bool{}
	for awardedRows.Next() {
		var name string
		if err := awardedRows.Scan(&name); err != nil {
			return nil, fmt.Errorf("failed to read awarded achievements: %w", err)
		}
		awarded[name] = true
	}
	if err := awardedRows.Err(); err != nil {
		return nil, fmt.Errorf("failed to load awarded achievements: %w", err)
	}

	unlocked := []string{}
	for _, name := range eligible {
		if !awarded[name] {
			unlocked = append(unlocked, name)
		}
	}
	return unlocked, nil
}

// AwardAchievementActivity records the achievement in the real
// user_achievements table. achievementID is the achievement name returned by
// CheckAchievementsActivity.
func (a *Activities) AwardAchievementActivity(ctx context.Context, userID string, achievementID string) error {
	uid, err := parseUserID(userID)
	if err != nil {
		return err
	}

	row, err := a.db.QueryRowContext(ctx, `SELECT id FROM achievements WHERE name = $1`, achievementID)
	if err != nil {
		return fmt.Errorf("failed to resolve achievement %q: %w", achievementID, err)
	}
	var id int64
	if err := row.Scan(&id); err != nil {
		return fmt.Errorf("unknown achievement %q: %w", achievementID, err)
	}

	if _, err := a.db.ExecContext(ctx, `
		INSERT INTO user_achievements (user_id, achievement_id, unlocked_at)
		VALUES ($1, $2, NOW() AT TIME ZONE 'UTC')`, uid, id); err != nil {
		return fmt.Errorf("failed to record achievement %q for user %s: %w", achievementID, userID, err)
	}
	return nil
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
		"userID":    userID,
		"pattern":   pattern,
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

// PublishFluvioTelemetryActivity previously pretended to stream telemetry
// through a FluvioService that had no real client (and no Fluvio dependency
// exists in go.mod). It now fails loudly: telemetry is NOT published.
func (a *Activities) PublishFluvioTelemetryActivity(ctx context.Context, deviceID string, telemetry interface{}) error {
	return fmt.Errorf("fluvio streaming integration not configured: telemetry for device %s was NOT published", deviceID)
}

// ============================================================================
// CACHE ACTIVITIES
// ============================================================================

func (a *Activities) CacheTelemetryActivity(ctx context.Context, deviceID string, telemetry map[string]interface{}) error {
	key := fmt.Sprintf("telemetry:%s", deviceID)
	data, err := json.Marshal(telemetry)
	if err != nil {
		return err
	}
	return a.redis.Set(ctx, key, string(data), 5*time.Minute)
}
