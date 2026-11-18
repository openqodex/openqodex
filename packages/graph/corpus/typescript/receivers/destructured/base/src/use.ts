import { Sessions } from "./sessions";

export interface Deps {
  sessions: Sessions;
  inner: { sessions: Sessions };
}

export function fromParam({ sessions }: Deps) {
  return sessions.close();
}

export function renamed(deps: Deps) {
  const { sessions: s } = deps;
  return s.close();
}

export function nested(deps: Deps) {
  const { inner: { sessions } } = deps;
  return sessions.close();
}

export function withDefault({ sessions = new Sessions() }: Deps) {
  return sessions.close();
}

export async function chained(deps: Deps) {
  const { sessions } = deps;
  const session = await sessions.open();
  return session.stream();
}
