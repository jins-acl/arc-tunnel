import { Server } from '@modelcontextprotocol/sdk/server';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types';
import { randomUUID } from 'crypto';
import { WebSocketServer } from './websocket-server';
import { CommandQueue } from './command-queue';
import { getToolDefinitions } from './tools';
import { CommandMessage, ResponseMessage, EventMessage } from './types';

export class WebBridgeMCPServer {
  private mcpServer: Server;
  private wsServer: WebSocketServer;
  private commandQueue: CommandQueue;
  private port: number;

  constructor(port: number = 8765) {
    this.port = port;
    this.wsServer = new WebSocketServer(port);
    this.commandQueue = new CommandQueue();

    this.mcpServer = new Server(
      {
        name: 'web-bridge',
        version: '1.0.0'
      },
      {
        capabilities: {
          tools: {}
        }
      }
    );
  }

  async startWebSocket(): Promise<void> {
    await this.wsServer.start();

    // Handle responses from extension
    this.wsServer.on('response', (message: ResponseMessage) => {
      if (message.success) {
        this.commandQueue.resolveCommand(message.id, message.result);
      } else {
        this.commandQueue.rejectCommand(
          message.id,
          new Error(message.error?.message || 'Unknown error')
        );
      }
    });

    // Handle events from extension
    this.wsServer.on('event', (message: EventMessage) => {
      console.log('Event from extension:', message.event, message.data);
    });
  }

  async startMCP(): Promise<void> {
    // Register tools
    this.mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = getToolDefinitions();
      return { tools };
    });

    this.mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
      return await this.handleToolCall(request);
    });

    // Start stdio transport
    const transport = new StdioServerTransport();
    await this.mcpServer.connect(transport);
    console.log('MCP server started on stdio');
  }

  private async handleToolCall(request: any): Promise<any> {
    const { name, arguments: params } = request.params;

    if (!this.wsServer.isConnected()) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: 'Extension not connected'
          })
        }]
      };
    }

    try {
      const commandId = randomUUID();
      const command: CommandMessage = {
        id: commandId,
        type: 'command',
        command: name,
        params,
        timeout: 30000
      };

      // Send command to extension
      this.wsServer.sendCommand(command);

      // Wait for response
      const result = await this.commandQueue.addCommand(commandId, 30000);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: error.message
          })
        }],
        isError: true
      };
    }
  }

  isWebSocketRunning(): boolean {
    return this.wsServer.isRunning();
  }

  async stop(): Promise<void> {
    this.commandQueue.clear();
    await this.wsServer.stop();
  }
}
