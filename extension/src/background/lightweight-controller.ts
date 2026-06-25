// extension/src/background/lightweight-controller.ts

type StructuredContent = {
  title: string;
  url: string;
  text: string;
  links: Array<{ text: string; href: string }>;
  forms: Array<{
    id: string;
    action: string;
    method: string;
    fields: Array<{ name: string; type: string }>;
  }>;
  images: Array<{ src: string; alt: string }>;
  headings: Array<{ tag: string; text: string }>;
};

export class LightweightController {
  async executeScript(tabId: number, script: string): Promise<any> {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (source: string) => {
        return (0, eval)(source);
      },
      args: [script]
    });

    return results[0]?.result;
  }

  async getContent(tabId: number, mode: string): Promise<any> {
    switch (mode) {
      case 'html':
        return await this.executeScript(tabId, 'document.documentElement.outerHTML');
      case 'text':
        return await this.executeScript(tabId, 'document.body ? document.body.innerText : ""');
      case 'structured':
        return await this.getStructuredContent(tabId);
      case 'markdown':
        return await this.getMarkdownContent(tabId);
      default:
        throw new Error(`Unknown mode: ${mode}`);
    }
  }

  async waitForElement(tabId: number, selector: string, timeout: number = 10000): Promise<boolean> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      const exists = await this.executeScript(
        tabId,
        `document.querySelector(${JSON.stringify(selector)}) !== null`
      );
      if (exists) return true;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    return false;
  }

  private async getStructuredContent(tabId: number): Promise<StructuredContent> {
    return await this.executeScript(tabId, `
      (function() {
        return {
          title: document.title,
          url: window.location.href,
          text: document.body ? document.body.innerText.substring(0, 50000) : '',
          links: Array.from(document.querySelectorAll('a')).slice(0, 50).map(function(a) {
            return { text: (a.textContent || '').trim().substring(0, 100), href: a.href || '' };
          }),
          forms: Array.from(document.querySelectorAll('form')).slice(0, 10).map(function(f) {
            return {
              id: f.id || '',
              action: f.action || '',
              method: f.method || '',
              fields: Array.from(f.elements).slice(0, 10).map(function(e) {
                return { name: e.name || '', type: e.type || '' };
              })
            };
          }),
          images: Array.from(document.querySelectorAll('img')).slice(0, 20).map(function(img) {
            return { src: img.src || '', alt: img.alt || '' };
          }),
          headings: Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).slice(0, 30).map(function(h) {
            return { tag: h.tagName.toLowerCase(), text: (h.textContent || '').trim().substring(0, 200) };
          })
        };
      })()
    `);
  }

  private async getMarkdownContent(tabId: number): Promise<string> {
    return await this.executeScript(tabId, `
      (function() {
        var md = '# ' + document.title + '\\n\\n';
        var bodyText = document.body ? document.body.innerText : '';
        md += bodyText.substring(0, 500000);
        return md;
      })()
    `);
  }
}
