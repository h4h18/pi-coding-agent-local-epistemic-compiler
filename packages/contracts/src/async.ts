export type MaybePromise<T> = T | Promise<T>;

export function attempt<T>(work: () => MaybePromise<T>): Promise<T> {
  return new Promise<T>((resolve) => {
    resolve(work());
  });
}
