---
"openqodex": patch
---

- The code graph reads a React file whose JSX elements nest deeply in time that grows with the depth, not its square: 20,000 nested elements took 1.6 seconds of CPU and now take a fraction of that. The reader asked every element how far up its return statement sat, climbing through every element above it; it now takes the answer from the nearest element above.
