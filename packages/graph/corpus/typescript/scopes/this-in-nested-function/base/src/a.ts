export class A {
  run(): number {
    const o = { go() { return this.x(); } };
    const f = function () { return this.x(); };
    return o.go() + f() + [1].map(() => this.x())[0];
  }
  x(): number {
    return 1;
  }
}
