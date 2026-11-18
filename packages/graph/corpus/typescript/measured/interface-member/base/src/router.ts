import { Sessions } from "./sessions";

export interface RouterDeps {
  sessions: Sessions;
}

export type AliasDeps = { sessions: Sessions };

export function createRouter(deps: RouterDeps): string {
  return deps.sessions.create("s1");
}

export function createAliased(deps: AliasDeps): string {
  return deps.sessions.create("s2");
}
