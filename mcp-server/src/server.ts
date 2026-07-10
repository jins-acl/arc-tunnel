import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { BrokerClient } from './broker-client';
import { toErrorInfo } from './protocol';
import { getToolDefinitions } from './tools';

export class ArcTunnelMCPServer {
  private readonly mcpServer: Server;

  constructor(private readonly brokerClient: BrokerClient) {
    this.mcpServer = new Server(
      { name: 'arc-tunnel', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );
  }

  async startMCP(): Promise<void> {
    this.mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: getToolDefinitions() }));
    this.mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => this.handleToolCall(request));
    await this.mcpServer.connect(new StdioServerTransport());
  }

  private async handleToolCall(request: any): Promise<any> {
    try {
      const result = await this.brokerClient.call(
        request.params.name,
        request.params.arguments ?? {},
        30_000
      );
      if (request.params.name === 'screenshot') {
        if (
          typeof result !== 'object' ||
          result === null ||
          typeof (result as any).screenshot !== 'string' ||
          ((result as any).mimeType !== 'image/jpeg' && (result as any).mimeType !== 'image/png')
        ) {
          throw new Error('Invalid screenshot result from browser extension');
        }
        const { screenshot, mimeType, ...metadata } = result as Record<string, any>;
        return {
          content: [
            { type: 'image', data: screenshot, mimeType },
            { type: 'text', text: JSON.stringify(metadata) }
          ]
        };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (error) {
      const info = toErrorInfo(error);
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: info.message, code: info.code }) }],
        isError: true
      };
    }
  }
}
