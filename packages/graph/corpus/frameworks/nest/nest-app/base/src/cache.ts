// A decorator of the repository's own, named like Nest's.
export function Get(path: string): MethodDecorator {
  return () => {
    void path;
  };
}

export class Cache {
  @Get("/cached")
  read(): number {
    return 1;
  }
}
