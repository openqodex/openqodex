// Decorators of the repository's own, named like Nest's.
export function Controller(prefix?: string): ClassDecorator {
  return () => {
    void prefix;
  };
}

export function Get(path?: string): MethodDecorator {
  return () => {
    void path;
  };
}

export function Module(meta: { controllers: unknown[] }): ClassDecorator {
  return () => {
    void meta;
  };
}
