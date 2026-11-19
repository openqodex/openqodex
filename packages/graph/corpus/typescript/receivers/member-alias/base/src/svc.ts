import { Other, SessionHandle, TurnFn } from "./session";

export interface Deps {
  handle: SessionHandle;
  maybe?: SessionHandle;
  run: TurnFn;
}

export class Service {
  private readonly own: SessionHandle;

  constructor(private readonly deps: Deps, own: SessionHandle) {
    this.own = own;
  }

  viaDeps(): string {
    const handle = this.deps.handle;
    return handle.createTurn("a");
  }

  viaField(): string {
    const own = this.own;
    return own.createTurn("b");
  }

  destructured(): string {
    const { handle } = this.deps;
    return handle.createTurn("c");
  }

  optional(): string | undefined {
    const maybe = this.deps?.maybe;
    return maybe?.createTurn("d");
  }

  reassigned(other: Other): string {
    let handle = this.deps.handle;
    handle = other;
    return handle.createTurn("e");
  }

  viaFn(): string {
    const run = this.deps.run;
    return run("f");
  }

  viaFnCall(): string {
    const run = this.deps.run;
    return run.call(null, "g");
  }
}
