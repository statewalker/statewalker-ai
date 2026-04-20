/**
 * Minimal observable base class.
 *
 * Provides a subscribe/notify mechanism. Subclasses call
 * {@link Notifiable.notify | notify()} after mutating their state;
 * consumers register callbacks via {@link Notifiable.onUpdate | onUpdate()}.
 */
export class Notifiable {
  private _listeners: Set<() => void> = new Set();

  /**
   * Registers a listener that is called on every {@link notify}.
   * @returns An unsubscribe function that removes the listener.
   */
  onUpdate: (callback: () => void) => () => void = (callback) => {
    this._listeners.add(callback);
    return () => {
      this._listeners.delete(callback);
    };
  };

  /** Synchronously invokes all registered listeners. */
  notify(): void {
    for (const listener of this._listeners) {
      listener();
    }
  }
}

/**
 * Subscribes to a notifiable and fires the callback only when the
 * value returned by `get` changes (strict equality).
 */
export function onChange<T>(
  onUpdate: (cb: () => void) => () => void,
  callback: () => void,
  get: () => T,
  onStart = false,
): () => void {
  let prev: T = get();
  if (onStart) {
    callback();
  }
  return onUpdate(() => {
    const next: T = get();
    if (next !== prev) {
      prev = next;
      callback();
    }
  });
}
