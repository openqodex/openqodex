resolveAll takes `input: { resolver: Resolver; names: string[] }`. The extractor turns an object type written in place into the marker {} and keeps none of its members; the resolver's untypedType treats {} as untyped before any path is followed, so input.resolver.resolve(n) is an untyped-receiver unknown. Trueforge: input.resolver.resolveAgentDefinition in SessionHandle.ts:415 and :507, 78 sites in all.

The call goes through an interface, so it also keeps the interface note (unsupported-rule: a value of that shape may be any object), as every interface call does; no other unknown is left.
