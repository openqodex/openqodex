export interface Box<T> {
  value: T;
  label: string;
}

export class Wrapper<T> {
  value!: T;
}
