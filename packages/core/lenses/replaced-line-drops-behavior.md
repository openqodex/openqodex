---
name: replaced-line-drops-behavior
description: A replacement drops an effect the old line had and the change does not restore it
triggers:
  replaced_lines: true
  files:
    - "*.c"
    - "**/*.c"
    - "*.cc"
    - "**/*.cc"
    - "*.cpp"
    - "**/*.cpp"
    - "*.cxx"
    - "**/*.cxx"
    - "*.C"
    - "**/*.C"
    - "*.h"
    - "**/*.h"
    - "*.hh"
    - "**/*.hh"
    - "*.hpp"
    - "**/*.hpp"
    - "*.hxx"
    - "**/*.hxx"
    - "*.rs"
    - "**/*.rs"
    - "*.cs"
    - "**/*.cs"
    - "*.php"
    - "**/*.php"
    - "*.ts"
    - "**/*.ts"
    - "*.tsx"
    - "**/*.tsx"
    - "*.js"
    - "**/*.js"
    - "*.jsx"
    - "**/*.jsx"
    - "*.mjs"
    - "**/*.mjs"
    - "*.cjs"
    - "**/*.cjs"
    - "*.mts"
    - "**/*.mts"
    - "*.cts"
    - "**/*.cts"
    - "*.py"
    - "**/*.py"
    - "*.pyi"
    - "**/*.pyi"
    - "*.go"
    - "**/*.go"
    - "*.rb"
    - "**/*.rb"
    - "*.java"
    - "**/*.java"
    - "*.kt"
    - "**/*.kt"
    - "*.kts"
    - "**/*.kts"
    - "*.swift"
    - "**/*.swift"
    - "*.m"
    - "**/*.m"
    - "*.mm"
    - "**/*.mm"
    - "*.scala"
    - "**/*.scala"
    - "*.sc"
    - "**/*.sc"
    - "*.sh"
    - "**/*.sh"
    - "*.bash"
    - "**/*.bash"
    - "*.zsh"
    - "**/*.zsh"
    - "*.sql"
    - "**/*.sql"
    - "*.lua"
    - "**/*.lua"
    - "*.pl"
    - "**/*.pl"
    - "*.pm"
    - "**/*.pm"
    - "*.r"
    - "**/*.r"
    - "*.R"
    - "**/*.R"
    - "*.dart"
    - "**/*.dart"
    - "*.ex"
    - "**/*.ex"
    - "*.exs"
    - "**/*.exs"
    - "*.erl"
    - "**/*.erl"
    - "*.hrl"
    - "**/*.hrl"
    - "*.hs"
    - "**/*.hs"
    - "*.clj"
    - "**/*.clj"
    - "*.cljs"
    - "**/*.cljs"
    - "*.cljc"
    - "**/*.cljc"
    - "*.vue"
    - "**/*.vue"
    - "*.svelte"
    - "**/*.svelte"
    - "*.vb"
    - "**/*.vb"
    - "*.fs"
    - "**/*.fs"
    - "*.fsx"
    - "**/*.fsx"
    - "*.ps1"
    - "**/*.ps1"
    - "*.psm1"
    - "**/*.psm1"
    - "*.groovy"
    - "**/*.groovy"
    - "*.gradle"
    - "**/*.gradle"
    - "*.asm"
    - "**/*.asm"
    - "*.s"
    - "**/*.s"
    - "*.S"
    - "**/*.S"
    - "*.zig"
    - "**/*.zig"
    - "*.jl"
    - "**/*.jl"
    - "*.ml"
    - "**/*.ml"
    - "*.mli"
    - "**/*.mli"
    - "*.nim"
    - "**/*.nim"
    - "*.v"
    - "**/*.v"
    - "*.vhd"
    - "**/*.vhd"
    - "*.vhdl"
    - "**/*.vhdl"
    - "*.f"
    - "**/*.f"
    - "*.f90"
    - "**/*.f90"
    - "*.f95"
    - "**/*.f95"
    - "*.for"
    - "**/*.for"
    - "*.cob"
    - "**/*.cob"
    - "*.cbl"
    - "**/*.cbl"
    - "*.coffee"
    - "**/*.coffee"
    - "*.elm"
    - "**/*.elm"
    - "*.el"
    - "**/*.el"
    - "*.lisp"
    - "**/*.lisp"
    - "*.lsp"
    - "**/*.lsp"
    - "*.scm"
    - "**/*.scm"
    - "*.ss"
    - "**/*.ss"
    - "*.rkt"
    - "**/*.rkt"
    - "*.d"
    - "**/*.d"
    - "*.pas"
    - "**/*.pas"
    - "*.p"
    - "**/*.p"
    - "*.raku"
    - "**/*.raku"
    - "*.tcl"
    - "**/*.tcl"
    - "*.awk"
    - "**/*.awk"
confidence_floor: 0.7
---

For each removed line beside a replacement, name the old line's effects.
These include conditions, calls, resource releases and error handling.
Also check slices, initial values, retries, statuses and parser keys.
Compare those effects with the new code.
Include surrounding control flow and callers.

Flag a dropped effect only when this change never restores it.
Show the resulting failure from the code.
Name the lost effect.
Identify the input or path that needs it.
State the consequence.
Cite the replacement line.
A missing effect alone does not prove a defect.
Check whether the change intentionally removes the behavior.
Verify that the code supports that reason.

This lens triggers on replacements in files with these extensions:

- `.c`, `.cc`, `.cpp`, `.cxx`, `.C`, `.h`, `.hh`, `.hpp`, `.hxx`, `.rs`, `.cs`, `.php`
- `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts`, `.cts`, `.py`, `.pyi`, `.go`, `.rb`
- `.java`, `.kt`, `.kts`, `.swift`, `.m`, `.mm`, `.scala`, `.sc`, `.sh`, `.bash`, `.zsh`, `.sql`
- `.lua`, `.pl`, `.pm`, `.r`, `.R`, `.dart`, `.ex`, `.exs`, `.erl`, `.hrl`, `.hs`, `.clj`
- `.cljs`, `.cljc`, `.vue`, `.svelte`, `.vb`, `.fs`, `.fsx`, `.ps1`, `.psm1`, `.groovy`, `.gradle`, `.asm`
- `.s`, `.S`, `.zig`, `.jl`, `.ml`, `.mli`, `.nim`, `.v`, `.vhd`, `.vhdl`, `.f`, `.f90`
- `.f95`, `.for`, `.cob`, `.cbl`, `.coffee`, `.elm`, `.el`, `.lisp`, `.lsp`, `.scm`, `.ss`, `.rkt`
- `.d`, `.pas`, `.p`, `.raku`, `.tcl`, `.awk`

Suppress when:
- a renamed call has the same effect,
- the old line moved elsewhere in the same change and still runs on the
  paths that need it,
- another condition, call or cleanup preserves the old effect,
- the change explains why the behavior is no longer needed and the code
  supports that explanation,
- the edit only adds lines, or changes formatting or comments without
  changing behavior.

Example: `return ptr ? *ptr : 0;` becomes `return *ptr;`. The old line
handled a null pointer. If callers can still pass null, check for another null guard.
Without one, the replacement dereferences null instead of returning zero.
Flag the lost check. If the same change guards null before this line, raise nothing.

Severity follows the demonstrated consequence. Raise a bug, not a
request for tests, a style preference, or speculative hardening.
