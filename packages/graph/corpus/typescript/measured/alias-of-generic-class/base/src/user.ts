import { AnyBox } from "./box";

export class User {
  constructor(private readonly box: AnyBox) {}
  run(): void {
    this.box.open();
  }
}
