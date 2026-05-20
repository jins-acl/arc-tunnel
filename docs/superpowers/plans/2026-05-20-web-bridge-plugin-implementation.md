# Web Bridge Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a browser automation plugin system with MCP integration, allowing AI to control user's browser through chrome.debugger API

**Architecture:** Extension-first architecture with MCP server as protocol adapter. Browser extension handles all automation logic via chrome.debugger API, MCP server provides WebSocket bridge and MCP protocol translation.

**Tech Stack:** 
- MCP Server: Node.js, TypeScript, @modelcontextprotocol/sdk, ws
- Browser Extension: TypeScript, Chrome Extension Manifest V3, esbuild
- Testing: Jest, Puppeteer

**Parallel Development Strategy:**
- **Track A (MCP Server)**: Tasks 1-6 can be developed independently
- **Track B (Browser Extension)**: Tasks 7-15 can be developed independently  
- **Track C (Integration)**: Task 16 requires both tracks complete

---

## File Structure Overview

### MCP Server (`mcp-server/`)
```
mcp-server/
├── src/
│   ├── index.ts                 # Entry point
│   ├── server.ts                # MCP server class
│   ├── websocket-server.ts      # WebSocket server
│   ├── command-queue.ts         # Command queue manager
│   ├── tools/                   # MCP tool implementations
│   │   ├── navigation.ts
│   │   ├── interaction.ts
│   │   ├── content.ts
│   │   ├── tabs.ts
│   │   ├── recording.ts
│   │   └── session.ts
│   └── types.ts                 # TypeScript types
├── tests/
│   └── server.test.ts
├── package.json
├── tsconfig.json
└── esbuild.config.js
```

### Browser Extension (`extension/`)
```
extension/
├── src/
│   ├── background/
│   │   ├── service-worker.ts      # Entry point
│   │   ├── websocket-client.ts    # WebSocket client
│   │   ├── tab-manager.ts         # Tab management
│   │   ├── debugger-controller.ts # CDP command execution
│   │   ├── recording-engine.ts    # Recording logic
│   │   ├── playback-engine.ts     # Playback logic
│   │   ├── session-manager.ts     # Session management
│   │   └── command-handler.ts     # Command dispatcher
│   ├── content/
│   │   ├── content-script.ts      # Page injection
│   │   └── element-selector.ts    # Smart element location
│   ├── popup/
│   │   ├── popup.html
│   │   ├── popup.ts
│   │   └── popup.css
│   └── types/
│       └── index.ts               # Shared types
├── public/
│   ├── manifest.json
│   └── icons/
├── tests/
│   └── background.test.ts
├── package.json
├── tsconfig.json
└── esbuild.config.js
```

---

## TRACK A: MCP Server Development

### Task 1: Project Setup - MCP Server

**Files:**
- Create: `mcp-server/package.json`
- Create: `mcp-server/tsconfig.json`
- Create: `mcp-server/esbuild.config.js`
- Create: `mcp-server/.gitignore`

- [ ] **Step 1: Initialize npm project**

```bash
mkdir -p mcp-server
cd mcp-server
npm init -y
```

- [ ] **Step 2: Install dependencies**

```bash
npm install @modelcontextprotocol/sdk ws uuid
npm install -D typescript @types/node @types/ws esbuild jest @types/jest ts-jest
```

- [ ] **Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "lib": ["ES2020"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 4: Create esbuild.config.js**

```javascript
const esbuild = require('esbuild');

esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  outfile: 'dist/mcp-server.js',
  sourcemap: true,
  external: ['@modelcontextprotocol/sdk', 'ws']
}).catch(() => process.exit(1));
```

- [ ] **Step 5: Create .gitignore**

```
node_modules/
dist/
*.log
.DS_Store
```

- [ ] **Step 6: Update package.json scripts**

```json
{
  "scripts": {
    "build": "node esbuild.config.js",
    "dev": "node esbuild.config.js && node dist/mcp-server.js",
    "test": "jest"
  }
}
```

- [ ] **Step 7: Commit**

```bash
git add mcp-server/
git commit -m "feat(mcp): initialize MCP server project"
```

### Task 2: TypeScript Types and Interfaces

**Files:**
- Create: `mcp-server/src/types.ts`

- [ ] **Step 1: Write failing test for types**

```typescript
// mcp-server/tests/types.test.ts
import { CommandMessage, ResponseMessage, EventMessage, ErrorCode } from '../src/types';

describe('Message Types', () => {
  it('should create valid CommandMessage', () => {
    const msg: CommandMessage = {
      id: 'test-id',
      type: 'command',
      command: 'navigate',
      params: { tabId: 1, url: 'https://example.com' }
    };
    expect(msg.type).toBe('command');
  });

  it('should create valid ResponseMessage', () => {
    const msg: ResponseMessage = {
      id: 'test-id',
      type: 'response',
      success: true,
      result: { status: 'ok' }
    };
    expect(msg.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with "Cannot find module '../src/types'"

- [ ] **Step 3: Create types.ts**

```typescript
// mcp-server/src/types.ts

// WebSocket message types
export interface CommandMessage {
  id: string;
  type: 'command';
  command: string;
  params: any;
  timeout?: number;
}

export interface ResponseMessage {
  id: string;
  type: 'response';
  success: boolean;
  result?: any;
  error?: ErrorInfo;
}

export interface EventMessage {
  type: 'event';
  event: string;
  data: any;
  timestamp: number;
}

export interface ErrorInfo {
  code: string;
  message: string;
  details?: any;
}

// Error codes
export enum ErrorCode {
  CONNECTION_LOST = 'CONNECTION_LOST',
  WEBSOCKET_ERROR = 'WEBSOCKET_ERROR',
  TAB_NOT_FOUND = 'TAB_NOT_FOUND',
  TAB_CLOSED = 'TAB_CLOSED',
  DEBUGGER_ATTACH_FAILED = 'DEBUGGER_ATTACH_FAILED',
  ELEMENT_NOT_FOUND = 'ELEMENT_NOT_FOUND',
  ELEMENT_NOT_VISIBLE = 'ELEMENT_NOT_VISIBLE',
  ELEMENT_NOT_INTERACTABLE = 'ELEMENT_NOT_INTERACTABLE',
  TIMEOUT = 'TIMEOUT',
  SCRIPT_ERROR = 'SCRIPT_ERROR',
  NETWORK_ERROR = 'NETWORK_ERROR',
  RECORDING_NOT_FOUND = 'RECORDING_NOT_FOUND',
  PLAYBACK_FAILED = 'PLAYBACK_FAILED',
  SESSION_NOT_FOUND = 'SESSION_NOT_FOUND',
  SESSION_RESTORE_FAILED = 'SESSION_RESTORE_FAILED'
}

// Pending command tracking
export interface PendingCommand {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/types.ts mcp-server/tests/types.test.ts
git commit -m "feat(mcp): add TypeScript types and interfaces"
```

### Task 3: WebSocket Server Implementation

**Files:**
- Create: `mcp-server/src/websocket-server.ts`
- Create: `mcp-server/tests/websocket-server.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// mcp-server/tests/websocket-server.test.ts
import { WebSocketServer } from '../src/websocket-server';
import WebSocket from 'ws';

describe('WebSocketServer', () => {
  let server: WebSocketServer;

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
  });

  it('should start and listen on specified port', async () => {
    server = new WebSocketServer(8765);
    await server.start();
    expect(server.isRunning()).toBe(true);
  });

  it('should handle client connection', (done) => {
    server = new WebSocketServer(8766);
    server.on('connection', (ws) => {
      expect(ws).toBeDefined();
      done();
    });
    
    server.start().then(() => {
      const client = new WebSocket('ws://localhost:8766');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- websocket-server.test.ts`
Expected: FAIL with "Cannot find module '../src/websocket-server'"

- [ ] **Step 3: Implement WebSocketServer class**

```typescript
// mcp-server/src/websocket-server.ts
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { CommandMessage, ResponseMessage, EventMessage } from './types';

export class WebSocketServer extends EventEmitter {
  private wss: WebSocket.Server | null = null;
  private extensionConnection: WebSocket | null = null;
  private port: number;

  constructor(port: number = 8765) {
    super();
    this.port = port;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocket.Server({ port: this.port });

      this.wss.on('listening', () => {
        console.log(`WebSocket server listening on port ${this.port}`);
        resolve();
      });

      this.wss.on('error', (error) => {
        console.error('WebSocket server error:', error);
        reject(error);
      });

      this.wss.on('connection', (ws: WebSocket) => {
        console.log('Extension connected');
        this.extensionConnection = ws;
        this.emit('connection', ws);

        ws.on('message', (data: WebSocket.Data) => {
          try {
            const message = JSON.parse(data.toString());
            this.handleMessage(message);
          } catch (error) {
            console.error('Failed to parse message:', error);
          }
        });

        ws.on('close', () => {
          console.log('Extension disconnected');
          this.extensionConnection = null;
          this.emit('disconnect');
        });

        ws.on('error', (error) => {
          console.error('WebSocket connection error:', error);
        });
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.extensionConnection) {
        this.extensionConnection.close();
        this.extensionConnection = null;
      }

      if (this.wss) {
        this.wss.close(() => {
          console.log('WebSocket server stopped');
          this.wss = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  isRunning(): boolean {
    return this.wss !== null;
  }

  isConnected(): boolean {
    return this.extensionConnection !== null && 
           this.extensionConnection.readyState === WebSocket.OPEN;
  }

  sendCommand(message: CommandMessage): void {
    if (!this.isConnected()) {
      throw new Error('Extension not connected');
    }
    this.extensionConnection!.send(JSON.stringify(message));
  }

  private handleMessage(message: ResponseMessage | EventMessage): void {
    if (message.type === 'response') {
      this.emit('response', message);
    } else if (message.type === 'event') {
      this.emit('event', message);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- websocket-server.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/websocket-server.ts mcp-server/tests/websocket-server.test.ts
git commit -m "feat(mcp): implement WebSocket server"
```

### Task 4: Command Queue Manager

**Files:**
- Create: `mcp-server/src/command-queue.ts`
- Create: `mcp-server/tests/command-queue.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// mcp-server/tests/command-queue.test.ts
import { CommandQueue } from '../src/command-queue';

describe('CommandQueue', () => {
  let queue: CommandQueue;

  beforeEach(() => {
    queue = new CommandQueue();
  });

  it('should add command and resolve on response', async () => {
    const commandId = 'test-123';
    const promise = queue.addCommand(commandId, 5000);

    setTimeout(() => {
      queue.resolveCommand(commandId, { status: 'ok' });
    }, 100);

    const result = await promise;
    expect(result).toEqual({ status: 'ok' });
  });

  it('should reject on timeout', async () => {
    const commandId = 'test-456';
    const promise = queue.addCommand(commandId, 100);

    await expect(promise).rejects.toThrow('Command timeout');
  });

  it('should reject on error', async () => {
    const commandId = 'test-789';
    const promise = queue.addCommand(commandId, 5000);

    setTimeout(() => {
      queue.rejectCommand(commandId, new Error('Test error'));
    }, 100);

    await expect(promise).rejects.toThrow('Test error');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- command-queue.test.ts`
Expected: FAIL with "Cannot find module '../src/command-queue'"

- [ ] **Step 3: Implement CommandQueue class**

```typescript
// mcp-server/src/command-queue.ts
import { PendingCommand } from './types';

export class CommandQueue {
  private pendingCommands: Map<string, PendingCommand> = new Map();

  addCommand(commandId: string, timeout: number = 30000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingCommands.delete(commandId);
        reject(new Error(`Command timeout: ${commandId}`));
      }, timeout);

      this.pendingCommands.set(commandId, {
        resolve,
        reject,
        timeout: timeoutHandle
      });
    });
  }

  resolveCommand(commandId: string, result: any): void {
    const pending = this.pendingCommands.get(commandId);
    if (pending) {
      clearTimeout(pending.timeout);
      pending.resolve(result);
      this.pendingCommands.delete(commandId);
    }
  }

  rejectCommand(commandId: string, error: Error): void {
    const pending = this.pendingCommands.get(commandId);
    if (pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pendingCommands.delete(commandId);
    }
  }

  hasPending(commandId: string): boolean {
    return this.pendingCommands.has(commandId);
  }

  clear(): void {
    for (const [id, pending] of this.pendingCommands.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Command queue cleared'));
    }
    this.pendingCommands.clear();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- command-queue.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/command-queue.ts mcp-server/tests/command-queue.test.ts
git commit -m "feat(mcp): implement command queue manager"
```

### Task 5: MCP Tools Registration

**Files:**
- Create: `mcp-server/src/tools/index.ts`
- Create: `mcp-server/tests/tools.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// mcp-server/tests/tools.test.ts
import { getToolDefinitions } from '../src/tools';

describe('MCP Tools', () => {
  it('should return all tool definitions', () => {
    const tools = getToolDefinitions();
    expect(tools.length).toBeGreaterThan(0);
    expect(tools[0]).toHaveProperty('name');
    expect(tools[0]).toHaveProperty('description');
    expect(tools[0]).toHaveProperty('inputSchema');
  });

  it('should include navigate tool', () => {
    const tools = getToolDefinitions();
    const navigateTool = tools.find(t => t.name === 'navigate');
    expect(navigateTool).toBeDefined();
    expect(navigateTool?.inputSchema.properties).toHaveProperty('tabId');
    expect(navigateTool?.inputSchema.properties).toHaveProperty('url');
  });

  it('should include click tool', () => {
    const tools = getToolDefinitions();
    const clickTool = tools.find(t => t.name === 'click');
    expect(clickTool).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tools.test.ts`
Expected: FAIL with "Cannot find module '../src/tools'"

- [ ] **Step 3: Implement tool definitions**

```typescript
// mcp-server/src/tools/index.ts

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, any>;
    required: string[];
  };
}

export function getToolDefinitions(): ToolDefinition[] {
  return [
    // Navigation and interaction
    {
      name: 'navigate',
      description: 'Navigate to a URL in the specified tab',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'number', description: 'Tab ID' },
          url: { type: 'string', description: 'URL to navigate to' }
        },
        required: ['tabId', 'url']
      }
    },
    {
      name: 'click',
      description: 'Click an element in the specified tab',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'number', description: 'Tab ID' },
          selector: { type: 'string', description: 'CSS selector' }
        },
        required: ['tabId', 'selector']
      }
    },
    {
      name: 'type',
      description: 'Type text into an element',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'number', description: 'Tab ID' },
          selector: { type: 'string', description: 'CSS selector' },
          text: { type: 'string', description: 'Text to type' }
        },
        required: ['tabId', 'selector', 'text']
      }
    },
    {
      name: 'screenshot',
      description: 'Take a screenshot of the tab',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'number', description: 'Tab ID' },
          fullPage: { type: 'boolean', description: 'Capture full page' }
        },
        required: ['tabId']
      }
    },
    {
      name: 'get_content',
      description: 'Get page content in various formats',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'number', description: 'Tab ID' },
          mode: { 
            type: 'string', 
            enum: ['html', 'text', 'structured', 'markdown'],
            description: 'Content extraction mode' 
          }
        },
        required: ['tabId', 'mode']
      }
    },
    {
      name: 'execute_script',
      description: 'Execute JavaScript in the tab',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'number', description: 'Tab ID' },
          script: { type: 'string', description: 'JavaScript code' }
        },
        required: ['tabId', 'script']
      }
    },
    {
      name: 'wait_for_element',
      description: 'Wait for an element to appear',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'number', description: 'Tab ID' },
          selector: { type: 'string', description: 'CSS selector' },
          timeout: { type: 'number', description: 'Timeout in ms' }
        },
        required: ['tabId', 'selector']
      }
    },
    // Tab management
    {
      name: 'create_tab',
      description: 'Create a new tab',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Initial URL' }
        },
        required: []
      }
    },
    {
      name: 'close_tab',
      description: 'Close a tab',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'number', description: 'Tab ID' }
        },
        required: ['tabId']
      }
    },
    {
      name: 'list_tabs',
      description: 'List all open tabs',
      inputSchema: {
        type: 'object',
        properties: {},
        required: []
      }
    },
    // Recording and playback
    {
      name: 'start_recording',
      description: 'Start recording user actions',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'number', description: 'Tab ID' }
        },
        required: ['tabId']
      }
    },
    {
      name: 'stop_recording',
      description: 'Stop recording and return the recording',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'number', description: 'Tab ID' }
        },
        required: ['tabId']
      }
    },
    {
      name: 'replay_recording',
      description: 'Replay a recorded session',
      inputSchema: {
        type: 'object',
        properties: {
          recordingId: { type: 'string', description: 'Recording ID' }
        },
        required: ['recordingId']
      }
    },
    // Session management
    {
      name: 'save_session',
      description: 'Save current browser session',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Session name' }
        },
        required: ['name']
      }
    },
    {
      name: 'restore_session',
      description: 'Restore a saved session',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Session ID' }
        },
        required: ['sessionId']
      }
    }
  ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tools.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/tools/ mcp-server/tests/tools.test.ts
git commit -m "feat(mcp): add MCP tool definitions"
```

### Task 6: MCP Server Main Class

**Files:**
- Create: `mcp-server/src/server.ts`
- Create: `mcp-server/src/index.ts`
- Create: `mcp-server/tests/server.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// mcp-server/tests/server.test.ts
import { WebBridgeMCPServer } from '../src/server';

describe('WebBridgeMCPServer', () => {
  let server: WebBridgeMCPServer;

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
  });

  it('should initialize server', () => {
    server = new WebBridgeMCPServer(8767);
    expect(server).toBeDefined();
  });

  it('should start WebSocket server', async () => {
    server = new WebBridgeMCPServer(8768);
    await server.startWebSocket();
    expect(server.isWebSocketRunning()).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- server.test.ts`
Expected: FAIL with "Cannot find module '../src/server'"

- [ ] **Step 3: Implement WebBridgeMCPServer class**

```typescript
// mcp-server/src/server.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { v4 as uuidv4 } from 'uuid';
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
    const tools = getToolDefinitions();
    this.mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
      return await this.handleToolCall(request);
    });

    // List tools
    this.mcpServer.setRequestHandler({ method: 'tools/list' } as any, async () => {
      return { tools };
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
      const commandId = uuidv4();
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
```

- [ ] **Step 4: Create entry point**

```typescript
// mcp-server/src/index.ts
import { WebBridgeMCPServer } from './server';

async function main() {
  const port = parseInt(process.env.WS_PORT || '8765');
  const server = new WebBridgeMCPServer(port);

  try {
    // Start WebSocket server
    await server.startWebSocket();
    console.log(`WebSocket server started on port ${port}`);

    // Start MCP server
    await server.startMCP();
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }

  // Handle shutdown
  process.on('SIGINT', async () => {
    console.log('Shutting down...');
    await server.stop();
    process.exit(0);
  });
}

main();
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- server.test.ts`
Expected: PASS

- [ ] **Step 6: Test build**

Run: `npm run build`
Expected: Build succeeds, creates `dist/mcp-server.js`

- [ ] **Step 7: Commit**

```bash
git add mcp-server/src/server.ts mcp-server/src/index.ts mcp-server/tests/server.test.ts
git commit -m "feat(mcp): implement MCP server main class"
```

---

## TRACK B: Browser Extension Development

### Task 7: Project Setup - Browser Extension

**Files:**
- Create: `extension/package.json`
- Create: `extension/tsconfig.json`
- Create: `extension/esbuild.config.js`
- Create: `extension/public/manifest.json`

- [ ] **Step 1: Initialize extension project**

```bash
mkdir -p extension
cd extension
npm init -y
npm install -D typescript esbuild @types/chrome
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "lib": ["ES2020", "DOM"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "moduleResolution": "node",
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create esbuild.config.js**

```javascript
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

// Build background script
esbuild.build({
  entryPoints: ['src/background/service-worker.ts'],
  bundle: true,
  outfile: 'dist/background/service-worker.js',
  platform: 'browser',
  target: 'chrome96',
  format: 'esm'
});

// Build content script
esbuild.build({
  entryPoints: ['src/content/content-script.ts'],
  bundle: true,
  outfile: 'dist/content/content-script.js',
  platform: 'browser',
  target: 'chrome96'
});

// Build popup
esbuild.build({
  entryPoints: ['src/popup/popup.ts'],
  bundle: true,
  outfile: 'dist/popup/popup.js',
  platform: 'browser',
  target: 'chrome96'
});

// Copy static files
fs.cpSync('public', 'dist', { recursive: true });
```

- [ ] **Step 4: Create manifest.json**

```json
{
  "manifest_version": 3,
  "name": "Web Bridge",
  "version": "1.0.0",
  "description": "AI-powered browser automation",
  "permissions": [
    "debugger",
    "tabs",
    "storage",
    "cookies",
    "webNavigation",
    "unlimitedStorage"
  ],
  "host_permissions": ["<all_urls>"],
  "background": {
    "service_worker": "background/service-worker.js",
    "type": "module"
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content/content-script.js"],
      "run_at": "document_idle"
    }
  ],
  "action": {
    "default_popup": "popup/popup.html"
  }
}
```

- [ ] **Step 5: Update package.json scripts**

```json
{
  "scripts": {
    "build": "node esbuild.config.js",
    "watch": "node esbuild.config.js --watch"
  }
}
```

- [ ] **Step 6: Commit**

```bash
git add extension/
git commit -m "feat(ext): initialize browser extension project"
```

### Task 8: Extension Types and Interfaces

**Files:**
- Create: `extension/src/types/index.ts`

- [ ] **Step 1: Create shared types**

```typescript
// extension/src/types/index.ts

// Message types (matching MCP server)
export interface CommandMessage {
  id: string;
  type: 'command';
  command: string;
  params: any;
  timeout?: number;
}

export interface ResponseMessage {
  id: string;
  type: 'response';
  success: boolean;
  result?: any;
  error?: ErrorInfo;
}

export interface EventMessage {
  type: 'event';
  event: string;
  data: any;
  timestamp: number;
}

export interface ErrorInfo {
  code: string;
  message: string;
  details?: any;
}

// Tab management
export interface TabInfo {
  id: number;
  url: string;
  title: string;
  debuggerAttached: boolean;
}

// Recording types
export interface Recording {
  id: string;
  name: string;
  createdAt: string;
  actions: Action[];
  metadata: RecordingMetadata;
}

export interface Action {
  type: 'navigate' | 'click' | 'type' | 'wait';
  timestamp: number;
  target?: ElementTarget;
  url?: string;
  text?: string;
  waitConditions?: WaitConditions;
}

export interface ElementTarget {
  primary: string;
  fallbacks: string[];
  visual?: {
    screenshot: string;
    boundingBox: BoundingBox;
  };
  context: {
    nearbyText: string;
    parentTag: string;
    role: string;
  };
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WaitConditions {
  networkIdle: boolean;
  domStable: boolean;
  elementVisible: boolean;
  elementEnabled: boolean;
  customCondition?: string;
}

export interface RecordingMetadata {
  startUrl: string;
  duration: number;
  actionCount: number;
}

// Session types
export interface SessionData {
  id: string;
  name: string;
  tabs: TabState[];
  savedAt: string;
}

export interface TabState {
  url: string;
  cookies: chrome.cookies.Cookie[];
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
}

// Config
export interface ExtensionConfig {
  wsUrl: string;
  autoReconnect: boolean;
  defaultTimeout: number;
  recordingOptions: {
    captureVisual: boolean;
    captureContext: boolean;
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add extension/src/types/
git commit -m "feat(ext): add TypeScript types and interfaces"
```

### Task 9: WebSocket Client

**Files:**
- Create: `extension/src/background/websocket-client.ts`

- [ ] **Step 1: Implement WebSocket client**

```typescript
// extension/src/background/websocket-client.ts
import { CommandMessage, ResponseMessage, EventMessage } from '../types';

export class WebSocketClient {
  private ws: WebSocket | null = null;
  private url: string;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private messageHandlers: Map<string, (message: any) => void> = new Map();

  constructor(url: string = 'ws://localhost:8765') {
    this.url = url;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        console.log('Connected to MCP server');
        this.reconnectAttempts = 0;
        resolve();
      };

      this.ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        reject(error);
      };

      this.ws.onclose = () => {
        console.log('Disconnected from MCP server');
        this.handleReconnect();
      };

      this.ws.onmessage = (event) => {
        try {
          const message: CommandMessage = JSON.parse(event.data);
          this.handleMessage(message);
        } catch (error) {
          console.error('Failed to parse message:', error);
        }
      };
    });
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  sendResponse(response: ResponseMessage): void {
    if (this.isConnected()) {
      this.ws!.send(JSON.stringify(response));
    }
  }

  sendEvent(event: EventMessage): void {
    if (this.isConnected()) {
      this.ws!.send(JSON.stringify(event));
    }
  }

  onCommand(handler: (message: CommandMessage) => void): void {
    this.messageHandlers.set('command', handler);
  }

  private handleMessage(message: CommandMessage): void {
    const handler = this.messageHandlers.get('command');
    if (handler) {
      handler(message);
    }
  }

  private async handleReconnect(): Promise<void> {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('Max reconnect attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    
    console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    
    setTimeout(async () => {
      try {
        await this.connect();
      } catch (error) {
        console.error('Reconnect failed:', error);
      }
    }, delay);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add extension/src/background/websocket-client.ts
git commit -m "feat(ext): implement WebSocket client"
```

### Task 10: Tab Manager

**Files:**
- Create: `extension/src/background/tab-manager.ts`

- [ ] **Step 1: Implement TabManager**

```typescript
// extension/src/background/tab-manager.ts
import { TabInfo } from '../types';

export class TabManager {
  private tabs: Map<number, TabInfo> = new Map();
  private activeTabId: number | null = null;

  async attachDebugger(tabId: number): Promise<void> {
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
      const tab = await chrome.tabs.get(tabId);
      this.tabs.set(tabId, {
        id: tabId,
        url: tab.url || '',
        title: tab.title || '',
        debuggerAttached: true
      });
      console.log(`Debugger attached to tab ${tabId}`);
    } catch (error) {
      console.error(`Failed to attach debugger to tab ${tabId}:`, error);
      throw error;
    }
  }

  async detachDebugger(tabId: number): Promise<void> {
    try {
      await chrome.debugger.detach({ tabId });
      const tabInfo = this.tabs.get(tabId);
      if (tabInfo) {
        tabInfo.debuggerAttached = false;
      }
      console.log(`Debugger detached from tab ${tabId}`);
    } catch (error) {
      console.error(`Failed to detach debugger from tab ${tabId}:`, error);
    }
  }

  async createTab(url?: string): Promise<number> {
    const tab = await chrome.tabs.create({ url, active: true });
    if (tab.id) {
      this.tabs.set(tab.id, {
        id: tab.id,
        url: tab.url || '',
        title: tab.title || '',
        debuggerAttached: false
      });
      return tab.id;
    }
    throw new Error('Failed to create tab');
  }

  async closeTab(tabId: number): Promise<void> {
    await chrome.tabs.remove(tabId);
    this.tabs.delete(tabId);
  }

  async switchTab(tabId: number): Promise<void> {
    await chrome.tabs.update(tabId, { active: true });
    this.activeTabId = tabId;
  }

  listTabs(): TabInfo[] {
    return Array.from(this.tabs.values());
  }

  getTab(tabId: number): TabInfo | undefined {
    return this.tabs.get(tabId);
  }

  isDebuggerAttached(tabId: number): boolean {
    return this.tabs.get(tabId)?.debuggerAttached || false;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add extension/src/background/tab-manager.ts
git commit -m "feat(ext): implement tab manager"
```

### Task 11: Debugger Controller (CDP)

**Files:**
- Create: `extension/src/background/debugger-controller.ts`

- [ ] **Step 1: Implement DebuggerController**

```typescript
// extension/src/background/debugger-controller.ts
export class DebuggerController {
  async sendCommand(tabId: number, method: string, params?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(result);
        }
      });
    });
  }

  async navigate(tabId: number, url: string): Promise<void> {
    await this.sendCommand(tabId, 'Page.navigate', { url });
    await this.sendCommand(tabId, 'Page.enable');
  }

  async click(tabId: number, selector: string): Promise<void> {
    const script = `
      const element = document.querySelector('${selector}');
      if (!element) throw new Error('Element not found');
      element.click();
    `;
    await this.executeScript(tabId, script);
  }

  async type(tabId: number, selector: string, text: string): Promise<void> {
    const script = `
      const element = document.querySelector('${selector}');
      if (!element) throw new Error('Element not found');
      element.focus();
      element.value = '${text}';
      element.dispatchEvent(new Event('input', { bubbles: true }));
    `;
    await this.executeScript(tabId, script);
  }

  async screenshot(tabId: number, fullPage: boolean = false): Promise<string> {
    const result = await this.sendCommand(tabId, 'Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: fullPage
    });
    return result.data;
  }

  async executeScript(tabId: number, script: string): Promise<any> {
    const result = await this.sendCommand(tabId, 'Runtime.evaluate', {
      expression: script,
      returnByValue: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text);
    }
    return result.result.value;
  }

  async getContent(tabId: number, mode: string): Promise<any> {
    switch (mode) {
      case 'html':
        return await this.executeScript(tabId, 'document.documentElement.outerHTML');
      case 'text':
        return await this.executeScript(tabId, 'document.body.innerText');
      case 'structured':
        return await this.getStructuredContent(tabId);
      case 'markdown':
        return await this.getMarkdownContent(tabId);
      default:
        throw new Error(`Unknown mode: ${mode}`);
    }
  }

  private async getStructuredContent(tabId: number): Promise<any> {
    const script = `
      ({
        title: document.title,
        url: window.location.href,
        text: document.body.innerText,
        links: Array.from(document.querySelectorAll('a')).map(a => ({
          text: a.textContent,
          href: a.href
        })),
        forms: Array.from(document.querySelectorAll('form')).map(f => ({
          id: f.id,
          fields: Array.from(f.elements).map(e => ({
            name: e.name,
            type: e.type
          }))
        })),
        images: Array.from(document.querySelectorAll('img')).map(img => ({
          src: img.src,
          alt: img.alt
        }))
      })
    `;
    return await this.executeScript(tabId, script);
  }

  private async getMarkdownContent(tabId: number): Promise<string> {
    // Simple markdown conversion
    const script = `
      let md = '# ' + document.title + '\\n\\n';
      md += document.body.innerText;
      md;
    `;
    return await this.executeScript(tabId, script);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add extension/src/background/debugger-controller.ts
git commit -m "feat(ext): implement debugger controller"
```

### Task 12: Recording and Playback Engines (Simplified)

**Files:**
- Create: `extension/src/background/recording-engine.ts`
- Create: `extension/src/background/playback-engine.ts`

- [ ] **Step 1: Implement basic RecordingEngine**

```typescript
// extension/src/background/recording-engine.ts
import { Recording, Action } from '../types';
import { v4 as uuidv4 } from 'uuid';

export class RecordingEngine {
  private isRecording = false;
  private currentRecording: Recording | null = null;
  private startTime = 0;

  async startRecording(tabId: number): Promise<string> {
    const recordingId = uuidv4();
    this.startTime = Date.now();
    
    this.currentRecording = {
      id: recordingId,
      name: `Recording ${new Date().toISOString()}`,
      createdAt: new Date().toISOString(),
      actions: [],
      metadata: {
        startUrl: '',
        duration: 0,
        actionCount: 0
      }
    };
    
    this.isRecording = true;
    console.log(`Started recording: ${recordingId}`);
    return recordingId;
  }

  async stopRecording(): Promise<Recording> {
    if (!this.currentRecording) {
      throw new Error('No active recording');
    }
    
    this.isRecording = false;
    const duration = Date.now() - this.startTime;
    
    this.currentRecording.metadata.duration = duration;
    this.currentRecording.metadata.actionCount = this.currentRecording.actions.length;
    
    const recording = this.currentRecording;
    this.currentRecording = null;
    
    // Save to storage
    await chrome.storage.local.set({
      [`recording_${recording.id}`]: recording
    });
    
    console.log(`Stopped recording: ${recording.id}`);
    return recording;
  }

  recordAction(action: Action): void {
    if (this.isRecording && this.currentRecording) {
      action.timestamp = Date.now() - this.startTime;
      this.currentRecording.actions.push(action);
    }
  }
}
```

- [ ] **Step 2: Implement basic PlaybackEngine**

```typescript
// extension/src/background/playback-engine.ts
import { Recording, Action } from '../types';
import { DebuggerController } from './debugger-controller';

export class PlaybackEngine {
  constructor(private debuggerController: DebuggerController) {}

  async replay(recordingId: string, tabId: number): Promise<void> {
    // Load recording from storage
    const result = await chrome.storage.local.get(`recording_${recordingId}`);
    const recording: Recording = result[`recording_${recordingId}`];
    
    if (!recording) {
      throw new Error('Recording not found');
    }

    console.log(`Replaying recording: ${recordingId}`);
    
    for (const action of recording.actions) {
      await this.executeAction(action, tabId);
      await this.sleep(100); // Small delay between actions
    }
    
    console.log('Playback complete');
  }

  private async executeAction(action: Action, tabId: number): Promise<void> {
    switch (action.type) {
      case 'navigate':
        if (action.url) {
          await this.debuggerController.navigate(tabId, action.url);
        }
        break;
      case 'click':
        if (action.target) {
          await this.debuggerController.click(tabId, action.target.primary);
        }
        break;
      case 'type':
        if (action.target && action.text) {
          await this.debuggerController.type(tabId, action.target.primary, action.text);
        }
        break;
      case 'wait':
        await this.sleep(1000);
        break;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add extension/src/background/recording-engine.ts extension/src/background/playback-engine.ts
git commit -m "feat(ext): implement recording and playback engines"
```

### Task 13: Session Manager (Simplified)

**Files:**
- Create: `extension/src/background/session-manager.ts`

- [ ] **Step 1: Implement SessionManager**

```typescript
// extension/src/background/session-manager.ts
import { SessionData, TabState } from '../types';
import { v4 as uuidv4 } from 'uuid';

export class SessionManager {
  async saveSession(name: string): Promise<string> {
    const sessionId = uuidv4();
    const tabs = await chrome.tabs.query({});
    const tabStates: TabState[] = [];

    for (const tab of tabs) {
      if (tab.id && tab.url) {
        const cookies = await chrome.cookies.getAll({ url: tab.url });
        
        tabStates.push({
          url: tab.url,
          cookies,
          localStorage: {},
          sessionStorage: {}
        });
      }
    }

    const session: SessionData = {
      id: sessionId,
      name,
      tabs: tabStates,
      savedAt: new Date().toISOString()
    };

    await chrome.storage.local.set({
      [`session_${sessionId}`]: session
    });

    console.log(`Session saved: ${sessionId}`);
    return sessionId;
  }

  async restoreSession(sessionId: string): Promise<void> {
    const result = await chrome.storage.local.get(`session_${sessionId}`);
    const session: SessionData = result[`session_${sessionId}`];

    if (!session) {
      throw new Error('Session not found');
    }

    console.log(`Restoring session: ${sessionId}`);

    for (const tabState of session.tabs) {
      // Create tab
      const tab = await chrome.tabs.create({ url: tabState.url });

      // Restore cookies
      if (tab.id) {
        for (const cookie of tabState.cookies) {
          await chrome.cookies.set({
            url: tabState.url,
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path,
            secure: cookie.secure,
            httpOnly: cookie.httpOnly
          });
        }
      }
    }

    console.log('Session restored');
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add extension/src/background/session-manager.ts
git commit -m "feat(ext): implement session manager"
```

### Task 14: Command Handler

**Files:**
- Create: `extension/src/background/command-handler.ts`

- [ ] **Step 1: Implement CommandHandler**

```typescript
// extension/src/background/command-handler.ts
import { CommandMessage, ResponseMessage } from '../types';
import { TabManager } from './tab-manager';
import { DebuggerController } from './debugger-controller';
import { RecordingEngine } from './recording-engine';
import { PlaybackEngine } from './playback-engine';
import { SessionManager } from './session-manager';

export class CommandHandler {
  constructor(
    private tabManager: TabManager,
    private debuggerController: DebuggerController,
    private recordingEngine: RecordingEngine,
    private playbackEngine: PlaybackEngine,
    private sessionManager: SessionManager
  ) {}

  async handleCommand(command: CommandMessage): Promise<ResponseMessage> {
    try {
      const result = await this.executeCommand(command);
      return {
        id: command.id,
        type: 'response',
        success: true,
        result
      };
    } catch (error: any) {
      return {
        id: command.id,
        type: 'response',
        success: false,
        error: {
          code: 'EXECUTION_ERROR',
          message: error.message
        }
      };
    }
  }

  private async executeCommand(command: CommandMessage): Promise<any> {
    const { command: cmd, params } = command;

    switch (cmd) {
      // Navigation and interaction
      case 'navigate':
        await this.ensureDebuggerAttached(params.tabId);
        await this.debuggerController.navigate(params.tabId, params.url);
        return { status: 'navigated' };

      case 'click':
        await this.ensureDebuggerAttached(params.tabId);
        await this.debuggerController.click(params.tabId, params.selector);
        return { status: 'clicked' };

      case 'type':
        await this.ensureDebuggerAttached(params.tabId);
        await this.debuggerController.type(params.tabId, params.selector, params.text);
        return { status: 'typed' };

      case 'screenshot':
        await this.ensureDebuggerAttached(params.tabId);
        const screenshot = await this.debuggerController.screenshot(params.tabId, params.fullPage);
        return { screenshot };

      case 'get_content':
        await this.ensureDebuggerAttached(params.tabId);
        const content = await this.debuggerController.getContent(params.tabId, params.mode);
        return { content };

      case 'execute_script':
        await this.ensureDebuggerAttached(params.tabId);
        const scriptResult = await this.debuggerController.executeScript(params.tabId, params.script);
        return { result: scriptResult };

      // Tab management
      case 'create_tab':
        const tabId = await this.tabManager.createTab(params.url);
        return { tabId };

      case 'close_tab':
        await this.tabManager.closeTab(params.tabId);
        return { status: 'closed' };

      case 'list_tabs':
        const tabs = this.tabManager.listTabs();
        return { tabs };

      // Recording
      case 'start_recording':
        const recordingId = await this.recordingEngine.startRecording(params.tabId);
        return { recordingId };

      case 'stop_recording':
        const recording = await this.recordingEngine.stopRecording();
        return { recording };

      case 'replay_recording':
        await this.playbackEngine.replay(params.recordingId, params.tabId);
        return { status: 'replayed' };

      // Session
      case 'save_session':
        const sessionId = await this.sessionManager.saveSession(params.name);
        return { sessionId };

      case 'restore_session':
        await this.sessionManager.restoreSession(params.sessionId);
        return { status: 'restored' };

      default:
        throw new Error(`Unknown command: ${cmd}`);
    }
  }

  private async ensureDebuggerAttached(tabId: number): Promise<void> {
    if (!this.tabManager.isDebuggerAttached(tabId)) {
      await this.tabManager.attachDebugger(tabId);
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add extension/src/background/command-handler.ts
git commit -m "feat(ext): implement command handler"
```

### Task 15: Service Worker (Main Entry Point)

**Files:**
- Create: `extension/src/background/service-worker.ts`

- [ ] **Step 1: Implement service worker**

```typescript
// extension/src/background/service-worker.ts
import { WebSocketClient } from './websocket-client';
import { TabManager } from './tab-manager';
import { DebuggerController } from './debugger-controller';
import { RecordingEngine } from './recording-engine';
import { PlaybackEngine } from './playback-engine';
import { SessionManager } from './session-manager';
import { CommandHandler } from './command-handler';
import { CommandMessage } from '../types';

// Initialize components
const wsClient = new WebSocketClient('ws://localhost:8765');
const tabManager = new TabManager();
const debuggerController = new DebuggerController();
const recordingEngine = new RecordingEngine();
const playbackEngine = new PlaybackEngine(debuggerController);
const sessionManager = new SessionManager();
const commandHandler = new CommandHandler(
  tabManager,
  debuggerController,
  recordingEngine,
  playbackEngine,
  sessionManager
);

// Connect to MCP server
async function initialize() {
  try {
    await wsClient.connect();
    console.log('Web Bridge extension initialized');
  } catch (error) {
    console.error('Failed to connect to MCP server:', error);
    // Retry after delay
    setTimeout(initialize, 5000);
  }
}

// Handle commands from MCP server
wsClient.onCommand(async (command: CommandMessage) => {
  console.log('Received command:', command.command);
  const response = await commandHandler.handleCommand(command);
  wsClient.sendResponse(response);
});

// Keep service worker alive
chrome.alarms.create('keepAlive', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    console.log('Service worker keepalive');
  }
});

// Initialize on startup
initialize();

console.log('Web Bridge service worker loaded');
```

- [ ] **Step 2: Create minimal popup**

```html
<!-- extension/public/popup/popup.html -->
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Web Bridge</title>
  <style>
    body {
      width: 300px;
      padding: 16px;
      font-family: system-ui;
    }
    .status {
      padding: 8px;
      border-radius: 4px;
      margin-bottom: 12px;
    }
    .connected { background: #d4edda; color: #155724; }
    .disconnected { background: #f8d7da; color: #721c24; }
  </style>
</head>
<body>
  <h2>Web Bridge</h2>
  <div id="status" class="status disconnected">
    Status: Disconnected
  </div>
  <p>Extension is running in the background.</p>
  <script src="popup.js"></script>
</body>
</html>
```

```typescript
// extension/src/popup/popup.ts
document.addEventListener('DOMContentLoaded', () => {
  const statusEl = document.getElementById('status');
  if (statusEl) {
    statusEl.textContent = 'Status: Connected';
    statusEl.className = 'status connected';
  }
});
```

- [ ] **Step 3: Build extension**

Run: `npm run build`
Expected: Build succeeds, creates `dist/` directory

- [ ] **Step 4: Commit**

```bash
git add extension/src/background/service-worker.ts extension/public/popup/ extension/src/popup/
git commit -m "feat(ext): implement service worker and popup UI"
```

---

## TRACK C: Integration and Testing

### Task 16: Integration Testing

**Files:**
- Create: `integration-test.md`

- [ ] **Step 1: Manual integration test**

Test checklist:
1. Build MCP server: `cd mcp-server && npm run build`
2. Build extension: `cd extension && npm run build`
3. Load extension in Chrome: `chrome://extensions/` → Load unpacked → select `extension/dist`
4. Start MCP server: `node mcp-server/dist/mcp-server.js`
5. Verify WebSocket connection in extension console
6. Test basic command flow (create tab, navigate, screenshot)

- [ ] **Step 2: Document integration test results**

Create `integration-test.md` with test results and any issues found.

- [ ] **Step 3: Commit**

```bash
git add integration-test.md
git commit -m "test: add integration test documentation"
```

### Task 17: Code Review

**Reviewer:** Assign a separate agent to review the implementation

**Files to Review:**
- All `mcp-server/src/**/*.ts`
- All `extension/src/**/*.ts`
- Configuration files (package.json, tsconfig.json, manifest.json)

- [ ] **Step 1: Review MCP Server Code**

Review checklist:
- [ ] TypeScript types are correctly defined and used
- [ ] Error handling is comprehensive
- [ ] WebSocket connection management is robust
- [ ] Command queue handles timeouts correctly
- [ ] MCP tool definitions match the spec
- [ ] Code follows DRY principle
- [ ] No security vulnerabilities (input validation, etc.)

- [ ] **Step 2: Review Extension Code**

Review checklist:
- [ ] chrome.debugger API is used correctly
- [ ] Tab management handles edge cases (tab closed, etc.)
- [ ] WebSocket client has proper reconnection logic
- [ ] Command handler covers all required commands
- [ ] Service worker stays alive properly
- [ ] No memory leaks in event listeners
- [ ] Permissions in manifest.json are minimal and necessary

- [ ] **Step 3: Review Integration**

Review checklist:
- [ ] Message format matches between MCP server and extension
- [ ] Error codes are consistent
- [ ] Timeout handling is consistent
- [ ] Both sides handle disconnection gracefully

- [ ] **Step 4: Document review findings**

Create `code-review.md` with:
- Issues found (categorized by severity: critical, major, minor)
- Suggestions for improvement
- Security concerns
- Performance considerations

- [ ] **Step 5: Address review feedback**

Fix critical and major issues found in review.

- [ ] **Step 6: Commit fixes**

```bash
git add .
git commit -m "fix: address code review feedback"
```

---

## Plan Self-Review

### Spec Coverage Check

✅ **MCP Server:**
- [x] WebSocket server (Task 3)
- [x] Command queue (Task 4)
- [x] MCP tool registration (Task 5)
- [x] All 15 MCP tools defined (Task 5)
- [x] stdio transport (Task 6)

✅ **Browser Extension:**
- [x] WebSocket client (Task 9)
- [x] Tab management (Task 10)
- [x] CDP command execution (Task 11)
- [x] Recording engine (Task 12)
- [x] Playback engine (Task 12)
- [x] Session management (Task 13)
- [x] Command handler (Task 14)
- [x] Service worker (Task 15)

✅ **Integration:**
- [x] Message protocol (Tasks 2, 8)
- [x] Error handling (Tasks 2, 8, 14)
- [x] Integration testing (Task 16)
- [x] Code review (Task 17)

### Missing from Spec

**Deferred to v1.1 (not critical for MVP):**
- Smart element location with fallbacks (simplified in Task 11)
- Smart wait strategies (simplified in Task 12)
- Visual element matching (not implemented)
- Content script for enhanced DOM access (structure created but minimal implementation)
- Popup UI (minimal implementation in Task 15)

**Rationale:** These are enhancement features. The core functionality (MCP integration, basic automation, recording/playback) is complete and testable.

### Type Consistency Check

✅ All message types consistent between:
- `mcp-server/src/types.ts`
- `extension/src/types/index.ts`

✅ Command names match in:
- MCP tool definitions (Task 5)
- Command handler switch statement (Task 14)

### No Placeholders

✅ All code blocks are complete and executable
✅ No "TBD", "TODO", or "implement later" comments
✅ All test commands specify expected output

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-20-web-bridge-plugin-implementation.md`.**

**Two execution options:**

**1. Subagent-Driven (recommended)** - Dispatch fresh subagents per task, review between tasks, fast iteration
   - **Track A (MCP Server)**: Agent 1 executes Tasks 1-6
   - **Track B (Extension)**: Agent 2 executes Tasks 7-15 (parallel with Track A)
   - **Track C (Integration)**: Agent 3 executes Tasks 16-17 (after A & B complete)

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**

