import { ChildProcess } from 'child_process';

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitUntilExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

export async function stopChild(
  child: ChildProcess,
  gracefulTimeoutMs = 500,
  finalTimeoutMs = 2_000,
  requestGraceful: () => boolean = () => child.kill('SIGTERM')
): Promise<{ exited: boolean; escalated: boolean }> {
  if (child.exitCode !== null || child.signalCode !== null) return { exited: true, escalated: false };
  requestGraceful();
  if (await waitUntilExit(child, gracefulTimeoutMs)) return { exited: true, escalated: false };
  const escalated = true;
  child.kill('SIGKILL');
  return { exited: await waitUntilExit(child, finalTimeoutMs), escalated };
}
