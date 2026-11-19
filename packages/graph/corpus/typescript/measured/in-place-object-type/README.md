resolveAll takes `input: { resolver: Resolver; names: string[] }`. An object type written in place keeps its members, so input.resolver.resolve(n) binds certain to Resolver.resolve, and input.names.map() is the language's own method. Before the fix the object type was the marker {} with no members, and the call was an untyped-receiver unknown. Trueforge: input.resolver.resolveAgentDefinition in SessionHandle.ts:415 and :507, 78 sites in all.

The call goes through an interface, and no class of the repository matches it by shape without declaring it, so no unknown is left.
