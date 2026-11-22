export class MemStore {
  get(id: string): string {
    return "mem " + id;
  }
  put(id: string, value: string): void {
    console.log(id, value);
  }
}
