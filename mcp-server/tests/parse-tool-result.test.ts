const { parseToolResult } = require('../../scripts/parse-tool-result.js');
export {};

describe('parseToolResult', () => {
  it('returns multiple JSON text items as an ordered value array', () => {
    const result = parseToolResult({
      content: [
        { type: 'text', text: '{"first":1}' },
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
        { type: 'text', text: '{"second":2}' }
      ]
    });

    expect(result.value).toEqual([{ first: 1 }, { second: 2 }]);
    expect(result.texts).toEqual(['{"first":1}', '{"second":2}']);
    expect(result.images).toHaveLength(1);
  });

  it('returns undefined value and empty texts when content has no text item', () => {
    expect(parseToolResult({
      content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }]
    })).toEqual({
      value: undefined,
      images: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
      texts: []
    });
  });

  it('preserves invalid JSON text as its raw string value', () => {
    expect(parseToolResult({
      content: [{ type: 'text', text: '{not-json' }]
    })).toEqual({
      value: '{not-json',
      images: [],
      texts: ['{not-json']
    });
  });
});
