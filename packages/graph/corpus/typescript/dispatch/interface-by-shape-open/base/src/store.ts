import type { Api } from "remote-api";

export interface Store {
  get(id: string): string;
  put(id: string, value: string): void;
}

export interface Remote extends Api {
  fetch(id: string): string;
}
