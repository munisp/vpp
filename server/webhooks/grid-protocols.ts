/**
 * Ingest endpoints for the grid protocol services.
 *
 * Callers are the Go service in services/grid-protocols (OCPP 1.6J, OpenADR
 * 2.0b, IEEE 2030.5) and the Rust poller in services/modbus-poller. Every
 * request is HMAC-signed with GRID_PROTOCOL_SHARED_SECRET; unsigned requests
 * are rejected before any handler runs.
 *
 * The OCPP routes take the `{charge_point_id, payload}` envelope the Go client
 * sends, with the OCPP 1.6 payload unchanged inside it.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  GridProtocolError,
  authorizeIdTag,
  handleBootNotification,
  handleHeartbeat,
  handleMeterValues,
  handleModbusReadings,
  handleOpenADREvent,
  handleSep2Controls,
  handleStartTransaction,
  handleStatusNotification,
  handleStopTransaction,
  verifyGridSignature,
} from '../services/grid-protocol-ingest';
import {
  authorizeIdToken201,
  handleBootNotification201,
  handleHeartbeat201,
  handleMeterValues201,
  handleStatusNotification201,
  handleTransactionEvent201,
} from '../services/ocpp201-ingest';

const chargePointId = z.string().min(1).max(64);

function envelope<T extends z.ZodTypeAny>(payload: T) {
  return z.object({ charge_point_id: chargePointId, payload });
}

const bootEnvelope = envelope(
  z.object({
    chargePointVendor: z.string().min(1),
    chargePointModel: z.string().min(1),
    chargePointSerialNumber: z.string().optional(),
    chargeBoxSerialNumber: z.string().optional(),
    firmwareVersion: z.string().optional(),
    iccid: z.string().optional(),
    imsi: z.string().optional(),
    meterType: z.string().optional(),
    meterSerialNumber: z.string().optional(),
  })
);

const heartbeatSchema = z.object({ charge_point_id: chargePointId });

const statusEnvelope = envelope(
  z.object({
    connectorId: z.number().int().min(0),
    errorCode: z.string().min(1),
    status: z.string().min(1),
    info: z.string().optional(),
    timestamp: z.string().optional(),
    vendorId: z.string().optional(),
    vendorErrorCode: z.string().optional(),
  })
);

const authorizeEnvelope = envelope(z.object({ idTag: z.string().min(1).max(64) }));

const startEnvelope = envelope(
  z.object({
    connectorId: z.number().int().min(1),
    idTag: z.string().min(1).max(64),
    meterStart: z.number().int(),
    reservationId: z.number().int().optional(),
    timestamp: z.string().min(1),
  })
);

const stopEnvelope = envelope(
  z.object({
    idTag: z.string().min(1).max(64).optional(),
    meterStop: z.number().int(),
    timestamp: z.string().min(1),
    transactionId: z.number().int().positive(),
    reason: z.string().optional(),
  })
);

const sampledValue = z.object({
  value: z.string().min(1),
  context: z.string().optional(),
  format: z.string().optional(),
  measurand: z.string().optional(),
  phase: z.string().optional(),
  location: z.string().optional(),
  unit: z.string().optional(),
});

const meterValuesEnvelope = envelope(
  z.object({
    connectorId: z.number().int().min(0),
    transactionId: z.number().int().positive().optional(),
    meterValue: z
      .array(
        z.object({
          timestamp: z.string().min(1),
          sampledValue: z.array(sampledValue).min(1),
        })
      )
      .min(1),
  })
);

// ---------------------------- OCPP 2.0.1 ----------------------------
// Separate schemas, not a widened 1.6 set: 2.0.1 payloads are a different
// message set, and accepting either shape on one route would let a malformed
// message from one version pass as the other.

const idToken201 = z.object({
  idToken: z.string().min(1).max(36),
  type: z.string().min(1).max(32),
});

const sampledValue201 = z.object({
  value: z.number(),
  context: z.string().optional(),
  measurand: z.string().optional(),
  phase: z.string().optional(),
  location: z.string().optional(),
  unitOfMeasure: z
    .object({ unit: z.string().optional(), multiplier: z.number().int().optional() })
    .optional(),
  signedMeterValue: z
    .object({
      signedMeterData: z.string().min(1),
      signingMethod: z.string().min(1),
      encodingMethod: z.string().min(1),
      publicKey: z.string().optional(),
    })
    .optional(),
});

const meterValue201 = z.object({
  timestamp: z.string().min(1),
  sampledValue: z.array(sampledValue201).min(1),
});

const boot201Envelope = envelope(
  z.object({
    reason: z.string().min(1).max(32),
    chargingStation: z.object({
      model: z.string().min(1).max(20),
      vendorName: z.string().min(1).max(50),
      serialNumber: z.string().max(25).optional(),
      firmwareVersion: z.string().max(50).optional(),
      modem: z.object({ iccid: z.string().optional(), imsi: z.string().optional() }).optional(),
    }),
  })
);

const status201Envelope = envelope(
  z.object({
    timestamp: z.string().min(1),
    // ConnectorStatusEnumType: 2.0.1's five statuses, not 1.6's nine.
    connectorStatus: z.enum(['Available', 'Occupied', 'Reserved', 'Unavailable', 'Faulted']),
    evseId: z.number().int().positive(),
    connectorId: z.number().int().positive(),
  })
);

const authorize201Envelope = envelope(z.object({ idToken: idToken201 }));

const meterValues201Envelope = envelope(
  z.object({
    evseId: z.number().int().min(0),
    meterValue: z.array(meterValue201).min(1),
  })
);

const transactionEvent201Envelope = envelope(
  z.object({
    eventType: z.enum(['Started', 'Updated', 'Ended']),
    timestamp: z.string().min(1),
    triggerReason: z.string().min(1).max(32),
    // Monotonic per transaction; a station replaying buffered events repeats
    // sequence numbers it already sent, which the handler must absorb.
    seqNo: z.number().int().min(0),
    offline: z.boolean().optional(),
    numberOfPhasesUsed: z.number().int().optional(),
    cableMaxCurrent: z.number().int().optional(),
    reservationId: z.number().int().optional(),
    transactionInfo: z.object({
      // Station-generated: the platform maps this id, it never issues one.
      transactionId: z.string().min(1).max(36),
      chargingState: z.string().max(32).optional(),
      timeSpentCharging: z.number().int().optional(),
      stoppedReason: z.string().max(32).optional(),
      remoteStartId: z.number().int().optional(),
    }),
    evse: z
      .object({ id: z.number().int().positive(), connectorId: z.number().int().positive().optional() })
      .optional(),
    idToken: idToken201.optional(),
    meterValue: z.array(meterValue201).optional(),
  })
);

const openADRSchema = z.object({
  eventId: z.string().min(1).max(128),
  modificationNumber: z.number().int().min(0),
  marketContext: z.string().max(191),
  status: z.string().min(1).max(32),
  priority: z.number().int().min(0),
  testEvent: z.boolean(),
  start: z.string().min(1),
  durationSeconds: z.number().int(),
  signals: z.array(
    z.object({
      name: z.string(),
      type: z.string(),
      intervals: z.array(
        z.object({
          start: z.string().min(1),
          durationSeconds: z.number().int(),
          value: z.number(),
        })
      ),
    })
  ),
});

const sep2Schema = z.object({
  controls: z.array(
    z.object({
      mrid: z.string().min(1).max(128),
      programMrid: z.string().max(191),
      status: z.number().int(),
      primacy: z.number().int(),
      start: z.string().min(1),
      durationSeconds: z.number().int(),
      targetWatts: z.number().optional(),
      maxLimitPercent: z.number().optional(),
      fixedPercent: z.number().optional(),
    })
  ),
});

const modbusSchema = z.object({
  source: z.literal('modbus'),
  readings: z
    .array(
      z.object({
        device_id: z.string().min(1).max(255),
        name: z.string().min(1),
        value: z.number(),
        unit: z.string().min(1),
        address: z.number().int().min(0),
        timestamp_ms: z.number().int(),
      })
    )
    .min(1),
});

function rawBody(req: Request): Buffer {
  const captured = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!captured) {
    // The body parser in server/_core/index.ts captures this; without it the
    // signature cannot be verified and the request must not be trusted.
    throw new GridProtocolError(500, 'raw request body unavailable for signature check');
  }
  return captured;
}

function authenticate(req: Request): void {
  verifyGridSignature(
    rawBody(req),
    typeof req.headers['x-grid-timestamp'] === 'string'
      ? req.headers['x-grid-timestamp']
      : undefined,
    typeof req.headers['x-grid-signature'] === 'string'
      ? req.headers['x-grid-signature']
      : undefined
  );
}

function handler<T>(
  schema: z.ZodType<T>,
  run: (input: T) => Promise<unknown>
): (req: Request, res: Response) => Promise<void> {
  return async (req, res) => {
    try {
      authenticate(req);
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'INVALID_REQUEST', message: parsed.error.message });
        return;
      }
      const result = await run(parsed.data);
      res.status(200).json(result ?? {});
    } catch (error) {
      if (error instanceof GridProtocolError) {
        res.status(error.status).json({ error: 'GRID_PROTOCOL', message: error.message });
        return;
      }
      console.error('[GridProtocols] request failed:', error);
      res.status(500).json({
        error: 'INTERNAL',
        message: error instanceof Error ? error.message : 'unexpected failure',
      });
    }
  };
}

export const gridProtocolRouter = Router();

gridProtocolRouter.post(
  '/ocpp/boot-notification',
  handler(bootEnvelope, input => handleBootNotification(input.charge_point_id, input.payload))
);
gridProtocolRouter.post(
  '/ocpp/heartbeat',
  handler(heartbeatSchema, input => handleHeartbeat(input.charge_point_id))
);
gridProtocolRouter.post(
  '/ocpp/status-notification',
  handler(statusEnvelope, async input => {
    await handleStatusNotification(input.charge_point_id, input.payload);
    return {};
  })
);
gridProtocolRouter.post(
  '/ocpp/authorize',
  handler(authorizeEnvelope, async input => ({
    idTagInfo: await authorizeIdTag(input.payload.idTag),
  }))
);
gridProtocolRouter.post(
  '/ocpp/start-transaction',
  handler(startEnvelope, input => handleStartTransaction(input.charge_point_id, input.payload))
);
gridProtocolRouter.post(
  '/ocpp/stop-transaction',
  handler(stopEnvelope, input => handleStopTransaction(input.charge_point_id, input.payload))
);
gridProtocolRouter.post(
  '/ocpp/meter-values',
  handler(meterValuesEnvelope, input => handleMeterValues(input.charge_point_id, input.payload))
);
gridProtocolRouter.post(
  '/ocpp201/boot-notification',
  handler(boot201Envelope, input => handleBootNotification201(input.charge_point_id, input.payload))
);
gridProtocolRouter.post(
  '/ocpp201/heartbeat',
  handler(heartbeatSchema, input => handleHeartbeat201(input.charge_point_id))
);
gridProtocolRouter.post(
  '/ocpp201/status-notification',
  handler(status201Envelope, async input => {
    await handleStatusNotification201(input.charge_point_id, input.payload);
    return {};
  })
);
gridProtocolRouter.post(
  '/ocpp201/authorize',
  handler(authorize201Envelope, async input => ({
    idTokenInfo: await authorizeIdToken201(input.payload.idToken),
  }))
);
gridProtocolRouter.post(
  '/ocpp201/meter-values',
  handler(meterValues201Envelope, input =>
    handleMeterValues201(input.charge_point_id, input.payload)
  )
);
gridProtocolRouter.post(
  '/ocpp201/transaction-event',
  handler(transactionEvent201Envelope, input =>
    handleTransactionEvent201(input.charge_point_id, input.payload)
  )
);
gridProtocolRouter.post(
  '/openadr/event',
  handler(openADRSchema, input => handleOpenADREvent(input))
);
gridProtocolRouter.post(
  '/sep2/controls',
  handler(sep2Schema, input => handleSep2Controls(input.controls))
);
gridProtocolRouter.post(
  '/modbus/readings',
  handler(modbusSchema, input => handleModbusReadings(input.readings))
);
