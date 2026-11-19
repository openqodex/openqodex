export interface Store {
  get(id: string): string;
  put(id: string, value: string): void;
  close?(): void;
}
