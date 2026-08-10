import { createTRPCReact } from '@trpc/react-query';
import { httpBatchLink } from '@trpc/client';
import superjson from 'superjson';
import * as SecureStore from 'expo-secure-store';
import type { AppRouter } from '../../../server/routers';

// Create tRPC React hooks
export const trpc = createTRPCReact<AppRouter>();

// API base URL configured via EXPO_PUBLIC_API_URL environment variable
const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3000';

// The server authenticates via a session cookie (server/_core/sdk.ts ->
// authenticateRequest reads the "app_session_id" cookie; there is no Bearer
// token support). Mobile stores the session token in SecureStore under
// 'auth_token' and sends it as that cookie.
const SESSION_COOKIE_NAME = 'app_session_id';

/**
 * Retrieve the stored session token from Expo SecureStore.
 * Returns null when the user is not authenticated.
 */
async function getAuthToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync('auth_token');
  } catch {
    return null;
  }
}

export const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: `${API_URL}/api/trpc`,
      transformer: superjson,
      headers: async () => {
        const token = await getAuthToken();
        // Omit the Cookie header entirely when unauthenticated so public
        // procedures work and protected ones return a real auth error
        // instead of being sent an empty credential.
        if (!token) {
          return {};
        }
        return {
          Cookie: `${SESSION_COOKIE_NAME}=${token}`,
        };
      },
    }),
  ],
});
