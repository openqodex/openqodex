import { Other, Sessions } from "./sessions";

const shared = new Sessions();

export function make() {
  return new Sessions();
}

export async function openShared() {
  return shared.open();
}

export async function fixture() {
  const sessions = new Sessions();
  const session = await sessions.open();
  return { sessions, session };
}

export function either(flag: boolean) {
  if (flag) return new Sessions();
  return new Sessions();
}

export function mixed(flag: boolean) {
  if (flag) return new Sessions();
  return new Other();
}

export function reassigned() {
  let value = new Sessions();
  value = new Other() as unknown as Sessions;
  return value;
}

export function inFinally() {
  try {
    return new Sessions();
  } finally {
    // The case is the unsafe finally itself: its return replaces the try's.
    // oxlint-disable-next-line no-unsafe-finally
    return new Other();
  }
}

export class Maker {
  make() {
    return new Sessions();
  }
}
