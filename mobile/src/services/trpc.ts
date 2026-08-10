import { createTRPCReact } from '@trpc/react-query';
import { httpBatchLink } from '@trpc/client';
import superjson from 'superjson';
import type { AppRouter } from '../../../server/routers';

// Create tRPC React hooks
export const trpc = createTRPCReact<AppRouter>();

// API base URL - update this to your production server
const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3000';

export const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: `${API_URL}/api/trpc`,
      transformer: superjson,
      // Add authentication headers
      headers: async () => {
        // TODO: Get auth token from secure storage
        const token = ''; // await getAuthToken();
        return {
          authorization: token ? `Bearer ${token}` : '',
        };
      },
    }),
  ],
});
