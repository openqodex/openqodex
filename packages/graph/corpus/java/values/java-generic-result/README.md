Box returns its class type parameter.
Repo arguments bind find through one or two result calls.
A second parameter verifies argument positions.
Raw boxes and external lists provide no result type.
An external list and a wildcard argument truly reach Repo.find, so those edges are not forbidden; the graph does not follow them yet.
A raw box and method parameter shadowing must not bind Repo.find. Those two calls do not compile; they exist only to prove the resolver does not guess.
Subclass receivers cannot supply the declaring class's parameter arguments.
SBox and P<Other> leave find unresolved and record no miss. Both calls truly reach Repo.find, so that edge is not forbidden; an edge to Other.find would be a wrong guess and stays forbidden.
