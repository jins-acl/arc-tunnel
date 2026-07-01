import { spawn } from 'child_process';
import { isProcessRunning, stopChild } from './helpers/process-lifecycle';

jest.setTimeout(10_000);

describe('spawned process cleanup', () => {
  it('escalates past an ignored graceful signal within a bounded deadline', async () => {
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {
      stdio: 'ignore', windowsHide: true
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    const pid = child.pid!;
    const outcome = await stopChild(child, 100, 2_000, () => true);
    expect(outcome.exited).toBe(true);
    expect(outcome.escalated).toBe(true);
    expect(isProcessRunning(pid)).toBe(false);
  });
});
