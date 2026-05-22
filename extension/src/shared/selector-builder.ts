// Shared selector builder — used by content-script.ts and recording-engine.ts
// Keep the JS string constant and the TS function in sync.

export const BUILD_SELECTOR_SCRIPT = `
function buildSelector(el) {
  if (el.id && !/^\\d/.test(el.id) && el.id.length < 36) return '#' + CSS.escape(el.id);
  var path = [];
  while (el && el.nodeType === 1 && path.length < 5) {
    var tag = el.tagName.toLowerCase();
    if (el.className && typeof el.className === 'string') {
      var classes = el.className.trim().split(/\\s+/).slice(0, 3);
      if (classes.length) tag += '.' + classes.map(function(c) { return CSS.escape(c); }).join('.');
    }
    path.unshift(tag);
    el = el.parentElement;
  }
  return path.join(' > ');
}
`;

export function buildSelector(el: Element): string {
  if (el.id && !/^\d/.test(el.id) && el.id.length < 36) return '#' + CSS.escape(el.id);
  const path: string[] = [];
  let curr: Element | null = el;
  while (curr && curr.nodeType === 1 && path.length < 5) {
    const tag = curr.tagName.toLowerCase();
    if (curr.className && typeof curr.className === 'string') {
      const classes = curr.className.trim().split(/\s+/).slice(0, 3);
      if (classes.length) {
        path.unshift(tag + '.' + classes.map(c => CSS.escape(c)).join('.'));
        curr = curr.parentElement;
        continue;
      }
    }
    path.unshift(tag);
    curr = curr.parentElement;
  }
  return path.join(' > ');
}
