export class Box<T> {
  open(): T | undefined {
    return void 0;
  }
}

export type AnyBox = Box<unknown>;
