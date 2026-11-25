Host defines m and returns an anonymous Runnable with its own m.
The anonymous body's `this.m()` binds to that body's method at certain.
It must not reach Host.m or leave an unknown.

A named class has the same certainty for its own fixed zero-argument method, even with an outside base.
A varargs overload must not displace that fixed member.
The varargs-only control stays likely because an outside base may supply a better overload.
A subclass also selects the inherited fixed zero-argument member before a varargs overload.
