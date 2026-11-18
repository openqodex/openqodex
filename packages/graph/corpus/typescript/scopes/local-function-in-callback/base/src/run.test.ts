declare function it(name: string, fn: () => void): void;

export function work(): number {
  return 1;
}

it("runs twice", () => {
  const run = () => work();
  run();
  run();
});
