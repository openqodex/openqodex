import type { Lone, Maker, Store } from "./store";

export function load(store: Store): string {
  return store.get("1");
}
export function run(): string {
  return load({ get: (id: string) => "inline " + id, put: () => {} });
}
export function build(): Maker {
  return { make: () => "made", stop: () => {} };
}
export function start(m: Maker): string {
  return m.make();
}
export function seek(l: Lone): string {
  const half = { find: (id: string) => id };
  return l.find(half.find("1"));
}
