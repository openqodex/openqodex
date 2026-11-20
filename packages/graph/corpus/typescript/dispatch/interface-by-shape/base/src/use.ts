import type { Store } from "./store";

export function load(store: Store): string {
  return store.get("1");
}
