import type { ISessionStore } from "./index";

type Base = { tenant: string };

export type Input =
  | (Base & { kind: "session"; store: ISessionStore })
  | (Base & { kind: "tenant" });

export type Shadow<ISessionStore> = { value: ISessionStore };
