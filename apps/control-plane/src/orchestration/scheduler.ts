export type SchedulerWorker = {
  id: string;
  handle: (job: { projectId: string; operationId: string }) => Promise<void>;
};

export class Scheduler {
  readonly #workers: SchedulerWorker[] = [];
  readonly #waiters: Array<() => void> = [];

  register(worker: SchedulerWorker): void {
    this.#workers.push(worker);
  }

  notifyWork(): void {
    const waiters = this.#waiters.splice(0);
    for (const waiter of waiters) {
      waiter();
    }
  }

  waitForWork(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const index = this.#waiters.indexOf(onWork);
        if (index >= 0) {
          this.#waiters.splice(index, 1);
        }
        resolve(false);
      }, timeoutMs);
      const onWork = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      this.#waiters.push(onWork);
    });
  }

  async dispatch(job: { projectId: string; operationId: string }): Promise<void> {
    const worker = this.#workers[0];
    if (worker === undefined) {
      return;
    }
    await worker.handle(job);
  }

  workers(): readonly SchedulerWorker[] {
    return this.#workers;
  }
}
