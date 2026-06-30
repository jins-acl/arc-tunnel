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
