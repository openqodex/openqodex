A typed receiver returns Item. The next call must bind to Item.

Parameters, locals, fields, and receiver variables share this rule.
An untyped receiver leaves an unknown. An external result creates no edge or false miss.
Reassignment from another receiver type must discard the old result type.
Sixteen nested result types stay readable. A longer chain stays unresolved.

Nested callbacks preserve annotated and constructed receiver types.
The mapped controls bind through both a saved result and a direct chain.
The unmapped controls return a type through a workspace package's JavaScript export.
Its solution config references build configs that the graph does not use for source mapping.
Both result calls stay unknown, with no edge to Item.normalize.

Promise methods stay external until the result is awaited.
Awaited chains and awaited local initializers bind to the declared result.

A nested class cannot borrow its namesake's result type from file scope.
Its chained call stays unknown and creates no edge.
