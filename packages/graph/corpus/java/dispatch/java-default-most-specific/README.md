B extends A and declares defaults with the same names and parameter counts.
Zero-parameter calls bind only to B, regardless of the implements order.
Leaf overrides A through Bridge. Zero-parameter calls on Transitive bind only to Leaf.
A sub-interface default hides an inherited default only for zero-parameter methods, because the graph records parameter names and not types.
Calls with arguments keep both same-count members as possible candidates.
The different-type control passes a string to inherited m(String), beside the sub-interface's m(Integer).
Two unrelated defaults stay possible. The diamond is a syntax fixture with invalid Java semantics.
A class override and a superclass method keep winning zero-parameter calls.
Defaults with different parameter counts remain available.
The existing java-inherited-overload case guards class overloads with the same count and different parameter types.
B2 redeclares m and n as abstract. Zero-parameter calls bind only to B2 in both implements orders.
Calls to n keep both declarations as possible because their parameter types are unavailable.
