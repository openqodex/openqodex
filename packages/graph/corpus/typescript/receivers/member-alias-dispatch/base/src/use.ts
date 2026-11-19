import { BaseStore, Store } from "./store";

export interface Deps {
  store: Store;
}

export class Service {
  constructor(private readonly deps: Deps) {}

  copied(): string {
    const store = this.deps.store;
    return store.get();
  }
}

export function copiedParam(deps: Deps): string {
  const store = deps.store;
  return store.get();
}

export function fromObject(obj: { store: Store }): string {
  const { store } = obj;
  return store.get();
}

export function reassigned(deps: Deps, other: Store): string {
  let store = deps.store;
  store = other;
  return store.get();
}

export interface BaseDeps {
  base: BaseStore;
}

export function copiedBase(deps: BaseDeps): string {
  const base = deps.base;
  return base.get();
}

export function fromObjectBase(obj: { base: BaseStore }): string {
  const { base } = obj;
  return base.get();
}

export function copiedObject(obj: { store: Store }): string {
  const store = obj.store;
  return store.get();
}

export class Holder {
  constructor(private readonly base: BaseStore) {}

  copiedField(): string {
    const base = this.base;
    return base.get();
  }
}
