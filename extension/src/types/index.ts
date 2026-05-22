// extension/src/types/index.ts

// Message types (matching MCP server)
export interface CommandMessage {
  id: string;
  type: 'command';
  command: string;
  params: any;
  timeout?: number;
}

export interface ResponseMessage {
  id: string;
  type: 'response';
  success: boolean;
  result?: any;
  error?: ErrorInfo;
}

export interface EventMessage {
  type: 'event';
  event: string;
  data: any;
  timestamp: number;
}

export interface ErrorInfo {
  code: string;
  message: string;
  details?: any;
}

// Tab management
export interface TabInfo {
  id: number;
  url: string;
  title: string;
  debuggerAttached: boolean;
}

// Recording types
export interface Recording {
  id: string;
  name: string;
  createdAt: string;
  actions: Action[];
  metadata: RecordingMetadata;
}

export interface Action {
  type: 'navigate' | 'click' | 'type' | 'wait';
  timestamp: number;
  tabId?: number;
  pageUrl?: string;
  target?: ElementTarget;
  url?: string;
  text?: string;
  waitConditions?: WaitConditions;
  context?: {
    selector: string;
    tag: string;
    text: string;
    x: number;
    y: number;
  };
}

export interface ElementTarget {
  primary: string;
  fallbacks?: string[];
  visual?: {
    screenshot: string;
    boundingBox: BoundingBox;
  };
  context?: {
    nearbyText: string;
    parentTag: string;
    role: string;
  };
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WaitConditions {
  networkIdle: boolean;
  domStable: boolean;
  elementVisible: boolean;
  elementEnabled: boolean;
  customCondition?: string;
}

export interface RecordingMetadata {
  startUrl: string;
  duration: number;
  actionCount: number;
}

// Session types
export interface SessionData {
  id: string;
  name: string;
  tabs: TabState[];
  savedAt: string;
}

export interface TabState {
  url: string;
  cookies: chrome.cookies.Cookie[];
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
}

// Config
export interface ExtensionConfig {
  wsUrl: string;
  autoReconnect: boolean;
  defaultTimeout: number;
  recordingOptions: {
    captureVisual: boolean;
    captureContext: boolean;
  };
}
