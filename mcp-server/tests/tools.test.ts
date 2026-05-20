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
