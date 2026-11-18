export class Api {
  list(): string[] {
    return ["a"];
  }
  drop(): void {}
}

export type ListOnly = Pick<Api, "list">;
