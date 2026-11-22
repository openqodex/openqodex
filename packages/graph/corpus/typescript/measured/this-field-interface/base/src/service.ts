import { Store } from "./store";

export class Service {
  constructor(private readonly store: Store) {}
  read(id: string): string {
    return this.store.get(id);
  }
}

export function load(store: Store): string {
  return store.get("1");
}
