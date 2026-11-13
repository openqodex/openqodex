`makeHandler` returns the named function `onEvent` with the callable type `Handler`.
The local `h` holds that call result.
Calling `h.cancel()` must bind to `Handler.cancel` at tier certain.
The existing interface dispatch gap remains at this call.
It must not gain a possible invocation edge to `onEvent`.
The change edits `onEvent`.
