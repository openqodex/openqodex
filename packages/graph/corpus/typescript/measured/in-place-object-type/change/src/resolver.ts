export interface Resolver {
  resolve(name: string, strict?: boolean): string;
}
