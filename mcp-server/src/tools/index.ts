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
