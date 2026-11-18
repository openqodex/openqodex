import { either, fixture, inFinally, make, Maker, mixed, openShared, reassigned } from "./make";

export function direct() {
  return make().close();
}

export async function awaited() {
  const session = await openShared();
  return session.stream();
}

export function unawaited() {
  const pending = openShared();
  return pending.stream();
}

export async function fromFixture() {
  const { sessions, session } = await fixture();
  sessions.close();
  return session.stream();
}

export function agreeing() {
  return either(true).close();
}

export function disagreeing() {
  return mixed(true).close();
}

export function afterReassign() {
  return reassigned().close();
}

export function afterFinally() {
  return inFinally().close();
}

export function onMethod(maker: Maker) {
  return maker.make().close();
}
