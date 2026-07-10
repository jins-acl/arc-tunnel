'use strict';

function parseToolResult(result) {
  if (!result || !Array.isArray(result.content)) {
    throw new Error('Tool returned invalid MCP content');
  }

  const images = result.content.filter(item => item?.type === 'image');
  const texts = result.content
    .filter(item => item?.type === 'text' && typeof item.text === 'string')
    .map(item => item.text);
  const parsedTexts = texts.map(text => {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  });
  const value = parsedTexts.length <= 1 ? parsedTexts[0] : parsedTexts;

  if (result.isError) {
    const details = parsedTexts.find(item => item && typeof item === 'object' && !Array.isArray(item)) || {};
    const error = new Error(typeof details.error === 'string' ? details.error : 'Tool failed');
    Object.assign(error, details);
    throw error;
  }

  return { value, images, texts };
}

module.exports = { parseToolResult };
