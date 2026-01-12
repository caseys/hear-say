type Listener<TArguments extends unknown[]> = (...arguments_: TArguments) => void;

export function createListenerRegistry<TArguments extends unknown[]>(
  options: { onError?: (error: unknown) => void } = {}
): {
  on: (listener: Listener<TArguments>) => () => void;
  emit: (...arguments_: TArguments) => void;
  count: () => number;
} {
  const listeners: Array<Listener<TArguments>> = [];
  const { onError } = options;

  const on = (listener: Listener<TArguments>): (() => void) => {
    listeners.push(listener);
    return () => {
      const index = listeners.indexOf(listener);
      if (index !== -1) {
        listeners.splice(index, 1);
      }
    };
  };

  const emit = (...arguments_: TArguments): void => {
    for (const listener of listeners) {
      if (onError) {
        try {
          listener(...arguments_);
        } catch (error) {
          onError(error);
        }
      } else {
        listener(...arguments_);
      }
    }
  };

  const count = (): number => listeners.length;

  return { on, emit, count };
}
