const {
  assertFailFastTiming,
  closeHttpServer,
  parseToolResult
} = require('../../scripts/verify-browser-resilience.js');
const http = require('node:http');

describe('browser resilience verifier helpers', () => {
  it('parses MCP image and text content without folding image data into text', () => {
    const parsed = parseToolResult({
      content: [
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/jpeg' },
        { type: 'text', text: JSON.stringify({ format: 'jpeg', quality: 70 }) }
      ]
    });

    expect(parsed.value).toEqual({ format: 'jpeg', quality: 70 });
    expect(parsed.images).toEqual([
      { type: 'image', data: 'aGVsbG8=', mimeType: 'image/jpeg' }
    ]);
    expect(parsed.texts).toEqual([JSON.stringify({ format: 'jpeg', quality: 70 })]);
    expect(parsed.texts.join('')).not.toContain('aGVsbG8=');
  });

  it('parses a normal text-only tool result', () => {
    expect(parseToolResult({
      content: [{ type: 'text', text: JSON.stringify({ status: 'closed' }) }]
    })).toEqual({
      value: { status: 'closed' },
      images: [],
      texts: [JSON.stringify({ status: 'closed' })]
    });
  });

  it('throws tool errors with their MCP error code', () => {
    expect(() => parseToolResult({
      isError: true,
      content: [{
        type: 'text',
        text: JSON.stringify({ error: 'Runtime.evaluate timed out', code: 'TIMEOUT' })
      }]
    })).toThrow(expect.objectContaining({
      message: 'Runtime.evaluate timed out',
      code: 'TIMEOUT'
    }));
  });

  it('accepts fail-fast durations from 5 through 8 seconds inclusive', () => {
    expect(() => assertFailFastTiming('execute_script', 5_000)).not.toThrow();
    expect(() => assertFailFastTiming('get_content', 8_000)).not.toThrow();
  });

  it('rejects fail-fast durations outside the 5-to-8-second window', () => {
    expect(() => assertFailFastTiming('execute_script', 4_999)).toThrow(/execute_script.*4999/i);
    expect(() => assertFailFastTiming('get_content', 8_001)).toThrow(/get_content.*8001/i);
  });

  it('force-closes active HTTP connections during cleanup', async () => {
    let markRequestStarted!: () => void;
    const requestStarted = new Promise<void>(resolve => { markRequestStarted = resolve; });
    const server: import('node:http').Server = http.createServer(
      (_request: unknown, _response: unknown) => markRequestStarted()
    );
    let request: import('node:http').ClientRequest | undefined;

    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Test server did not expose a port');

      const activeRequest = http.get(`http://127.0.0.1:${address.port}/`);
      request = activeRequest;
      activeRequest.on('error', () => {});
      await requestStarted;

      await expect(Promise.race([
        closeHttpServer(server),
        new Promise((_, reject) => setTimeout(() => reject(new Error('HTTP cleanup remained blocked')), 1_000))
      ])).resolves.toBeUndefined();
    } finally {
      request?.destroy();
      if (server.listening) {
        await new Promise<void>(resolve => {
          server.close(() => resolve());
          server.closeAllConnections?.();
        });
      }
    }
  });

  it('treats an HTTP server that never started listening as already closed', async () => {
    const server = http.createServer();

    await expect(closeHttpServer(server)).resolves.toBeUndefined();
  });
});
