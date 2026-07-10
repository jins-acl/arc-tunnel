import { ConsoleCapture } from './console-capture';
import { TabManager } from './tab-manager';

export function bindConsoleCaptureCleanup(
  tabManager: Pick<TabManager, 'onLifecycle'>,
  consoleCapture: Pick<ConsoleCapture, 'disableForTab'>
): () => void {
  return tabManager.onLifecycle((event, data) => {
    if (event === 'tab_removed' && typeof data.tabId === 'number') {
      consoleCapture.disableForTab(data.tabId);
    }
  });
}
