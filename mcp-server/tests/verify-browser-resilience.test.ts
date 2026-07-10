const {
  assertFailFastTiming,
  parseToolResult
} = require('../../scripts/verify-browser-resilience.js');

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
});
