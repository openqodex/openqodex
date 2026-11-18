import type { Deps, Holder } from "./deps";
import type { Sessions } from "./sessions";

export function viaBase(deps: Deps) {
  return deps.sessions.close();
}

export function viaOptional(deps: Deps) {
  return deps.backup?.close();
}

export function viaNonNull(deps: Deps) {
  return deps.backup!.close();
}

export function viaGeneric(holder: Holder<number>) {
  return holder.sessions.close();
}

export function viaReadonly(deps: Readonly<Deps>) {
  return deps.sessions.close();
}

export function viaPartial(deps: Partial<Deps>) {
  return deps.sessions?.close();
}

export function viaCast(value: unknown) {
  return (value as Sessions).close();
}
