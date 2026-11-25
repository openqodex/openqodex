import type { Other, Sessions } from "./sessions";

type AliasDeps = { sessions: Sessions; close(): number };

export function viaAlias(deps: AliasDeps) {
  return deps.sessions.close();
}

export function onAlias(deps: AliasDeps) {
  return deps.close();
}

export function viaInPlace(input: { sessions: Sessions; names: string[] }) {
  return input.names.map(() => input.sessions.close());
}

export function onInPlace(input: { close(): number }) {
  return input.close();
}

export function viaNested(input: { inner: { sessions: Sessions } }) {
  return input.inner.sessions.close();
}

export function viaIntersection(input: { sessions: Sessions } & { tag: string }) {
  return input.sessions.close();
}

export function bothSides(input: { a: Sessions } & { a: Other }) {
  return input.a.close();
}

export function onIntersection(input: Sessions & { tag: string }) {
  return input.close();
}
