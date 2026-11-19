import type { ISessionStore } from "./index";

export function registry(): number {
  const stores = new Map<string, ISessionStore>();
  return stores.size;
}
