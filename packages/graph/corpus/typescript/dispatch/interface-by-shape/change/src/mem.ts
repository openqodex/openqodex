export class MemStore {
  private rows = new Map<string, string>();
  get(id: string): string {
    return this.rows.get(id) ?? "none";
  }
  put(id: string, value: string): void {
    this.rows.set(id, value);
  }
}
