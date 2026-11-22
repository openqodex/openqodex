import type { Sessions } from "./sessions";

export interface Base {
  sessions: Sessions;
}

export interface Deps extends Base {
  readonly backup?: Sessions;
}

export interface Holder<T> {
  sessions: Sessions;
  tag: T;
}
