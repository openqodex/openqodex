export interface Handler {
  handle(input: string): string;
  name(): string;
}
