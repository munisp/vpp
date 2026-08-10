import { createTRPCReact } from '@trpc/react-query';
import { httpBatchLink } from '@trpc/client';
import superjson from 'superjson';
import * as SecureStore from 'expo-secure-store';
import type { AppRouter } from '../../../server/routers';

// Create tRPC React hooks
export const trpc = createTRPCReact<AppRouter>();

// API base URL configured via EXPO_PUBLIC_API_URL environment variable
const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3000';

/**
 * Retrieve the stored OAuth access token from Expo SecureStore.
 * Returns an empty string if no token is available (unauthenticated).
 */
async function getAuthToken(): Promise<string> {
  try {
    return (await SecureStore.getItemAsync('auth_token')) ?? '';
  } catch {
    return '';
  }
}

export const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: `${API_URL}/api/trpc`,
      transformer: superjson,
      headers: async () => {
        const token = await getAuthToken();
        return {
          authorization: token ? `Bearer ${token}` : '',
        };
      },
    }),
  ],
});
