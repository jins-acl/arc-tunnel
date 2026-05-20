import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
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
    this.setupHandlers();
  }

  async startWebSocketWithRetry(maxRetries: number = 10): Promise<void> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        await this.wsServer.start();
        console.log(`WebSocket server started on port ${this.port}`);
        this.setupHandlers();
        return;
      } catch (error: any) {
        if (error.code === 'EADDRINUSE') {
          console.error(`Port ${this.port} in use (attempt ${i + 1}/${maxRetries}), retrying in 3s...`);
          await new Promise(resolve => setTimeout(resolve, 3000));
        } else {
          throw error;
        }
      }
    }
    throw new Error(`Failed to start WebSocket server after ${maxRetries} attempts`);
  }

  private setupHandlers(): void {
    // Handle responses from extension
    this.wsServer.on('response', (message: ResponseMessage) => {
      if (message.success) {
        this.commandQueue.resolveCommand(message.id, message.result);
      } else {
        const error = new Error(message.error?.message || 'Unknown error');
        if (message.error?.code) {
          (error as any).code = message.error.code;
        }
        this.commandQueue.rejectCommand(message.id, error);
      }
    });

    // Handle events from extension (skip noisy heartbeat events)
    this.wsServer.on('event', (message: EventMessage) => {
      if (message.event !== 'heartbeat') {
        console.log('Event from extension:', message.event, message.data);
      }
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
    const { name, arguments: args } = request.params;

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
        params: args,
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
      const errorResponse: { error: string; code?: string } = {
        error: error.message
      };
      if (error.code) {
        errorResponse.code = error.code;
      }
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(errorResponse)
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
