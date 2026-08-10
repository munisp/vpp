import { useEffect, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { useAuth } from '@/_core/hooks/useAuth';

interface TelemetryData {
  assetId: number;
  timestamp: Date;
  power?: number | null;
  energy?: number | null;
  voltage?: number | null;
  current?: number | null;
  frequency?: number | null;
  stateOfCharge?: number | null;
  temperature?: number | null;
  metadata?: string | null;
}

interface UseWebSocketReturn {
  telemetry: TelemetryData | null;
  connected: boolean;
  error: string | null;
}

export function useWebSocket(): UseWebSocketReturn {
  const { user } = useAuth();
  const [socket, setSocket] = useState<Socket | null>(null);
  const [telemetry, setTelemetry] = useState<TelemetryData | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user?.id) return;

    // Connect to WebSocket server
    const socketInstance = io(window.location.origin, {
      path: '/api/socket.io',
      transports: ['websocket', 'polling'],
    });

    socketInstance.on('connect', () => {
      console.log('[WebSocket] Connected');
      setConnected(true);
      setError(null);
      
      // Join user-specific room
      socketInstance.emit('join', user.id);
    });

    socketInstance.on('disconnect', () => {
      console.log('[WebSocket] Disconnected');
      setConnected(false);
    });

    socketInstance.on('connect_error', (err) => {
      console.error('[WebSocket] Connection error:', err);
      setError('Failed to connect to real-time data stream');
      setConnected(false);
    });

    // Listen for telemetry updates
    socketInstance.on('telemetry:update', (data: TelemetryData) => {
      setTelemetry(data);
    });

    setSocket(socketInstance);

    // Cleanup on unmount
    return () => {
      socketInstance.disconnect();
    };
  }, [user?.id]);

  return { telemetry, connected, error };
}
