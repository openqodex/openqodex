export class Session {
  stream(): string {
    return "all events";
  }
}

export class Sessions {
  close(): number {
    return 10;
  }

  async open(): Promise<Session> {
    return new Session();
  }
}

// The control: the same method names on a class nothing types.
export class Other {
  close(): number {
    return 20;
  }

  stream(): string {
    return "other";
  }
}
