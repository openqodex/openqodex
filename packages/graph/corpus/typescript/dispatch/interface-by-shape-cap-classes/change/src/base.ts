export class Base {
  handle(input: string): string {
    return "base changed " + input;
  }
  name(): string {
    return "base";
  }
}
