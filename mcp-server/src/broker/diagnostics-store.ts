export type DiagnosticLevel = 'info' | 'warning' | 'error';
export type DiagnosticCategory = 'broker' | 'connection' | 'ownership' | 'recovery';
export type RecoveryPhase = 'idle' | 'running' | 'failed';

export interface DiagnosticEvent {
  sequence: number;
  timestamp: number;
  level: DiagnosticLevel;
  category: DiagnosticCategory;
  code: string;
  summary: string;
}

export interface RuntimeDiagnostics {
  now: number;
  connectedAgents: number;
  graceAgents: number;
  claimedTabs: number;
  pendingCommands: number;
}

export interface RecoveryState {
  inventorySync: RecoveryPhase;
  recordingCleanup: RecoveryPhase;
}

export interface DiagnosticsSnapshot {
  broker: {
    pid: number;
    port: number;
    protocolVersion: number;
    uptimeMs: number;
  };
  extension: {
    connected: boolean;
    generation: number;
    reconnectPhase: RecoveryPhase;
    lastSyncAt: number | null;
  };
  agents: { connected: number; grace: number };
  workload: { claimedTabs: number; pendingCommands: number };
  recovery: RecoveryState;
  recentError: Pick<DiagnosticEvent, 'timestamp' | 'code' | 'summary'> | null;
}

interface ExtensionState {
  connected: boolean;
  generation: number;
  reconnectPhase: RecoveryPhase;
  lastSyncAt: number | null;
}

export class DiagnosticsStore {
  private readonly events: DiagnosticEvent[] = [];
  private readonly listeners = new Set<(event: DiagnosticEvent) => void>();
  private sequence = 0;
  private extension: ExtensionState = {
    connected: false,
    generation: 0,
    reconnectPhase: 'idle',
    lastSyncAt: null
  };
  private recovery: RecoveryState = {
    inventorySync: 'idle',
    recordingCleanup: 'idle'
  };
  private recentError: Pick<DiagnosticEvent, 'timestamp' | 'code' | 'summary'> | null = null;

  constructor(private readonly broker: { pid: number; port: number; protocolVersion: number; startedAt: number }) {}

  record(input: Omit<DiagnosticEvent, 'sequence' | 'timestamp'> & { timestamp?: number }): DiagnosticEvent {
    const event: DiagnosticEvent = {
      ...input,
      sequence: ++this.sequence,
      timestamp: input.timestamp ?? Date.now()
    };
    this.events.push(event);
    if (this.events.length > 200) this.events.splice(0, this.events.length - 200);
    if (event.level === 'error') {
      this.recentError = { timestamp: event.timestamp, code: event.code, summary: event.summary };
    }
    for (const listener of this.listeners) listener(event);
    return event;
  }

  eventsAfter(sequence: number): { reset: boolean; events: DiagnosticEvent[] } {
    const first = this.events[0]?.sequence ?? this.sequence + 1;
    return {
      reset: sequence < first - 1,
      events: this.events.filter(event => event.sequence > sequence)
    };
  }

  subscribe(listener: (event: DiagnosticEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setExtensionState(state: ExtensionState): void {
    this.extension = { ...state };
  }

  setInventorySync(state: RecoveryPhase): void {
    this.recovery.inventorySync = state;
  }

  setRecordingCleanup(state: RecoveryPhase): void {
    this.recovery.recordingCleanup = state;
  }

  snapshot(runtime: RuntimeDiagnostics): DiagnosticsSnapshot {
    return {
      broker: {
        pid: this.broker.pid,
        port: this.broker.port,
        protocolVersion: this.broker.protocolVersion,
        uptimeMs: Math.max(0, runtime.now - this.broker.startedAt)
      },
      extension: { ...this.extension },
      agents: { connected: runtime.connectedAgents, grace: runtime.graceAgents },
      workload: { claimedTabs: runtime.claimedTabs, pendingCommands: runtime.pendingCommands },
      recovery: { ...this.recovery },
      recentError: this.recentError && { ...this.recentError }
    };
  }
}
