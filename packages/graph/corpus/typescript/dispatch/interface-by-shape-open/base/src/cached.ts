import { LRUCache } from "lru-cache";

export class Cached extends LRUCache<string, string> {
  get(id: string): string {
    return "cached " + id;
  }
}
