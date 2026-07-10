import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { BrokerClient } from './broker-client';
import { toErrorInfo } from './protocol';
import { getToolDefinitions } from './tools';

const SCREENSHOT_KEYS = new Set([
  'screenshot',
  'mimeType',
  'format',
  'quality',
  'resized',
  'width',
  'height',
  'originalWidth',
  'originalHeight'
]);

const RAW_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function screenshotContent(result: unknown): any {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    throw new Error('Invalid screenshot result from browser extension');
  }

  const value = result as Record<string, unknown>;
  if (Object.keys(value).some(key => !SCREENSHOT_KEYS.has(key))) {
    throw new Error('Invalid screenshot result from browser extension');
  }

  if (
    typeof value.screenshot !== 'string' ||
    value.screenshot.length === 0 ||
    !RAW_BASE64.test(value.screenshot) ||
    (value.format !== 'jpeg' && value.format !== 'png') ||
    value.mimeType !== (value.format === 'png' ? 'image/png' : 'image/jpeg') ||
    typeof value.resized !== 'boolean'
  ) {
    throw new Error('Invalid screenshot result from browser extension');
  }

  if (
    (value.quality !== undefined &&
      (!Number.isInteger(value.quality) || (value.quality as number) < 1 || (value.quality as number) > 100)) ||
    (value.format === 'png' && value.quality !== undefined)
  ) {
    throw new Error('Invalid screenshot result from browser extension');
  }

  for (const key of ['width', 'height', 'originalWidth', 'originalHeight'] as const) {
    const dimension = value[key];
    if (dimension !== undefined && (!Number.isInteger(dimension) || (dimension as number) < 1)) {
      throw new Error('Invalid screenshot result from browser extension');
    }
  }

  const metadata = {
    format: value.format,
    quality: value.quality,
    resized: value.resized,
    width: value.width,
    height: value.height,
    originalWidth: value.originalWidth,
    originalHeight: value.originalHeight
  };
  return {
    content: [
      { type: 'image', data: value.screenshot, mimeType: value.mimeType },
      { type: 'text', text: JSON.stringify(metadata) }
    ]
  };
}

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
        return screenshotContent(result);
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
