// Arc Tunnel Content Script
// Injected into every page to provide DOM inspection and element targeting support.
// Communicates with the background service worker via chrome.runtime messaging.

import { buildSelector } from '../shared/selector-builder';

interface ElementInfo {
  tag: string;
  id: string;
  className: string;
  text: string;
  rect: { x: number; y: number; width: number; height: number };
  selector: string;
}

function getElementInfo(el: Element): ElementInfo {
  const rect = el.getBoundingClientRect();
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || '',
    className: (el as HTMLElement).className || '',
    text: (el.textContent || '').trim().substring(0, 200),
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    selector: buildSelector(el)
  };
}

// Handle messages from background script
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'inspect_element') {
    const el = document.querySelector(message.selector);
    sendResponse(el ? { found: true, info: getElementInfo(el) } : { found: false });
    return true;
  }

  if (message.type === 'list_interactive_elements') {
    const selectors = 'a, button, input, textarea, select, [role="button"], [role="link"], [onclick]';
    const elements = Array.from(document.querySelectorAll(selectors)).slice(0, 100);
    sendResponse({
      elements: elements.map(getElementInfo)
    });
    return true;
  }

  if (message.type === 'get_page_info') {
    sendResponse({
      url: window.location.href,
      title: document.title,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      viewport: { width: window.innerWidth, height: window.innerHeight }
    });
    return true;
  }

  // Unrecognized message type — keep channel open for async
  return false;
});
