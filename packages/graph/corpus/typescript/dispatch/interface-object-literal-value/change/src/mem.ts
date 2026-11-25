export class MemStore {
  get(id: string): string {
    return "memory " + id;
  }
  put(id: string, value: string): void {
    console.log(id, value);
  }
}
