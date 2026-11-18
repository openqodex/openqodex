import { SessionHandle } from "./session";

export interface TurnParams {
  session: SessionHandle;
}

export function begin(params: TurnParams): number {
  const { session } = params;
  return session.createTurn();
}

export function beginInline({ session }: TurnParams): number {
  return session.createTurn();
}
