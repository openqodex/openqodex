import { Api, ListOnly } from "./api";

export class Lister {
  constructor(private readonly client: ListOnly) {}
  names(): string[] {
    return this.client.list();
  }
}

export function stop(api: Pick<Api, "drop">): void {
  api.drop();
}
