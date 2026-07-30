export const TEST_AUTH_TOKEN = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
export const OTHER_AUTH_TOKEN = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

export const testBrokerConfig = (port = 0) => ({
  host: '127.0.0.1' as const,
  port,
  token: TEST_AUTH_TOKEN
});
