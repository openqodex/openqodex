export class Box<T> {
  open(): T | undefined {
    return undefined;
  }
}

export type AnyBox = Box<unknown>;
