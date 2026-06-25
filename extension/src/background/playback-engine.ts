// extension/src/background/playback-engine.ts
import { Recording, Action } from '../types';
import { DebuggerController } from './debugger-controller';

export class PlaybackEngine {
  constructor(private debuggerController: DebuggerController) {}

  async replay(recordingId: string, tabId: number): Promise<void> {
    // Load recording from storage
    const result = await chrome.storage.local.get(`recording_${recordingId}`);
    const recording = result[`recording_${recordingId}`] as Recording | undefined;

    if (!recording) {
      throw new Error('Recording not found');
    }

    console.log(`Replaying recording: ${recordingId} (${recording.actions.length} actions)`);

    for (let i = 0; i < recording.actions.length; i++) {
      const action = recording.actions[i];
      console.log(`Action ${i + 1}/${recording.actions.length}: ${action.type}`);
      await this.executeAction(action, tabId);
      // Small delay between actions for stability
      await this.sleep(200);
    }

    console.log('Playback complete');
  }

  private async executeAction(action: Action, tabId: number): Promise<void> {
    switch (action.type) {
      case 'navigate':
        if (action.url) {
          await this.debuggerController.navigate(tabId, action.url);
          // Wait for page load
          await this.sleep(2000);
        }
        break;
      case 'click':
        if (action.target) {
          await this.debuggerController.click(tabId, action.target.primary);
        }
        break;
      case 'type':
        if (action.target && action.text) {
          await this.debuggerController.type(tabId, action.target.primary, action.text);
        }
        break;
      case 'wait':
        await this.sleep(1000);
        break;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
