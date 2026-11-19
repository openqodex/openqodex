export interface Store {
  get(id: string): string;
  put(id: string, value: string): void;
}

export interface Maker {
  make(): string;
  stop(): void;
}

export interface Lone {
  find(id: string): string;
  save(id: string): void;
}
