export class Session {
  stream(): string {
    return "events";
  }
}

export class Sessions {
  close(): number {
    return 1;
  }

  async open(): Promise<Session> {
    return new Session();
  }
}

// The control: the same method names on a class nothing types.
export class Other {
  close(): number {
    return 2;
  }

  stream(): string {
    return "other";
  }
}
