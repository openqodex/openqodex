export class Api {
  list(): string[] {
    return [];
  }
  drop(): void {}
}

export type ListOnly = Pick<Api, "list">;
