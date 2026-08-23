package platform

import (
	"context"
	"errors"

	"github.com/vpp/grid-protocols/internal/ocpp201"
)

// The 2.0.1 endpoints are separate from the 1.6 ones rather than shared: the
// messages carry different identity (the station owns the transaction id) and a
// different meter-value shape, so folding them into one endpoint would force the
// server to guess which version it is reading.

func (c *Client) BootNotification201(ctx context.Context, stationID string, req ocpp201.BootNotificationRequest) (ocpp201.BootNotificationResponse, error) {
	var resp ocpp201.BootNotificationResponse
	err := c.post(ctx, "/api/grid/ocpp201/boot-notification",
		chargePointEnvelope[ocpp201.BootNotificationRequest]{stationID, req}, &resp)
	if err != nil {
		return ocpp201.BootNotificationResponse{}, err
	}
	if resp.Status == "" {
		return ocpp201.BootNotificationResponse{}, errors.New("platform: boot notification response has no registration status")
	}
	return resp, nil
}

func (c *Client) Heartbeat201(ctx context.Context, stationID string) error {
	return c.post(ctx, "/api/grid/ocpp201/heartbeat", map[string]string{"charge_point_id": stationID}, nil)
}

func (c *Client) StatusNotification201(ctx context.Context, stationID string, req ocpp201.StatusNotificationRequest) error {
	return c.post(ctx, "/api/grid/ocpp201/status-notification",
		chargePointEnvelope[ocpp201.StatusNotificationRequest]{stationID, req}, nil)
}

func (c *Client) MeterValues201(ctx context.Context, stationID string, req ocpp201.MeterValuesRequest) error {
	return c.post(ctx, "/api/grid/ocpp201/meter-values",
		chargePointEnvelope[ocpp201.MeterValuesRequest]{stationID, req}, nil)
}

func (c *Client) Authorize201(ctx context.Context, stationID string, req ocpp201.AuthorizeRequest) (ocpp201.AuthorizeResponse, error) {
	var resp ocpp201.AuthorizeResponse
	err := c.post(ctx, "/api/grid/ocpp201/authorize",
		chargePointEnvelope[ocpp201.AuthorizeRequest]{stationID, req}, &resp)
	if err != nil {
		return ocpp201.AuthorizeResponse{}, err
	}
	if resp.IDTokenInfo.Status == "" {
		return ocpp201.AuthorizeResponse{}, errors.New("platform: authorize response has no status")
	}
	return resp, nil
}

// TransactionEvent201 forwards the station's transaction event. The response is
// returned as the platform sent it: an absent idTokenInfo means the platform made
// no authorization decision, which the CSMS turns into a CALLERROR rather than an
// implied acceptance.
func (c *Client) TransactionEvent201(ctx context.Context, stationID string, req ocpp201.TransactionEventRequest) (ocpp201.TransactionEventResponse, error) {
	var resp ocpp201.TransactionEventResponse
	err := c.post(ctx, "/api/grid/ocpp201/transaction-event",
		chargePointEnvelope[ocpp201.TransactionEventRequest]{stationID, req}, &resp)
	if err != nil {
		return ocpp201.TransactionEventResponse{}, err
	}
	return resp, nil
}
