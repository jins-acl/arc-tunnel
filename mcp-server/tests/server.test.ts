import { ArcTunnelMCPServer } from '../src/server';

describe('ArcTunnelMCPServer', () => {
  it('forwards tool calls to the Broker client', async () => {
    const brokerClient = { call: jest.fn().mockResolvedValue({ tabs: [1] }), close: jest.fn() } as any;
    const server = new ArcTunnelMCPServer(brokerClient);
    await expect((server as any).handleToolCall({ params: { name: 'list_tabs', arguments: {} } }))
      .resolves.toEqual({ content: [{ type: 'text', text: JSON.stringify({ tabs: [1] }) }] });
    expect(brokerClient.call).toHaveBeenCalledWith('list_tabs', {}, 30_000);
  });

  it('returns coded Broker errors as MCP tool errors', async () => {
    const error = Object.assign(new Error('missing tab'), { code: 'TAB_NOT_FOUND' });
    const server = new ArcTunnelMCPServer({ call: jest.fn().mockRejectedValue(error), close: jest.fn() } as any);
    await expect((server as any).handleToolCall({ params: { name: 'click' } })).resolves.toEqual({
      content: [{ type: 'text', text: JSON.stringify({ error: 'missing tab', code: 'TAB_NOT_FOUND' }) }],
      isError: true
    });
  });

  it('translates screenshot results into MCP image content and token-safe metadata', async () => {
    const screenshot = {
      screenshot: 'YWJjMTIz',
      mimeType: 'image/jpeg',
      format: 'jpeg',
      quality: 80,
      resized: false
    };
    const server = new ArcTunnelMCPServer({
      call: jest.fn().mockResolvedValue(screenshot),
      close: jest.fn()
    } as any);

    const result = await (server as any).handleToolCall({
      params: { name: 'screenshot', arguments: { tabId: 7 } }
    });

    expect(result).toEqual({ content: [
      { type: 'image', data: 'YWJjMTIz', mimeType: 'image/jpeg' },
      { type: 'text', text: JSON.stringify({ format: 'jpeg', quality: 80, resized: false }) }
    ] });
    expect(JSON.stringify(result.content[1])).not.toContain('YWJjMTIz');
  });

  it('returns INTERNAL_ERROR for a malformed screenshot result', async () => {
    const server = new ArcTunnelMCPServer({
      call: jest.fn().mockResolvedValue({ screenshot: 123, mimeType: 'image/jpeg' }),
      close: jest.fn()
    } as any);

    const result = await (server as any).handleToolCall({ params: { name: 'screenshot' } });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it.each([
    ['empty image data', { screenshot: '', mimeType: 'image/jpeg', format: 'jpeg', quality: 80, resized: false }],
    ['non-base64 image data', { screenshot: 'not base64!', mimeType: 'image/jpeg', format: 'jpeg', quality: 80, resized: false }],
    ['invalid base64 padding', { screenshot: 'YWJj===', mimeType: 'image/jpeg', format: 'jpeg', quality: 80, resized: false }],
    ['a data URL', { screenshot: 'data:image/jpeg;base64,YWJj', mimeType: 'image/jpeg', format: 'jpeg', quality: 80, resized: false }],
    ['duplicate data payload', { screenshot: 'YWJj', data: 'YWJj', mimeType: 'image/jpeg', format: 'jpeg', quality: 80, resized: false }],
    ['duplicate URL payload', { screenshot: 'YWJj', url: 'data:image/jpeg;base64,YWJj', mimeType: 'image/jpeg', format: 'jpeg', quality: 80, resized: false }],
    ['an unknown payload field', { screenshot: 'YWJj', payload: 'YWJj', mimeType: 'image/jpeg', format: 'jpeg', quality: 80, resized: false }],
    ['JPEG MIME with PNG format', { screenshot: 'YWJj', mimeType: 'image/jpeg', format: 'png', resized: false }],
    ['PNG MIME with JPEG format', { screenshot: 'YWJj', mimeType: 'image/png', format: 'jpeg', quality: 80, resized: false }]
  ])('returns INTERNAL_ERROR for screenshot results containing %s', async (_label, screenshot) => {
    const server = new ArcTunnelMCPServer({
      call: jest.fn().mockResolvedValue(screenshot),
      close: jest.fn()
    } as any);

    const result = await (server as any).handleToolCall({ params: { name: 'screenshot' } });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ code: 'INTERNAL_ERROR' });
    if ((screenshot as any).screenshot) {
      expect(JSON.stringify(result.content)).not.toContain((screenshot as any).screenshot);
    }
  });
});
