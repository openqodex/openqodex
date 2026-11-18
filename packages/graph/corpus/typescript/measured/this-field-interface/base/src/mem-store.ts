import { Store } from "./store";

export class MemStore implements Store {
  get(id: string): string {
    return id;
  }
}
