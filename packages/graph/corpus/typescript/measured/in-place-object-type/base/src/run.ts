import { Resolver } from "./resolver";

export function resolveAll(input: { resolver: Resolver; names: string[] }): string[] {
  return input.names.map((n) => input.resolver.resolve(n));
}
