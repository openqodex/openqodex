export interface Store {
  get(id: string): string;
  put(id: string, value: string): void;
}

export interface Cache {
  read(id: string): string;
  write(id: string): void;
}

export interface Lone {
  find(id: string): string;
  save(id: string): void;
}
