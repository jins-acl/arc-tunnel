const { waitForExpectedLocation } = require('../../scripts/verify-multi-agent.js');

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
});
