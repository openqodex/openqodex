export class SessionHandle {
  createTurn(x: string): string {
    return x + "!";
  }
}

// The control: the same method name on a class nothing types.
export class Other {
  createTurn(x: string): string {
    return x + "!";
  }
}

export type TurnFn = (x: string) => string;
