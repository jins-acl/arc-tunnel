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
    // ─── New aggregated tools (Playwright-inspired) ───

    {
      name: 'snapshot',
      description: 'Capture a lightweight accessibility snapshot of the page with ref-based element targeting. Returns a YAML tree of interactive elements (buttons, links, inputs) labeled with refs like e1, e2. Use these refs with the `interact` tool for precise, token-efficient element targeting.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'number', description: 'Tab ID' },
          depth: { type: 'number', description: 'Max DOM traversal depth (default 10)' },
          includeBoxes: { type: 'boolean', description: 'Include element bounding boxes in output' }
        },
        required: ['tabId']
      }
    },
    {
      name: 'interact',
      description: 'Perform mouse or keyboard interaction on a page element. Supports click, double_click, hover, type, press (keyboard key), check, uncheck. Target can be a CSS selector or a ref (e.g. "e15") from a snapshot.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'number', description: 'Tab ID' },
          action: {
            type: 'string',
            enum: ['click', 'double_click', 'hover', 'type', 'press', 'check', 'uncheck'],
            description: 'Interaction type'
          },
          target: { type: 'string', description: 'CSS selector or ref (e.g. "e15") from snapshot' },
          text: { type: 'string', description: 'Text to type (required when action=type)' },
          key: { type: 'string', description: 'Key to press, e.g. "Enter", "Tab", "Escape" (required when action=press)' },
          timeout: { type: 'number', description: 'Timeout in ms for waiting element to become actionable (default 5000)' }
        },
        required: ['tabId', 'action', 'target']
      }
    },
    {
      name: 'navigate',
      description: 'Navigate the browser: goto a URL, go back, go forward, or reload the current page.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'number', description: 'Tab ID' },
          action: {
            type: 'string',
            enum: ['goto', 'go_back', 'go_forward', 'reload'],
            description: 'Navigation action'
          },
          url: { type: 'string', description: 'URL to navigate to (required when action=goto)' }
        },
        required: ['tabId', 'action']
      }
    },
    {
      name: 'get_console_logs',
      description: 'Retrieve captured browser console logs (info, warning, error) for the specified tab.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'number', description: 'Tab ID' },
          minLevel: {
            type: 'string',
            enum: ['info', 'warning', 'error'],
            description: 'Minimum log level to include. Each level includes more severe levels. Defaults to all.'
          }
        },
        required: ['tabId']
      }
    },
    {
      name: 'manage_storage',
      description: 'Manage cookies, localStorage, or sessionStorage. Supports list, get, set, delete, clear actions.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'number', description: 'Tab ID' },
          type: {
            type: 'string',
            enum: ['cookie', 'local_storage', 'session_storage'],
            description: 'Storage type'
          },
          action: {
            type: 'string',
            enum: ['list', 'get', 'set', 'delete', 'clear'],
            description: 'Action to perform'
          },
          key: { type: 'string', description: 'Key name (for get/set/delete)' },
          value: { type: 'string', description: 'Value to set (for set)' },
          filterDomain: { type: 'string', description: 'Cookie domain filter (for cookie list)' },
          options: {
            type: 'object',
            description: 'Cookie options: domain, path, secure, httpOnly',
            properties: {
              domain: { type: 'string' },
              path: { type: 'string' },
              secure: { type: 'boolean' },
              httpOnly: { type: 'boolean' }
            }
          }
        },
        required: ['tabId', 'type', 'action']
      }
    },

    // ─── Legacy tools (kept for backward compatibility) ───

    {
      name: 'click',
      description: '[Legacy] Click an element. Consider using `interact` with action="click" instead.',
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
      description: '[Legacy] Type text into an element. Consider using `interact` with action="type" instead.',
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
      description: 'Execute JavaScript in the tab. WARNING: scripts have full page access (DOM, cookies, storage, network). Use with caution.',
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
      description: 'Start recording user actions (click, type, navigate)',
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
      description: 'Stop recording and return the recorded actions',
      inputSchema: {
        type: 'object',
        properties: {},
        required: []
      }
    },
    {
      name: 'replay_recording',
      description: 'Replay a recorded session',
      inputSchema: {
        type: 'object',
        properties: {
          recordingId: { type: 'string', description: 'Recording ID' },
          tabId: { type: 'number', description: 'Tab to replay in (auto-selects if omitted)' }
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
