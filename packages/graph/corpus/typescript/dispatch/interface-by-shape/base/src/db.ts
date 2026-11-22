import type { Store } from "./store";

export class DbStore implements Store {
  get(id: string): string {
    return "db " + id;
  }
  put(id: string, value: string): void {
    console.log(id, value);
  }
}
