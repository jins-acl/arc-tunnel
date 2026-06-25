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
    // ─── Core tools (Playwright-inspired) ───

    {
      name: 'snapshot',
      description: 'Capture a lightweight accessibility snapshot of the page with ref-based element targeting. Returns a YAML tree of interactive elements (buttons, links, inputs) labeled with refs like e1, e2. Use these refs with the `interact` tool for precise, token-efficient element targeting.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'number', description: 'Tab ID' }
        },
        required: ['tabId']
      }
    },
    {
      name: 'interact',
      description: 'Perform mouse or keyboard interaction on a page element identified by a snapshot ref (e.g. "e15"). Supports click, double_click, hover, type, press (keyboard key), check, uncheck. Run `snapshot` first to get refs.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'number', description: 'Tab ID' },
          action: {
            type: 'string',
            enum: ['click', 'double_click', 'hover', 'type', 'press', 'check', 'uncheck'],
            description: 'Interaction type'
          },
          target: { type: 'string', description: 'Ref from snapshot (e.g. "e15"). Required except for action=press.' },
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

    // ─── Utility tools ───

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
      name: 'get_content',
      description: 'Extract page content without interacting with the page. Supports html, text, structured, and markdown modes.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'number', description: 'Tab ID' },
          mode: {
            type: 'string',
            enum: ['html', 'text', 'structured', 'markdown'],
            description: 'Content extraction mode. Defaults to text.'
          }
        },
        required: ['tabId']
      }
    },
    {
      name: 'wait_for_element',
      description: 'Wait for an element matching a CSS selector to appear in the tab.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'number', description: 'Tab ID' },
          selector: { type: 'string', description: 'CSS selector to wait for' },
          timeout: { type: 'number', description: 'Timeout in ms. Defaults to 10000.' }
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
