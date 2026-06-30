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
});
