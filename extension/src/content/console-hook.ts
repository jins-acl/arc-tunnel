export const CONSOLE_BUFFER_LIMIT = 500;
const ARGUMENT_LIMIT = 4_096;
const ENTRY_LIMIT = 16_384;
const BUFFER_KEY = Symbol.for('arc-tunnel.console-buffer.v1');
const SAFE_APPLY = Reflect.apply;
const SAFE_OWN_KEYS = Reflect.ownKeys;
const SAFE_ARRAY_IS_ARRAY = Array.isArray;
const SAFE_ARRAY_JOIN = Array.prototype.join;
const SAFE_ARRAY_PUSH = Array.prototype.push;
const SAFE_ARRAY_SLICE = Array.prototype.slice;
const SAFE_ARRAY_SPLICE = Array.prototype.splice;
const SAFE_DEFINE_PROPERTY = Object.defineProperty;
const SAFE_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const SAFE_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const SAFE_OBJECT_PROTOTYPE = Object.prototype;
const SAFE_ERROR_PROTOTYPE = Error.prototype;
const SAFE_STRING = String;
const SAFE_STRING_SLICE = String.prototype.slice;
const SAFE_DATE_NOW = Date.now;
const SAFE_WEAK_SET = WeakSet;
const SAFE_WEAK_SET_ADD = WeakSet.prototype.add;
const SAFE_WEAK_SET_HAS = WeakSet.prototype.has;

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
  return value.length > limit ? SAFE_APPLY(SAFE_STRING_SLICE, value, [0, limit]) : value;
}

function append<T>(values: T[], value: T): void {
  SAFE_APPLY(SAFE_ARRAY_PUSH, values, [value]);
}

function join(values: string[], separator: string): string {
  return SAFE_APPLY(SAFE_ARRAY_JOIN, values, [separator]);
}

function isError(value: object): boolean {
  let prototype = SAFE_GET_PROTOTYPE_OF(value);
  for (let depth = 0; prototype && depth < 100; depth++) {
    if (prototype === SAFE_ERROR_PROTOTYPE) return true;
    prototype = SAFE_GET_PROTOTYPE_OF(prototype);
  }
  return false;
}

function renderValue(
  value: unknown,
  seen: WeakSet<object> = new SAFE_WEAK_SET(),
  nested = false
): string {
  try {
    if (typeof value === 'string') return nested ? `"${value}"` : value;
    if (typeof value === 'function') return '[Function]';
    if (value === null || typeof value !== 'object') return SAFE_STRING(value);

    if (isError(value)) {
      const nameDescriptor = SAFE_GET_OWN_PROPERTY_DESCRIPTOR(value, 'name');
      const messageDescriptor = SAFE_GET_OWN_PROPERTY_DESCRIPTOR(value, 'message');
      const name = nameDescriptor && 'value' in nameDescriptor && typeof nameDescriptor.value === 'string'
        ? nameDescriptor.value
        : 'Error';
      const message = messageDescriptor && 'value' in messageDescriptor &&
        typeof messageDescriptor.value === 'string' ? messageDescriptor.value : '';
      return message ? `${name}: ${message}` : name;
    }

    if (SAFE_APPLY(SAFE_WEAK_SET_HAS, seen, [value])) return '[Circular]';
    SAFE_APPLY(SAFE_WEAK_SET_ADD, seen, [value]);

    if (SAFE_ARRAY_IS_ARRAY(value)) {
      const lengthDescriptor = SAFE_GET_OWN_PROPERTY_DESCRIPTOR(value, 'length');
      const length = lengthDescriptor && 'value' in lengthDescriptor &&
        typeof lengthDescriptor.value === 'number' ? lengthDescriptor.value : 0;
      const rendered: string[] = [];
      let renderedLength = 2;
      for (let index = 0; index < length && renderedLength < ARGUMENT_LIMIT; index++) {
        const descriptor = SAFE_GET_OWN_PROPERTY_DESCRIPTOR(value, SAFE_STRING(index));
        const item = !descriptor ? '' : 'value' in descriptor
          ? renderValue(descriptor.value, seen, true)
          : '[Getter]';
        append(rendered, item);
        renderedLength += item.length + 1;
      }
      if (rendered.length < length) append(rendered, '…');
      return `[${join(rendered, ',')}]`;
    }

    const prototype = SAFE_GET_PROTOTYPE_OF(value);
    if (prototype === SAFE_OBJECT_PROTOTYPE || prototype === null) {
      const rendered: string[] = [];
      let renderedLength = 2;
      const keys = SAFE_OWN_KEYS(value);
      for (const key of keys) {
        if (typeof key !== 'string' || renderedLength >= ARGUMENT_LIMIT) continue;
        const descriptor = SAFE_GET_OWN_PROPERTY_DESCRIPTOR(value, key);
        if (!descriptor?.enumerable) continue;
        const item = 'value' in descriptor
          ? renderValue(descriptor.value, seen, true)
          : '[Getter]';
        const pair = `${key}:${item}`;
        append(rendered, pair);
        renderedLength += pair.length + 1;
      }
      if (rendered.length < keys.length) append(rendered, '…');
      return `{${join(rendered, ',')}}`;
    }
    return '[Object]';
  } catch {
    return '[Unserializable]';
  }
}

function renderArguments(args: unknown[]): string {
  const rendered: string[] = [];
  for (let index = 0; index < args.length; index++) {
    append(rendered, truncate(renderValue(args[index]), ARGUMENT_LIMIT));
  }
  return truncate(join(rendered, ' '), ENTRY_LIMIT);
}

export function readConsoleBuffer(target: any): { installed: boolean; logs: BufferedConsoleEntry[] } {
  const stateDescriptor = SAFE_GET_OWN_PROPERTY_DESCRIPTOR(target, BUFFER_KEY);
  if (!stateDescriptor || !('value' in stateDescriptor) || !stateDescriptor.value) {
    return { installed: false, logs: [] };
  }
  try {
    const logsDescriptor = SAFE_GET_OWN_PROPERTY_DESCRIPTOR(stateDescriptor.value, 'logs');
    if (!logsDescriptor || !('value' in logsDescriptor) || !SAFE_ARRAY_IS_ARRAY(logsDescriptor.value)) {
      return { installed: true, logs: [] };
    }
    return {
      installed: true,
      logs: SAFE_APPLY(SAFE_ARRAY_SLICE, logsDescriptor.value, [])
    };
  } catch {
    return { installed: true, logs: [] };
  }
}

export function installConsoleHook(target: any): void {
  if (SAFE_GET_OWN_PROPERTY_DESCRIPTOR(target, BUFFER_KEY)) return;

  const state: ConsoleBufferState = { logs: [] };
  SAFE_DEFINE_PROPERTY(target, BUFFER_KEY, { value: state, configurable: false });

  for (const [method, level] of [
    ['debug', 'debug'],
    ['log', 'info'],
    ['info', 'info'],
    ['warn', 'warning'],
    ['error', 'error']
  ] as const) {
    const original = target.console[method];
    target.console[method] = function (...args: unknown[]) {
      try {
        const logsDescriptor = SAFE_GET_OWN_PROPERTY_DESCRIPTOR(state, 'logs');
        if (logsDescriptor && 'value' in logsDescriptor && SAFE_ARRAY_IS_ARRAY(logsDescriptor.value)) {
          const logs = logsDescriptor.value as BufferedConsoleEntry[];
          SAFE_APPLY(SAFE_ARRAY_PUSH, logs, [{
            level,
            text: renderArguments(args),
            source: 'page',
            timestamp: SAFE_DATE_NOW()
          }]);
          const lengthDescriptor = SAFE_GET_OWN_PROPERTY_DESCRIPTOR(logs, 'length');
          const length = lengthDescriptor && 'value' in lengthDescriptor
            ? lengthDescriptor.value
            : 0;
          if (typeof length === 'number' && length > CONSOLE_BUFFER_LIMIT) {
            SAFE_APPLY(SAFE_ARRAY_SPLICE, logs, [0, length - CONSOLE_BUFFER_LIMIT]);
          }
        }
      } catch {
        // Console capture is best-effort and must never change page console behavior.
      }
      return SAFE_APPLY(original, this, args);
    };
  }
}

if (typeof window !== 'undefined') installConsoleHook(window);
