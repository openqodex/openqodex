A repository interface dispatches to an anonymous implementation passed to a method.
Bare calls prefer the body. Calls absent from the body use the enclosing instance.
An explicit enclosing receiver selects Host.

An outside base blocks enclosing-method fallback when its members are unknown.
Body fields hide captured locals.
Method parameters still hide fields.
An interface cannot be the target of an unqualified super call.
Named inner classes with outside bases also leave bare calls unknown.
An outside base also blocks a static import.
A repository base allows lookup on the enclosing instance when it has no matching member.
