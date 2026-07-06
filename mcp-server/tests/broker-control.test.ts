import { runControl } from '../src/broker-control';

const diagnostics = {
  broker: { pid: 42, port: 19090, protocolVersion: 2, uptimeMs: 1234 },
  extension: { connected: true, generation: 1, reconnectPhase: 'idle', lastSyncAt: null },
  agents: { connected: 2, grace: 1 }, workload: { claimedTabs: 3, pendingCommands: 4 },
  recovery: { inventorySync: 'idle', recordingCleanup: 'idle' }, recentError: null
} as const;

function output() {
  let stdout = ''; let stderr = '';
  return { write: { stdout: (value: string) => { stdout += value; }, stderr: (value: string) => { stderr += value; } },
    read: () => ({ stdout, stderr }) };
}

describe('broker control diagnose', () => {
  it('prints a Chinese operations view and dashboard URL', async () => {
    const capture = output();
    const code = await runControl(['diagnose', '--port', '19090'], {}, capture.write, {
      inspectBroker: async () => ({ kind: 'healthy' as const, port: 19090, pid: 42, protocolVersion: 2, diagnostics })
    });
    expect(code).toBe(0);
    expect(capture.read().stdout).toContain('Arc Tunnel 运维控制中心');
    expect(capture.read().stdout).toContain('http://127.0.0.1:19090/dashboard');
  });

  it('writes exactly one stable JSON document', async () => {
    const capture = output();
    const code = await runControl(['diagnose', '--port', '19090', '--json'], {}, capture.write, {
      inspectBroker: async () => ({ kind: 'healthy' as const, port: 19090, pid: 42, protocolVersion: 2, diagnostics })
    });
    expect(code).toBe(0);
    const json = JSON.parse(capture.read().stdout);
    expect(json.running).toBe(true);
    expect(capture.read().stdout.trim()).toBe(JSON.stringify(json));
    expect(capture.read().stderr).toBe('');
  });

  it('uses distinct exit codes for every failure classification', async () => {
    const variants = [
      { kind: 'absent' as const, port: 19090 },
      { kind: 'foreign' as const, port: 19090 },
      { kind: 'incompatible' as const, port: 19090, pid: 42, protocolVersion: 99, expectedProtocolVersion: 2 },
      { kind: 'diagnostics-unavailable' as const, port: 19090, pid: 42, protocolVersion: 2 }
    ];
    const codes: number[] = [];
    for (const inspection of variants) {
      const capture = output();
      codes.push(await runControl(['diagnose', '--json'], {}, capture.write, { inspectBroker: async () => inspection }));
      expect(() => JSON.parse(capture.read().stdout)).not.toThrow();
    }
    expect(codes).toEqual([2, 3, 4, 5]);
  });

  it('renders diagnostics-unavailable safely in human mode with exit 5', async () => {
    const capture = output();
    const code = await runControl(['diagnose', '--port', '19090'], {}, capture.write, {
      inspectBroker: async () => ({ kind: 'diagnostics-unavailable', port: 19090, pid: 42, protocolVersion: 2 })
    });
    expect(code).toBe(5);
    expect(capture.read().stdout).toContain('诊断接口不可用');
    expect(capture.read().stderr).toBe('');
  });

  it('keeps status JSON byte-compatible', async () => {
    const capture = output();
    const status = { running: true, port: 19090, protocolVersion: 2, pid: 42 };
    await runControl(['status', '--port', '19090'], {}, capture.write, { getBrokerStatus: async () => status });
    expect(capture.read().stdout).toBe(`${JSON.stringify(status)}\n`);
  });
});
