export const CONSOLE_BUFFER_LIMIT = 500;
const ARGUMENT_LIMIT = 4_096;
const ENTRY_LIMIT = 16_384;
const BUFFER_KEY = Symbol.for('arc-tunnel.console-buffer.v1');

export interface BufferedConsoleEntry {
  level: 'debug' | 'info' | 'warning' | 'error';
  text: string;
  source: string;
  timestamp: number;
}

interface ConsoleBufferState {
  logs: BufferedConsoleEntry[];
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit) : value;
}

function renderValue(value: unknown, seen: WeakSet<object> = new WeakSet(), nested = false): string {
  try {
    if (typeof value === 'string') return nested ? `"${value}"` : value;
    if (typeof value === 'function') return '[Function]';
    if (value === null || typeof value !== 'object') return String(value);

    if (value instanceof Error) {
      const nameDescriptor = Object.getOwnPropertyDescriptor(value, 'name');
      const messageDescriptor = Object.getOwnPropertyDescriptor(value, 'message');
      const name = nameDescriptor && 'value' in nameDescriptor && typeof nameDescriptor.value === 'string'
        ? nameDescriptor.value
        : 'Error';
      const message = messageDescriptor && 'value' in messageDescriptor &&
        typeof messageDescriptor.value === 'string' ? messageDescriptor.value : '';
      return message ? `${name}: ${message}` : name;
    }

    if (seen.has(value)) return '[Circular]';
    seen.add(value);

    if (Array.isArray(value)) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
      const length = lengthDescriptor && 'value' in lengthDescriptor &&
        typeof lengthDescriptor.value === 'number' ? lengthDescriptor.value : 0;
      const rendered: string[] = [];
      let renderedLength = 2;
      for (let index = 0; index < length && renderedLength < ARGUMENT_LIMIT; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        const item = !descriptor ? '' : 'value' in descriptor
          ? renderValue(descriptor.value, seen, true)
          : '[Getter]';
        rendered.push(item);
        renderedLength += item.length + 1;
      }
      if (rendered.length < length) rendered.push('…');
      return `[${rendered.join(',')}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      const rendered: string[] = [];
      let renderedLength = 2;
      const keys = Reflect.ownKeys(value);
      for (const key of keys) {
        if (typeof key !== 'string' || renderedLength >= ARGUMENT_LIMIT) continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable) continue;
        const item = 'value' in descriptor
          ? renderValue(descriptor.value, seen, true)
          : '[Getter]';
        const pair = `${key}:${item}`;
        rendered.push(pair);
        renderedLength += pair.length + 1;
      }
      if (rendered.length < keys.length) rendered.push('…');
      return `{${rendered.join(',')}}`;
    }
    return '[Object]';
  } catch {
    return '[Unserializable]';
  }
}

function renderArguments(args: unknown[]): string {
  return truncate(args.map(value => truncate(renderValue(value), ARGUMENT_LIMIT)).join(' '), ENTRY_LIMIT);
}

export function readConsoleBuffer(target: any): { installed: boolean; logs: BufferedConsoleEntry[] } {
  const state = target[BUFFER_KEY] as ConsoleBufferState | undefined;
  return { installed: Boolean(state), logs: state ? state.logs.slice() : [] };
}

export function installConsoleHook(target: any): void {
  if (target[BUFFER_KEY]) return;

  const state: ConsoleBufferState = { logs: [] };
  Object.defineProperty(target, BUFFER_KEY, { value: state, configurable: false });

  for (const [method, level] of [
    ['debug', 'debug'],
    ['log', 'info'],
    ['info', 'info'],
    ['warn', 'warning'],
    ['error', 'error']
  ] as const) {
    const original = target.console[method];
    target.console[method] = function (...args: unknown[]) {
      state.logs.push({
        level,
        text: renderArguments(args),
        source: 'page',
        timestamp: Date.now()
      });
      if (state.logs.length > CONSOLE_BUFFER_LIMIT) {
        state.logs.splice(0, state.logs.length - CONSOLE_BUFFER_LIMIT);
      }
      return Reflect.apply(original, this, args);
    };
  }
}

if (typeof window !== 'undefined') installConsoleHook(window);
