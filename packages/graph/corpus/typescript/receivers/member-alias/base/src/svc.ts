import type { ExtFn } from "ext-lib"; import { DoneFn, Other, SessionHandle, TurnFn } from "./session";

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

  reassignedParam(deps: Deps, other: Other): string {
    let handle = deps.handle;
    handle = other;
    return handle.createTurn("h");
  }

  reassignedPattern(deps: Deps, other: Other): string {
    let { handle } = deps;
    handle = other;
    return handle.createTurn("i");
  }
}

export interface Hooks {
  done: DoneFn;
  inline: (x: string) => string | number;
  ext: ExtFn;
}

export class Hooked {
  constructor(private readonly hooks: Hooks) {}

  viaUnreadFnCall(): void {
    const done = this.hooks.done;
    done.call(null, "j");
  }

  viaInlineFnCall(): void {
    const inline = this.hooks.inline;
    inline.call(null, "k");
  }

  viaOutsideFnCall(): void {
    const ext = this.hooks.ext;
    ext.call(null, "l");
  }
}
