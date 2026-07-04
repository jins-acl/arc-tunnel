export class TabScheduler {
  private readonly tails = new Map<number, Promise<unknown>>();

  run<T>(tabId: number, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(tabId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.tails.set(tabId, current);
    void current.then(
      () => this.clearTail(tabId, current),
      () => this.clearTail(tabId, current)
    );
    return current;
  }

  whenIdle(tabId: number): Promise<void> {
    const tail = this.tails.get(tabId);
    return tail ? tail.then(() => undefined, () => undefined) : Promise.resolve();
  }

  private clearTail(tabId: number, current: Promise<unknown>): void {
    if (this.tails.get(tabId) === current) {
      this.tails.delete(tabId);
    }
  }
}
