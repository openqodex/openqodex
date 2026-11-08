A typed receiver returns Item. The next call must bind to Item.

Parameters, locals, fields, and receiver variables share this rule.
An untyped receiver leaves an unknown. An external result creates no edge or false miss.
Reassignment through the same receiver type keeps its known result.
Sixteen nested result types stay readable. A longer chain stays unresolved.

Go follows chained results through fields only when each field's struct is declared in the caller's file.
The split-file control stays unknown and creates no edge.
