/**
 * Wiring test for src/services/trpc.ts. The tRPC and SecureStore packages are
 * mocked so the real module-under-test runs and we can inspect exactly what
 * configuration it hands to httpBatchLink / createClient.
 */

const mockGetItemAsync = jest.fn();
const mockHttpBatchLink = jest.fn((opts: Record<string, unknown>) => opts);
const mockCreateClient = jest.fn();

jest.mock('expo-secure-store', () => ({
  getItemAsync: (...args: unknown[]) => mockGetItemAsync(...args),
}));

jest.mock('@trpc/react-query', () => ({
  createTRPCReact: () => ({ createClient: mockCreateClient }),
}));

jest.mock('@trpc/client', () => ({
  httpBatchLink: (opts: Record<string, unknown>) => mockHttpBatchLink(opts),
}));

function loadModule() {
  // Re-evaluate services/trpc so module-level env reads take effect per test.
  jest.resetModules();
  return require('../services/trpc');
}

type BatchLinkOptions = {
  url: string;
  transformer: { serialize: unknown; deserialize: unknown };
  headers: () => Promise<Record<string, string>>;
};

function capturedLinkOptions(): BatchLinkOptions {
  expect(mockHttpBatchLink).toHaveBeenCalledTimes(1);
  return mockHttpBatchLink.mock.calls[0][0] as BatchLinkOptions;
}

describe('trpc client configuration', () => {
  beforeEach(() => {
    mockHttpBatchLink.mockClear();
    mockCreateClient.mockClear();
    mockGetItemAsync.mockReset();
    delete process.env.EXPO_PUBLIC_API_URL;
  });

  it('points httpBatchLink at the local API by default', () => {
    loadModule();
    expect(capturedLinkOptions().url).toBe('http://localhost:3000/api/trpc');
  });

  it('honours EXPO_PUBLIC_API_URL for the batch endpoint', () => {
    process.env.EXPO_PUBLIC_API_URL = 'https://api.example.com';
    loadModule();
    expect(capturedLinkOptions().url).toBe('https://api.example.com/api/trpc');
  });

  it('passes the link list to trpc.createClient', () => {
    loadModule();
    expect(mockCreateClient).toHaveBeenCalledTimes(1);
    const config = mockCreateClient.mock.calls[0][0];
    expect(Array.isArray(config.links)).toBe(true);
    expect(config.links).toHaveLength(1);
  });

  it('uses a superjson-compatible transformer', () => {
    loadModule();
    const { transformer } = capturedLinkOptions();
    expect(typeof transformer.serialize).toBe('function');
    expect(typeof transformer.deserialize).toBe('function');
  });

  it('omits the Cookie header when no session token is stored', async () => {
    mockGetItemAsync.mockResolvedValue(null);
    loadModule();
    await expect(capturedLinkOptions().headers()).resolves.toEqual({});
    expect(mockGetItemAsync).toHaveBeenCalledWith('auth_token');
  });

  it('sends the stored token as the app_session_id session cookie', async () => {
    mockGetItemAsync.mockResolvedValue('jwt-abc-123');
    loadModule();
    await expect(capturedLinkOptions().headers()).resolves.toEqual({
      Cookie: 'app_session_id=jwt-abc-123',
    });
  });

  it('falls back to no Cookie header when SecureStore read fails', async () => {
    mockGetItemAsync.mockRejectedValue(new Error('keychain unavailable'));
    loadModule();
    await expect(capturedLinkOptions().headers()).resolves.toEqual({});
  });
});
