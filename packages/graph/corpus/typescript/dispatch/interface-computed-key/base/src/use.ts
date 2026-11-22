import type { Lone, Store } from "./store";

const GET = "get";

export function load(store: Store): string {
  return store.get("1");
}
export function run(): string {
  return load({ [GET]: (id: string) => "computed " + id, put: () => {} } as Store);
}
export function seek(l: Lone): string {
  const half = { [GET]: "data", find: (id: string) => id };
  return l.find(half.find("1"));
}
