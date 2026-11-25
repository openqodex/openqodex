declare function it(name: string, fn: () => void): void;

export function work(): number {
  return 2;
}

it("runs twice", () => {
  const run = () => work();
  run();
  run();
});
