// extension/src/background/recording-engine.ts
import { Recording, Action } from '../types';

export class RecordingEngine {
  private isRecording = false;
  private currentRecording: Recording | null = null;
  private startTime = 0;

  async startRecording(tabId: number): Promise<string> {
    const recordingId = crypto.randomUUID();
    this.startTime = Date.now();

    this.currentRecording = {
      id: recordingId,
      name: `Recording ${new Date().toISOString()}`,
      createdAt: new Date().toISOString(),
      actions: [],
      metadata: {
        startUrl: '',
        duration: 0,
        actionCount: 0
      }
    };

    this.isRecording = true;
    console.log(`Started recording: ${recordingId}`);
    return recordingId;
  }

  async stopRecording(): Promise<Recording> {
    if (!this.currentRecording) {
      throw new Error('No active recording');
    }

    this.isRecording = false;
    const duration = Date.now() - this.startTime;

    this.currentRecording.metadata.duration = duration;
    this.currentRecording.metadata.actionCount = this.currentRecording.actions.length;

    const recording = this.currentRecording;
    this.currentRecording = null;

    // Save to storage
    await chrome.storage.local.set({
      [`recording_${recording.id}`]: recording
    });

    console.log(`Stopped recording: ${recording.id}`);
    return recording;
  }

  recordAction(action: Action): void {
    if (this.isRecording && this.currentRecording) {
      action.timestamp = Date.now() - this.startTime;
      this.currentRecording.actions.push(action);
    }
  }

  isCurrentlyRecording(): boolean {
    return this.isRecording;
  }
}
