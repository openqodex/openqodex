export interface Store {
  get(): string;
}

export class MemStore implements Store {
  get(): string {
    return "m";
  }
}

export class DiskStore implements Store {
  get(): string {
    return "d";
  }
}

export class BaseStore {
  get(): string {
    return "b";
  }
}

export class CachedStore extends BaseStore {
  get(): string {
    return "c";
  }
}
