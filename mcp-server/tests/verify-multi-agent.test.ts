const { waitForExpectedLocation } = require('../../scripts/verify-multi-agent.js');

jest.setTimeout(2_000);

function peerWithLocations(values: Array<unknown | Error>) {
  let index = 0;
  return {
    client: {
      callTool: jest.fn(async () => {
        const value = values[Math.min(index++, values.length - 1)];
        if (value instanceof Error) throw value;
        return { content: [{ type: 'text', text: JSON.stringify({ result: value }) }] };
      })
    }
  };
}

describe('live navigation condition waiting', () => {
  it('polls through null and an old URL until the expected location arrives', async () => {
    const peer = peerWithLocations([null, 'about:blank', 'https://alpha.example/']);
    await expect(waitForExpectedLocation(peer, 101, 'https://alpha.example/', Date.now() + 500, 1))
      .resolves.toBe('https://alpha.example/');
    expect(peer.client.callTool).toHaveBeenCalledTimes(3);
  });

  it('times out instead of accepting a stable wrong-tab URL', async () => {
    const peer = peerWithLocations(['https://beta.example/']);
    await expect(waitForExpectedLocation(peer, 101, 'https://alpha.example/', Date.now() + 20, 1))
      .rejects.toThrow(/Timed out.*alpha\.example.*beta\.example/);
  });

  it('retries a transient navigation context error but surfaces ownership errors immediately', async () => {
    const transient = Object.assign(new Error('Execution context was destroyed by navigation'), { code: 'EXECUTION_ERROR' });
    const recovering = peerWithLocations([transient, 'https://alpha.example/']);
    await expect(waitForExpectedLocation(recovering, 101, 'https://alpha.example/', Date.now() + 500, 1))
      .resolves.toBe('https://alpha.example/');

    const ownership = Object.assign(new Error('TAB_NOT_OWNED'), { code: 'TAB_NOT_OWNED' });
    const foreign = peerWithLocations([ownership]);
    await expect(waitForExpectedLocation(foreign, 101, 'https://alpha.example/', Date.now() + 500, 1))
      .rejects.toMatchObject({ code: 'TAB_NOT_OWNED' });
    expect(foreign.client.callTool).toHaveBeenCalledTimes(1);
  });

  it('bounds a never-settling execute_script call and observes its later rejection', async () => {
    let rejectCall!: (error: Error) => void;
    const pending = new Promise((_resolve, reject) => { rejectCall = reject; });
    const peer = { client: { callTool: jest.fn(() => pending) } };
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on('unhandledRejection', onUnhandled);
    const started = Date.now();
    try {
      await expect(waitForExpectedLocation(peer, 101, 'https://alpha.example/', started + 40, 1))
        .rejects.toThrow(/Timed out/);
      expect(Date.now() - started).toBeLessThan(250);
      rejectCall(new Error('late close failure'));
      await new Promise(resolve => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('uses one absolute deadline for concurrent location waits', async () => {
    const never = () => new Promise(() => undefined);
    const alpha = { client: { callTool: jest.fn(never) } };
    const beta = { client: { callTool: jest.fn(never) } };
    const started = Date.now();
    const deadline = started + 50;
    const results = await Promise.allSettled([
      waitForExpectedLocation(alpha, 101, 'https://alpha.example/', deadline, 1),
      waitForExpectedLocation(beta, 202, 'https://beta.example/', deadline, 1)
    ]);
    expect(results.map(result => result.status)).toEqual(['rejected', 'rejected']);
    expect(Date.now() - started).toBeLessThan(250);
  });
});
