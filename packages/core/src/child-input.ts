import type { Writable } from "node:stream";

// Write a child's whole input to its stdin and close it.
//
// A child can exit before it has read all of its input: git stops at the
// first path it cannot open, or the child is killed. The write then fails
// on the pipe (EPIPE on Linux and macOS, EOF on Windows), and a pipe with no
// error listener turns that into an uncaught exception that ends the whole
// process. A server reviewing many changes in one process lost every review
// it held that way. The child's exit already says why it stopped, through
// its exit code and its stderr, so the write error adds nothing and is
// dropped here.
export function endInput(stdin: Writable | null | undefined, input: string): void {
  if (!stdin) return;
  stdin.on("error", () => {
    // the child is gone; its exit reports why
  });
  stdin.end(input);
}
