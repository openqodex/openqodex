Local declarations have distinct identities in each method and block.
A local type is visible in its block and nested blocks.
A call after a declaring block must not reach that local type. That call (Host.java line 28) does not compile; it exists only as the control.
Local classes in instance and static initializers retain the enclosing class for bare calls.
Local records and enums hide package types in receivers.
Method references and factory results retain the local type's scope.
The enum's generated valueOf method remains a disclosed miss on the local enum.
