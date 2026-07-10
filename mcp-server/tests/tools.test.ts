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

  it('should include interact tool with click action', () => {
    const tools = getToolDefinitions();
    const interactTool = tools.find(t => t.name === 'interact');
    expect(interactTool).toBeDefined();
    expect(interactTool?.inputSchema.properties).toHaveProperty('action');
    expect(interactTool?.inputSchema.properties.action.enum).toContain('click');
  });

  it('should include lightweight content tools', () => {
    const tools = getToolDefinitions();
    const getContentTool = tools.find(t => t.name === 'get_content');
    const waitForElementTool = tools.find(t => t.name === 'wait_for_element');

    expect(getContentTool).toBeDefined();
    expect(getContentTool?.inputSchema.properties.mode.enum).toEqual([
      'html',
      'text',
      'structured',
      'markdown'
    ]);

    expect(waitForElementTool).toBeDefined();
    expect(waitForElementTool?.inputSchema.properties).toHaveProperty('selector');
    expect(waitForElementTool?.inputSchema.required).toContain('selector');
  });

  it('documents console history and restricted-page fallback semantics', () => {
    const tool = getToolDefinitions().find(candidate => candidate.name === 'get_console_logs');
    expect(tool?.description).toMatch(/document_start/);
    expect(tool?.description).toMatch(/existing tabs need one refresh after extension reload/i);
    expect(tool?.description).toMatch(/restricted pages fall back to CDP-from-now capture/i);
  });

  it('exposes tab ownership tools and warns that storage shares a browser profile', () => {
    const tools = getToolDefinitions();
    for (const name of ['claim_tab', 'release_tab']) {
      const tool = tools.find(candidate => candidate.name === name);
      expect(tool?.inputSchema.required).toEqual(['tabId']);
      expect(tool?.inputSchema.properties.tabId.type).toBe('number');
    }
    expect(tools.find(tool => tool.name === 'manage_storage')?.description)
      .toMatch(/cookie and storage mutations share the same browser profile across Agent sessions/i);
  });
});
