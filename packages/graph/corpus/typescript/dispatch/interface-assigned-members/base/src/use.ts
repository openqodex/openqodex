import type { Cache, Lone, Store } from "./store";

export function load(store: Store): string {
  return store.get("1");
}
export function run(): string {
  const f = () => "f";
  f.get = (id: string) => "assigned " + id;
  f.put = () => {};
  return load(f);
}
export function peek(c: Cache): string {
  return c.read("1");
}
export function wrap(): Cache {
  return Object.assign(() => "w", { read: (id: string) => id }, { write: () => {} });
}
export function seek(l: Lone): string {
  const half = () => "h";
  half.find = (id: string) => id;
  half.label = "half";
  return l.find(half.find("1"));
}
