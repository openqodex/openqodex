run assigns `fn = helper` once and then calls fn(). The change edits helper. A graph that binds bare calls by name finds no definition called fn and reports the call as an unbound gap, while the only value fn can hold is helper. The alias must give a possible may_invoke edge from run to helper at the call line, the assignment a certain uses_value reference, and the call no unknown.

An inner function assigns its own `cb`, so the outer `cb()` must still reach `helper` at tier possible.
A function assigns its own `handler`, so the module call must keep its possible edge to `helper`.
The inner calls reach `other` at tier possible.
