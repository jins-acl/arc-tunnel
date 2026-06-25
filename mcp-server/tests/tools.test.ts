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
});
