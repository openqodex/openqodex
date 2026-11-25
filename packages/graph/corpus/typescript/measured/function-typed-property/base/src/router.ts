import { SkillStore } from "./store";

export type ResolveStore = (tenant: string) => SkillStore;

export interface Deps {
  resolveStore: ResolveStore;
  resolveDirect: (tenant: string) => SkillStore;
}

export function listSkills(deps: Deps): string[] {
  return deps.resolveStore("t").list();
}

export function listDirect(deps: Deps): string[] {
  return deps.resolveDirect("t").list();
}
