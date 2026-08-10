import { useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { useAuth } from '@/_core/hooks/useAuth';

interface AnalyticsUpdate {
  type: 'qr_transaction' | 'referral_update' | 'reward_earned';
  userId: number;
  data: any;
  timestamp: string;
}

interface UseAnalyticsWebSocketOptions {
  onUpdate?: (update: AnalyticsUpdate) => void;
  enabled?: boolean;
}

export function useAnalyticsWebSocket(options: UseAnalyticsWebSocketOptions = {}) {
  const { onUpdate, enabled = true } = options;
  const { user } = useAuth();
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!enabled || !user) {
      return;
    }

    // Initialize socket connection
    const socket = io({
      path: '/api/socket.io',
      transports: ['websocket', 'polling'],
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('[Analytics WebSocket] Connected');
      // Subscribe to analytics updates for this user
      socket.emit('subscribe:analytics', user.id);
    });

    socket.on('analytics:update', (update: AnalyticsUpdate) => {
      console.log('[Analytics WebSocket] Received update:', update);
      if (onUpdate) {
        onUpdate(update);
      }
    });

    socket.on('disconnect', () => {
      console.log('[Analytics WebSocket] Disconnected');
    });

    socket.on('connect_error', (error) => {
      console.error('[Analytics WebSocket] Connection error:', error);
    });

    return () => {
      if (socketRef.current) {
        socketRef.current.emit('unsubscribe:analytics', user.id);
        socketRef.current.disconnect();
        socketRef.current = null;
      }
    };
  }, [enabled, user, onUpdate]);

  return socketRef.current;
}
