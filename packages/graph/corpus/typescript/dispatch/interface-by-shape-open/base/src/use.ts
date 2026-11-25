import type { Remote, Store } from "./store";

export function load(store: Store, remote: Remote): string {
  const a = store.get("1");
  return a + remote.fetch("2");
}
