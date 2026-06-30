import { TabScheduler } from '../src/broker/tab-scheduler';

describe('TabScheduler', () => {
  it('serializes one tab but overlaps different tabs', async () => {
    const scheduler = new TabScheduler();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = scheduler.run(1, async () => {
      order.push('a:start');
      await gate;
      order.push('a:end');
    });
    const second = scheduler.run(1, async () => {
      order.push('b');
    });
    const other = scheduler.run(2, async () => {
      order.push('c');
    });

    await other;
    expect(order).toEqual(['a:start', 'c']);

    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['a:start', 'c', 'a:end', 'b']);
  });

  it('continues queued work on the same tab after a rejection', async () => {
    const scheduler = new TabScheduler();
    const order: string[] = [];

    const first = scheduler.run(7, async () => {
      order.push('first');
      throw new Error('boom');
    });
    const second = scheduler.run(7, async () => {
      order.push('second');
      return 'ok';
    });

    await expect(first).rejects.toThrow('boom');
    await expect(second).resolves.toBe('ok');
    expect(order).toEqual(['first', 'second']);
  });

  it('starts a fresh operation immediately after the prior chain clears', async () => {
    const scheduler = new TabScheduler();
    const order: string[] = [];

    await scheduler.run(9, async () => {
      order.push('first');
    });
    await scheduler.run(9, async () => {
      order.push('second');
    });

    expect(order).toEqual(['first', 'second']);
  });
});
