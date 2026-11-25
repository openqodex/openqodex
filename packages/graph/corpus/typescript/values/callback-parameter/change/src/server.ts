export class Server {
  listTools(): string[] {
    return ["t"];
  }
}

export class Registry {
  all(): Server[] {
    return [];
  }
}
