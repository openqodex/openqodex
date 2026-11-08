# The code graph

The code graph is a map of your repository: every function, method, class and type as a point, and every call, import and inheritance between them as a line, with the proof attached. `openqodex review` builds it on your machine and puts what your change reaches into the reviewer's brief. No model is called to build it and nothing is sent anywhere.

## What it answers

For a review, the brief's block "What this change reaches" lists:

- the symbols the change touches, removes or moves (a move under another name is found by the same body);
- the public names the change removed or bound to another definition, compared in the base and the changed version, with every place that used them and what each binds now;
- who calls the touched code, one and two hops out, certain callers first, then the possible ones apart (calls through an interface or a base type, functions used as values; see "Dispatch, values and types");
- where the touched code is used as a value or named as a type, and what implements or overrides it;
- what the touched code calls, and the files that import a changed file;
- what the graph could not see near the change, and whether each caller list is complete or a floor.

Everything the brief leaves out is in the review's packet (below).

## Certain, likely and possible

Every call site on a line carries the evidence that proved it and one of these levels:

- certain: an import that names the symbol, a definition in the same scope or Go package, or a receiver whose type a constructor, an annotation, a declared result or `this`/`self` gives, and every step it rests on is proved the same way. A name match alone is never certain.
- likely: a stated convention picked the one target. The line says which convention, for example a workspace package reached through its built `dist` entry with no tsconfig `paths`, project reference or source condition mapping it to source, or a Ruby constant found by the autoload convention.
- possible: the call may reach this definition and nothing proves it does: a name that two `export *` statements bring from different modules (JavaScript exports neither; a bundler may pick one), a call through an interface or a base type that one of several implementations answers, or a function used as a value that a callee, an alias, a table or a returned value may call. Each candidate is listed with the note. A possible caller is never proof that the code runs, and never counted with the certain and likely ones.

A step through inheritance is part of the proof: a method found on a base class is no surer than the binding of that base class, for a call on an instance and for `super`.

## Workspaces and source roots

- A bare import that names a package of the workspace (`pnpm-workspace.yaml`, or `workspaces` in `package.json`) binds when the importing package declares it: with `workspace:`, with a `file:` or `link:` path that leads to that package's own folder, or with a version range a lockfile resolves to the workspace. A lockfile that resolves it to a published version keeps the call external. A package that does not declare it is not assumed. A `file:` or `link:` path is read as npm and pnpm read it: each `..` removes the name before it, by its spelling. The folders the path then names are walked in the work tree one at a time from the repository root, and it binds only when the folder it reaches is that package's folder on disk (the same device and inode), however either path is spelled. A path that leads to any other folder of the repository is never bound by the name alone and stays an unknown, and so does one that passes through a symbolic link or through a name that is not a folder, which the note names; a path that climbs above the repository root is external.
- The package's entry comes from `exports` (in key order, `types` never), then `module` and `main`. A package with an `exports` map exposes only what the map lists: any other path is not bound and is recorded as not exported, as Node refuses it. Without an `exports` map, a path such as `pkg/src/x` is found by the package's folders. A source entry is certain; a built entry mapped back to `src` (through the package tsconfig's `outDir` and `rootDir`, or `dist` to `src`) is likely, and certain when the importer's tsconfig references the package as a project.
- The nearest `tsconfig.json` or `jsconfig.json` above a file governs it, with relative `extends` followed (up to five configs in one chain; an `extends` that names a package is read for the config's own options only). Its `paths` and `baseUrl` prove an import when its `files`, `include` and `exclude` list the file; otherwise the binding is likely.
- Python absolute imports search the importing file's own folders, every `src` folder that holds a package, every folder with a `pyproject.toml`, `setup.cfg` or `setup.py`, and namespace packages without `__init__.py`. A module found in two places (next to the importer, or under two roots) is not bound and is recorded as ambiguous. A module file or a regular package wins over a namespace package, as in Python.
- Manifests and tsconfig files are read as text, each up to 1 MB, and lockfiles (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`) up to 16 MB; a larger file is not read. Each is read in one pass, so a crafted file cannot make the graph hang. Nothing in the repository is run.
- A manifest, lockfile or tsconfig the graph cannot read, parse or follow (over its cap, not valid JSON, a link or in a folder that is one, a relative `extends` that names a file not in the repository) is never dropped quietly. It becomes an unknown that names the file and what failed, and a reason line of the build. A file that git lists but the work tree no longer holds is no failure. What else follows depends on what its loss can hide:

| File | Its loss can hide | Then |
| --- | --- | --- |
| `package.json` | calls, inheritance and imports | caller lists in its folder are floors; the build is partial and keeps no index |
| `tsconfig.json`, `jsconfig.json` | calls, inheritance and imports | the same |
| `pnpm-workspace.yaml` | calls, inheritance and imports | the same |
| `go.mod` | calls and imports | the same |
| `pyproject.toml`, `setup.cfg`, `requirements*.txt`, `requirements*.in`, the `.txt` and `.in` files of a `requirements/` folder, and the files any of them includes with `-r` or `-c` | nothing: imports of what it declares read as misses | the build stays complete |
| `Gemfile` | nothing: requires of the gems it names read as misses | the build stays complete |
| `pom.xml` | nothing: imports of what it declares read as misses | the build stays complete |
| `build.gradle`, `build.gradle.kts`, `settings.gradle`, `settings.gradle.kts` | nothing: imports of what it declares read as misses | the build stays complete |
| `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock` | nothing: a binding through it is only less sure | the build stays complete |

  An include is read relative to the file that includes it, only inside the repository, and at most 64 includes in all; one outside the repository, missing, or past that bound is said as a gap of the including file.

  A kept index is matched by every file the graph read or looked for while it worked out the projects, whatever its name (a tsconfig may extend `./configs/base`, with no extension), with its content, and by whether each file it looked for was there. It is never reused once one of them changes, appears or goes.

## What it cannot see

A call no rule can bind is kept as an unknown with its cause, never dropped:

- external: the name comes from a declared dependency or the standard library. Only these are external; an import of a module that is not in the repository and that no manifest declares is a miss.
- no-receiver-type: a method called on a value whose type no rule knows, or a member that an interface or a type alias does not declare.
- untyped-receiver: a method called on a value typed `any`, `unknown`, `object` or an object type written in place such as `{ save(): number }` (Python `object` or `Any`, Go `any`). It may reach any method of that name, so it is never counted as external.
- not-exported: a path of a workspace package that its `exports` map does not expose.
- dynamic: a call through a parameter, a local value, a computed member such as `handlers[key]()`, or what another call returned. Such a call could reach any function of its project; on a literal table that nothing else can change it is narrowed to the table's entries.
- miss: the evidence names a place where no such symbol exists now.
- ambiguous: several definitions could be meant and nothing picks one.
- budget: the time budget ran out before every call of the file was resolved. The budget is checked inside a file as well as between files, so one file that holds a great deal of work stops where it is.
- export-chain-too-deep: the name is re-exported or aliased through more than 8 modules, and the graph stops following it there.
- unsupported-rule: the evidence leads somewhere no rule binds through, such as a `file:` dependency into a folder of the repository that is no workspace package, or a call through a TypeScript interface, which any object of its shape may answer without declaring `implements`, or a type annotation too large to read whole (over 4,096 parts), whose types past the cut are not recorded as type uses.
- fan-out-capped: a call through an interface or a base type may run more than 32 implementations or overrides; the ones past the first 32 in path order are not listed.
- metadata-unreadable: a manifest, lockfile or tsconfig the graph could not read, parse or follow; the note names the file and what failed.
- dynamic-base: a class names its base with an expression the graph does not read: `class Child extends mixin(Base)`, a Python base made by a call or a subscript (`Base[int]`; typing's own `Generic[T]` and `Protocol[T]` are no gap), a Ruby superclass such as `Struct.new(:a)`, or an `include`, `extend` or `prepend` of anything but a constant (`extend self` aside). What the class extends is not known, so it may be missing from what extends or implements any class of its language, and a method found on its other bases is bound as likely at most: the expression may define it first.

A caller list is a floor, and the brief says so with the reasons, when a call of the same name could not be bound to one definition, a call may reach it only possibly, a call through a value in the symbol's project could reach it, a file of its project was not read, a file that imports it was not resolved, a manifest or tsconfig governing its folder could not be read, or a walk was cut at it. Zero callers on a floor never means unused.

Every cut is recorded with what it left out: a symbol with more than 40 callers keeps its 20 nearest in the brief, the second hop keeps 20 callers of each caller, the walk stops at 200 symbols (what lies past that frontier is not counted), the brief shows 60 call sites, the summary keeps the first 200 places that used each changed public name (the brief shows 8), and the walk of `export *` re-exports opens at most 4,096 files in one version of the code (names re-exported past that are not compared). A call through an interface or a base type, a computed call on a table, and a call of a returned function each keep at most 32 possible targets, and the gap says how many were left out; the hub rule holds for the possible callers apart (20 of more than 40 listed), the brief shows 20 possible call sites, and the summary keeps 200 uses of each kind per symbol. Each barrel file is walked once, so two files that `export *` from each other end the walk where the cycle closes.

Languages: TypeScript, TSX, JavaScript, Python, Go, Ruby and Java. Files under `node_modules`, `dist`, `build`, `out`, `vendor` and the like, declaration files and minified files are left out.

A file is listed as not read, with the reason, when it is over `graph.max_file_bytes`, past the `graph.max_files` parse cap, past the time budget or the memory bound, or when its parse takes over two seconds (the parser is slow on some broken files). Every one of these holds for the changed files too: they are read first, so a cap reached late never loses them.

## Limits

- A dependency that a lockfile links by path (a pnpm `link:` entry, `link: true` in `package-lock.json`) or that yarn declares as `workspace:<path>` is bound to the workspace package of its name, not by where the path leads.
- A `file:` or `link:` path whose folders, once each `..` is taken by its spelling, hold a symbolic link is never bound, even where npm or pnpm would follow that link to the workspace package.
- A tsconfig `extends` given as a list (TypeScript 5) is not followed: it is a metadata-unreadable unknown, and the build is partial.

## The graph's folder

The graph lives in the repository, in `.openqodex/graph/`, which the folder's own `.gitignore` keeps out of git. It holds:

- `facts/`: what one parse of one file found, one file per content, so a file that did not change is never parsed again, in any build or any checkout of the repository.
- `generations/<build id>/`: one folder per build, never changed after it is written: what the build read (paths and content ids), the project model, what it could not read, and for a build kept as an index the resolved graph.
- `current` and `complete/<tree>`: the newest usable build and the newest complete build of each capture.
- `leases/`: one file per process that holds a build open. A build a review or a command holds is never removed while it runs.
- `meta.json`: the rates this machine measured, for the five-second rule.

A build's folder is written whole and checked against its own checksums before `current` moves to it, so a reader never sees half a build.

The graph also keeps a record in your home, outside the repository: `~/.openqodex/graph/<repo id>.json` holds the checksum of each build it saved and of each facts file it wrote, and says which repository it is for (the real path of the root folder and that folder's inode). A build is used only when the record holds its checksum, and a facts file only when its bytes match the checksum recorded when the graph wrote it. That holds even for a file your own user wrote there, for example by extracting an archive over the repository: a build copied into the folder or changed in it is never opened, a facts file whose bytes differ from its recorded checksum is parsed again and the run says how many, and a facts file with no checksum in the record, such as one written by a run that stopped before it finished, is parsed again. A record made for another repository, or for one that stood at the same path before, vouches for nothing, so a repository moved or copied to a new folder starts a new record and its first build parses every file. Each saved build and each collection drops the entries of builds and facts files the folder no longer holds, so the record stays the size of what is cached: about 110 bytes per facts file, 1.5 MB for 14,000 files.

The folder, its own folders and every file read from it must be yours and closed to writes by other users; when the folder is not, the graph is built in memory and the run says why, and a facts file that is not is parsed again. The collector keeps the newest build, the two newest complete builds and every build a live process holds, removes facts no kept build names (only when every kept build is complete, and only facts older than an hour), and keeps the folder under `graph.max_cache_mb` (512 MB by default). Over the bound it removes, oldest first, the facts no kept build names, then older builds no process holds (never the newest one), then the facts only those builds named, then the facts of kept builds no process holds. When the builds in use alone are larger than the bound, the build is still kept and the run says so. A build never writes facts past the bound: those files are parsed again next time, and the run says how many.

Each kept build's capture is a git tree in the repository's own objects, held by a local ref `refs/openqodex/graph/<tree>` while a build of it is kept, so `git show <tree>:<path>` shows the exact bytes the graph read after the files change. The ref is never pushed by a plain `git push`; `git push --mirror` would push it.

With `--report-dir` (the GitHub Action) nothing is written under `.openqodex/`: the graph is built in memory and nothing is kept.

## The five-second rule

Each build predicts its own time from what it will do: files with no cached facts at the parse rate this machine measured, cached facts at the measured read rate, and the rest per file. The first build uses 400 parses a second, 2,500 cached facts a second and 0.25 s per 1,000 files for the rest; later builds use the rates earlier builds measured (a rate is measured over 20 files or more).

- Under five seconds: the graph is built fresh from the cached facts, parsing only what is new.
- Over five seconds: a graph command loads the kept index of the same capture when there is one. A review, which compares two versions, and a capture with no kept index build under the time budget, changed files first, and keep an index for the next time.

The mode changes only after two builds in a row land on the other side of the line.

A large repository may be partial on its first reviews: the `graph.max_files` cap counts new parses only, so cached facts never count toward it and each review adds more. The brief and the report say so, and `openqodex graph build` completes it in one run (no parse cap, a ten-minute budget, the memory bound kept).

## The review's packet

`openqodex review` writes the graph's files into the review's snapshot, under `.openqodex-review/graph/`, before the snapshot is hashed, so the reviewer opens them inside the one folder it may read:

- `index.md`: one line per file below.
- `impact.json`: the summary the brief was made from.
- `changes.json`: every public name the change removed or bound elsewhere, every place that used each one with what it binds now (past the summary's cut), and the removed and moved symbols.
- `callers/<key>.json`: every caller of each touched or removed symbol, in pages of 500, past any cut the brief makes.
- `second-hop/<key>.json`, `callees/<key>.json`, `importers/<key>.json`: the same for the second hop, what the touched code calls, and who imports a changed file.
- `implementers/<key>.json`: what implements, overrides or extends a touched or removed symbol, and every call through it that may run another implementation, with its candidates, their total and how many past the cap are not listed.
- `references/<key>.json`: where a touched or removed symbol is used as a value or named as a type.
- `unknowns.json`: what the graph and its framework plugins could not see near the change, with causes; each framework gap names its plugin.
- `status.json`, `capabilities.json`: how the graph was built and what it can see.
- `base/<key>.txt`: the base version of each removed or moved symbol, labelled as not the code under review.

Every item of `callers/`, `second-hop/`, `implementers/` and `references/` says its level (`tier`: certain, likely or possible), and each page counts them (`counts`). `changes.json` and the files under `callers/`, `second-hop/`, `callees/`, `importers/`, `implementers/` and `references/` come in pages of 500 items. Each page names the next one in `next` (`changes.2.json`, then `changes.3.json`). Each page says `total`, the items on all the pages, and `totalExact`, true when they are the whole list. When they are not, `cut.omitted` says how many are missing, or is null when that cannot be counted.

Every file passes through the review's secret redaction. A repository that holds a path named `.openqodex-review` stops the review instead of being overwritten.

## The graph commands

`openqodex graph` asks the graph a question from the command line; `openqodex --help` lists it beside `init`, `review`, `update` and `trust`, and `openqodex graph help` lists the questions. Each question runs on a capture of your work tree, building or reusing the graph in `.openqodex/graph/`, or on a kept build with `--generation <id>`, which never builds and says when files changed since. `build --full` builds fresh from facts even over the five-second line. The command line, the MCP tools (below) and the review's walk answer through one query function, so one question about one build gets one answer.

```
openqodex graph build [--full]
openqodex graph status
openqodex graph capabilities
openqodex graph search <text>
openqodex graph symbol <name | file:line>
openqodex graph callers <name | file:line> [--file <path>] [--depth 1..3] [--tier certain,likely]
openqodex graph callees <name | file:line> [--depth 1..3]
openqodex graph implementers <class | interface | Class.method> [--depth 1..8]
openqodex graph references <name | file:line>
openqodex graph routes [<handler>] [--text <part of a pattern>]
openqodex graph tests <name | file:line>
openqodex graph path <from> <to> [--edges calls,inherits,imports] [--depth 1..8]
openqodex graph impact [<name | file:line>] [--base <ref>]
openqodex graph importers <file>
openqodex graph outline <file | folder>
openqodex graph packages [--project <folder>]
openqodex graph cycles [--level files | projects]
openqodex graph changes [--base <ref>]
openqodex graph unknowns [--file <path> | --name <name>]
openqodex graph explain <edge id>
```

A target is a name (`parse`, or `Parser.parse` for a method), or `file:line` for the innermost definition around that line; `--file` narrows a name to one file. A name that matches several definitions returns them all as candidates and answers nothing else.

| Question | What it answers |
| --- | --- |
| `callers` | Who calls it, one hop by default and up to three, each call site with its evidence and level. |
| `callees` | What it calls, and the calls inside it the graph could not bind (then the answer is a floor). |
| `implementers` | For a class or an interface, every class that extends or implements it, through every level (three by default, up to eight): `implements` clauses, a module-level object declared with the interface's type, and a Go type or a Python class whose methods cover an interface or a Protocol by name (likely). For `Class.method`, the methods that override or implement it, found by each language's lookup order (see "Dispatch, values and types"), then the overrides of those, to the depth asked. TypeScript matches an interface by its shape, so for an interface, a type and their members the answer is a floor: a class or an object of the same shape that does not declare it is not listed. A base written as an expression, such as `class Child extends mixin(Base)`, is not read either: the class is a `dynamic-base` gap, and while the graph holds such a class in the target's language, the answer is a floor that names it. When the depth asked stops the search with more past it, the answer says so and names them. |
| `references` | Who uses it as a value or a type: a function passed, assigned, returned or put in a table, a type named in an annotation, a cast, `instanceof` or `isinstance`, and the possible calls of a function value (a callee, an alias, a table or a returned value that may call it), each with its evidence. Field reads and writes and decorators are not read yet. |
| `routes` | Which routes map to a handler, or every route (`--text` narrows them by a part of the pattern or a route name), from the framework entries (below): each registration with its methods, its pattern, its name, whether an application serves it, and its handler edges with their evidence. What a plugin could not read, and a plugin that failed or ran out of budget, make the answer a floor. Where no framework plugin found an application in the repository, it answers `unsupported` and exits 2. |
| `tests` | Which tests reach it. Where a framework plugin found an application, the tests the framework entries link to it or to a route it handles, each with its category (a direct call, a request whose literal path matches the route, a test that names the route) and its evidence. Where none did, the calls that reach it in one or two hops from files named like tests (for example `*.test.ts`, `test_*.py`, `_test.go`, `_spec.rb`, or a file under `test/`, `tests/` or `spec/`) come back as leads, never counted, and the answer is a floor: a test that requests a route or reaches the code through a value makes no call here. No answer is coverage. |
| `path` | The shortest chain from the first point to the second over calls and inheritance (or the relations `--edges` names), at most eight hops, each hop with its edge. When there is none that way, the chain from the second to the first. When neither is found, the answer is a floor if a call the graph could not bind in the code it searched, or a file it did not read, could hold one. Imports join files: with `--edges imports` alone, a symbol stands for its file. |
| `impact` | The review's own walk: callers one and two hops out, the possible callers apart, every use that is not a call (the brief keeps 200 of each kind; this lists them all), callees, importers of the changed files and changed public names. With a target, as if its first line changed; with none, the change against its base, found as `review` finds it. |
| `outline` | What a file defines, or every file under a folder, with each definition's kind, lines and call sites in and out. |
| `packages` | Which projects import files of a project (a project is the folder of the nearest `package.json`, `go.mod`, `pom.xml`, `build.gradle` or `build.gradle.kts`, or a Python source root, else the repository root), with the import lines; with no project, every project with what it depends on and what depends on it. |
| `cycles` | Import cycles among files (the default) or among projects, each with the import lines that close it. |
| `changes` | The public names the change removed or bound elsewhere, every place that used each one and what it binds now, and the removed and moved symbols. |
| `unknowns` | What the graph could not see in a file or for a name, with causes. |
| `explain` | Why an edge exists: its evidence, the import or line that proved it, and the edges it rests on. |
| `status`, `capabilities` | How fresh and complete the graph is; what this installation can and cannot answer yet. |

`--json` prints the answer as it is:

- `items`: each with its edge id, its site, its evidence and its level.
- `counts`: the true totals by level, past any page; null when they cannot be known.
- `leads`: search hits and test leads, never counted.
- `unknown`: `floor`, true when the list may be short, with the reasons and the causes.
- `truncated`: how the answer was cut. `limit` is a page: `--cursor` takes the next one. `budget` with an exact `omitted` count is the token cut, and `--cursor` takes the next page. `budget` with `omitted` null is the time budget: the work stopped, names the points it had not expanded, and counts nothing past them. Its cursor asks again: the MCP server goes on with the work from where it stopped, and the command line, a new process each time, runs the question again from the start, so give it a larger `--budget-ms`. `depth` stops at the depth asked, with the same list.
- `graph`: the build that answered, its status and mode, and `freshness.laterEditsKnown`, true when a file the graph reads changed since that build: a source file, a manifest, a lockfile or a tsconfig.

Each answer holds 50 items by default; `--limit` takes up to 500. `--tokens <n>` cuts the items to a rough token budget and never the counts. Each question may take 1 second, `--budget-ms` changes it, and the work checks the time at every element it reads: each name, edge, file and project, and the sort. The MCP server keeps the lists and the stopped work of its 32 most recent questions, so its cursor reads the next page without walking again. Exit code 0 means an answer: a floor, a partial graph and an ambiguous name included. 2 means the question could not be answered: a name the graph does not hold, a question this build cannot answer, a bad request or a failed build. A graph command never exits 1.

Example, `openqodex graph callers formatDate` in a monorepo:

```
function formatDate at packages/core/src/dates.ts:4 (packages/core/src/dates.ts#formatDate@4:16)
packages/web/src/page.ts:12 in render, likely: Bound through @acme/core's entry packages/core/dist/index.js, built from packages/core/src/index.ts; no tsconfig paths, project reference or active source condition maps @acme/core to its source. [e.WyJjYWxscy...]
counts: 0 certain, 1 likely, 0 possible
graph: build 0mv03sdlq0000-1lg4-cd232ef6, ok, fresh
```

## Settings

The `graph` keys of `.openqodex/config.yaml` are in `config`: `graph.enabled`, `graph.budget_ms`, `graph.max_files` (new parses per build), `graph.max_file_bytes`, `graph.max_cache_mb` and `graph.max_heap_mb`. `--no-graph` turns the graph off for one review.

## Dispatch, values and types

Go follows chained results through fields only when each field's struct is declared in the caller's file.

A call through an interface or a base type binds to the member it declares, at the level its type is proved (an annotation, a declared result, a field type, `this` or `self`). Each implementation or override that may run instead is then a possible caller of the call's site, found by each class's own lookup, so an inherited implementation counts and an abstract member never does:

- TypeScript and JavaScript: the class, then its superclass chain, then the interfaces it implements. Implementations are the classes that declare `implements`, their subclasses, interfaces that extend it, and a module-level `const x: Repo = { ... }`. A call through an interface also leaves an `unsupported-rule` gap, since an object of the same shape may answer it without declaring anything. A generic argument never drops an implementation: TypeScript compares `Repo<A>` and `Repo<B>` by the shapes of `A` and `B`, which the graph does not hold whole.
- Python: the C3 method resolution order, so in `class D(B, C)` with `B(A)` and `C(A)` a method of `C` wins over `A`'s; an order that cannot be established is an `ambiguous` gap. Implementations are subclasses; for a `typing.Protocol`, also any class whose methods cover every member of the Protocol by name (likely: the signatures are not compared). Abstract members are those marked `@abstractmethod`; a method whose body only raises `NotImplementedError`, or is `...`, still runs when called, so it is an implementation like any other.
- Go: only an interface dispatches. Its implementations are the types whose method set, their own methods and those promoted by embedding at the shallowest depth, covers every method of the interface by name (likely; a pointer receiver means only the pointer type implements it). Two methods promoted at the same depth are an `ambiguous` gap, as Go refuses the selector. An interface that embeds one from outside the repository has no method-set implementations.
- Java: the class, then its superclass chain, then the interfaces, each visited once. Every member of the name on that path is collected, so an overload declared on a base class is not lost. A call keeps the members whose parameter count fits its argument count. A varargs member fits any count from its fixed parameters up. One member left binds at the receiver's tier. Several left bind as possible, and the note says how many members take that many arguments. A call whose argument list did not parse keeps every member as possible. A call on a declared type dispatches: a parameter, a local declared with its type, a field, a declared result or `this`. Its possible targets are the implementations and overrides with the same parameter count. A local declared with `var` from `new` binds to that class alone and does not dispatch. Interface and `abstract` methods are abstract members; `default` and `static` interface methods are not. A static method hides a static method of its base and never overrides it.
  A sub-interface default hides an inherited default only for zero-parameter methods, because the graph records parameter names and not types.
  A default beside an inherited abstract member with the same parameter count stays possible for the same reason.
  Type parameters use their first bound; generic arguments supply class parameter results, such as `Box<Repo>.get()` returning `Repo`.
  Additional bounds after `&`, wildcard bounds, and method type parameters inferred from arguments remain gaps.
  A bound used inside a generic argument loses its own arguments.
  For example, `T extends Supplier<Repo>` used as an argument keeps `Supplier` but loses `Repo`.
  A bound that names a later parameter, as in `A extends B, B extends Repo`, gives `A` no bound.
  A subclass of a generic class, as in `SBox extends Box<Repo>`, does not supply the parameter result: `sbox.get()` stays unresolved.
- Ruby: prepended modules (the last first), the class, included modules (the last first), then the superclass; on the class itself, its class methods, then the modules it extends, then the superclass's.

A value a constructor made in the same scope (`const r = new SqlRepo()`, `r = SqlRepo()`, `r := &Sql{}`, Java `var r = new SqlRepo()`), `super` and an explicit class name bind to that class alone. `this` and `self` dispatch to the overrides in subclasses. At most 32 implementations are kept per call, in path order; the rest is a `fan-out-capped` gap.

A function named where it is not called (an argument, the right side of an assignment, a returned value, an entry of an object, dict, list or map, a JSX attribute) is used as a value. It is a possible caller only when the graph reads why it may run:

- a callee in the repository whose body calls that parameter (`each(items, helper)` where `each` calls `cb`): the caller that passes it may run it;
- a local given it once (`const fn = helper; fn()`);
- a computed call on a literal table (`handlers[key]()` where `handlers = { save: onSave }`), which keeps its `dynamic` gap. The gap is narrowed to the table's entries only when nothing else can change the table: it is not exported, not a Python module's or a Go package's, never written through a member or an index, never passed on, and no method is called on it. Otherwise a function put in it later may be called, and the gap keeps the whole project;
- a function returned by name and then called (`pick(k)()`).

A wrapper that never calls its parameter, or returns something else, gives no possible caller to what it was given. A function passed to code outside the repository (`items.map(helper)`) is a use as a value and nothing more.

A class, interface or type named in an annotation, a cast (`as`, `satisfies`), `instanceof` or `isinstance` is a use as a type, and a method that overrides or implements a member of a base type is recorded as such: both are listed under a touched symbol, apart from its callers.

Not yet: field reads and writes, decorators, the alternatives of a union type, and TypeScript classes that match an interface without declaring it. `openqodex graph implementers` and `openqodex graph references` answer from these relations (see "The graph commands").

## The MCP server

`openqodex mcp` serves the same questions to an agent as MCP tools (the Model Context Protocol, the way an agent calls a local tool server). `init` registers it with each agent it installs into (`agents`), and the agent starts it; you never run it by hand. It talks over standard input and output only: it opens no network port, and nothing it reads or answers leaves your machine. The agent sends the answers to its own model, as it does with any file it reads.

There is one tool per question, each named `graph_<question>`: `graph_status`, `graph_capabilities`, `graph_search`, `graph_symbol`, `graph_callers`, `graph_callees`, `graph_importers`, `graph_implementers`, `graph_references`, `graph_routes`, `graph_tests`, `graph_path`, `graph_impact`, `graph_outline`, `graph_packages`, `graph_cycles`, `graph_changes`, `graph_unknowns` and `graph_explain`, and `graph_refresh`. A tool takes the target as `symbol` (a name, `Class.method` or `file:line`), `file` or `id`, and `limit`, `cursor`, `budget` (`items`, `tokens`, `ms`) and `generation` as the command line takes them. Each answers with the same JSON as `openqodex graph <question> --json`; an answer that could not be given (anything but an ambiguous name) is marked as a tool error. There is no tool that reads a file or searches text: the agent has its own.

- One repository. The server answers for the git repository of the folder the agent starts it in, or of `--repo <folder>`. A question that names another repository (`repo`), a path outside the repository (absolute, or with a `..` part), or a build id that is not one is refused, and nothing is read for it. Started outside a repository, it answers every question with that refusal and the reason.
- One build. Nothing is analysed until the first question. That question captures the work tree, builds or reuses the graph in `.openqodex/graph/` and holds the build with a lease; every later question is answered from that build, so a build a review or a command publishes meanwhile never changes the answers or removes the build. At most once a second a question checks the work tree, and `graph.freshness.laterEditsKnown` turns true when files changed since. `graph_refresh` captures again and moves to the new build; the old lease goes.
- `graph_changes`, and `graph_impact` with no target, compare the work tree with its base. Each holds the session's build first, as any question does, then builds that comparison. The last comparison is kept, and a question with its cursor and the same `base` pages it, with no new build; a question without a cursor compares again. A cursor names the base and the work tree it was made from, so one used with another base is refused.
- Builds run one at a time: the held build, a refresh and each comparison. At most four wait behind the running one; a question that needs a build past that is refused with the code `busy`.
- A cancelled question stops its walk: the walk runs in slices and the server reads a cancellation between them. A build in progress finishes and is kept; a comparison or a refresh still waiting is dropped. When the agent asks for progress, a build reports its lines as progress notifications.
- When the agent disconnects, the server releases its lease and exits. A server that crashed leaves a lease that keeps its build from the collector for 24 hours at most.

Example, `graph_callers` with `{ "symbol": "formatDate" }`, shortened:

```
{ "apiVersion": 1, "kind": "callers", "error": null,
  "target": { "id": "packages/core/src/dates.ts#formatDate@4:16", "name": "formatDate", "kind": "function", "file": "packages/core/src/dates.ts", "line": 4, "project": "packages/core", "score": 1 },
  "items": [ { "from": "packages/web/src/page.ts#render@10:16", "to": "packages/core/src/dates.ts#formatDate@4:16", "kind": "calls", "depth": 1,
               "site": { "file": "packages/web/src/page.ts", "line": 12, "column": 10, "tier": "likely", "evidence": "workspace-package", "note": "Bound through @acme/core's entry ...", "rule": "workspace-dist-src", "via": { "file": "packages/web/src/page.ts", "line": 1, "spec": "@acme/core" } },
               "edge": "e.WyJjYWxscy...", "fromName": "render", "toName": "formatDate" } ],
  "counts": { "certain": 0, "likely": 1, "possible": 0 }, "leads": [],
  "unknown": { "floor": false, "reasons": [], "causes": {}, "examples": [] },
  "truncated": { "by": null, "omitted": 0, "omittedExact": true, "cursor": null },
  "graph": { "generation": "0mv03sdlq0000-1lg4-cd232ef6", "status": "ok", "mode": "fresh", "freshness": { "laterEditsKnown": false }, ... } }
```

## Framework entries: Django and Rails

The Django and Rails plugins read those frameworks' own conventions and add what they declare to the brief, in the tables below, which list what every framework plugin finds (the Express, React, Next.js, FastAPI and Go net/http plugins too, next section). Django or Rails is read only when a manifest of the project declares it (`django` in a Python manifest such as `requirements.txt` or `pyproject.toml`, `rails` in the `Gemfile`) and the project has the framework's own marker: a settings module that assigns `INSTALLED_APPS` or `ROOT_URLCONF` for Django, `config/application.rb`, a `routes.draw` block in `config/routes.rb` or `bin/rails` for Rails. The dependency alone never makes an application, and a name that only looks like the framework's (`path` from `os`, a `render` of your own, a class named `PostsController` outside `app/controllers`) makes nothing. Settings, routes and config files are parsed as text and never imported or run.

For a change, the brief adds "Framework entries this change reaches", in tables:

- the routes whose handler is the touched code, or reaches it through calls (up to three hops), with the route's methods, its full path with every `include()`, `namespace` or `scope` prefix composed, its name, where it is declared and the handler as written;
- routes the change declares, and routes whose handler is gone: a route stays registered when its view or action is deleted, and the brief says it has no handler now; a handler that is computed, wrapped or ambiguous is there, and the brief says so rather than calling it gone;
- the templates and views the touched code renders, and the code that renders a changed template;
- a touched model's migrations, and what a changed migration changes;
- the framework role of the touched code (model, command, job, mailer, signal receiver, template tag, component, hook, middleware);
- the tests that reference, call or may request the touched code: a test that calls it, a test request whose literal path matches the route's pattern, a test that names the route, or a spec that names the class. These are static links, never coverage.

Each table shows twelve rows; the rest, uncut, are in the review packet's `frameworks.json`, which the table's last line names. Every value quoted from the repository in these tables (a route path or name, a template name, a handler as written) is on one line, cut to 120 characters, inside a code span or escaped, so text in your repository cannot start a line of the brief.

Levels follow the rest of the graph. A view bound through an import is certain; a Rails action found by its controller's path, a template found by its name under a templates or views folder, and a table name made by Rails or Django's naming rule are likely, with the note saying so; the HTTP methods of a class view, a template that several folders hold and a test request that several routes match are possible.

What the plugins cannot see is said as a gap: a computed route path, include, template name, request path, signal or settings key (`dynamic`; a route under a computed prefix keeps its known part, shown as `{computed}accounts/login/`), a URL list a loop, a `del`, a `remove` or a write by index or slice changes (`dynamic`; a router joined into a list that a later statement replaces is not served, and a list joined with `+` holds only what it held at the join), a block inside a model's class body (`unsupported-rule`), a view that is not defined (`miss`), a URL entry whose function is not Django's (`unsupported-rule`), and every cap (`fan-out-capped` or `budget`), a field whose base classes go deeper than the plugin follows, a test request that matches more routes than it links, and a work budget used up inside a request. The brief's last framework table, and the packet's `unknowns.json` and `frameworks.json`, list every gap that can hide an entry of the change: each gap in a changed file or at the site of a listed route or a mount it rests on, each gap of an application or project that holds a changed file or a listed route wherever its site is (a computed root URL module or mount prefix, a cap), each cap a plugin counts across the whole build, and the summary's own cuts: the touched symbols past the first 25, whose entries are not looked for, and a route walk that stopped after 2,000 callers. A gap that names no relation, such as a file whose facts passed the per-file cap, counts against every question, so `routes` and `tests` answer it as a floor. A plugin reads no file over 1 MiB, keeps at most 10,000 route registrations and 20,000 entities per application, and matches test requests against routes by hand; the Django plugin's whole resolve draws on one work budget of two million steps, and the Rails plugin's route expansion and test matching on another; a plugin that runs out stops that work and says so as a `budget` gap. No regular expression from your repository is ever built or run. The facts the Django and Rails plugins cache under `.openqodex/graph/` keep a string from your code only where the plugin reads its value: a route path or pattern and the route options that build it (a prefix, a name, a namespace, a module, a `controller#action`, the actions and HTTP methods it answers), a module that `include()` or `ROOT_URLCONF` names, a template name, a model, association, table, column or field name, and the name (never the value) of a config key or an ENV entry. A route path and a test request keep their path alone (no scheme, host, user, query string or fragment), a Rails route target is kept only when it is `controller#action`, and any other literal, such as a setting's value, a route's `constraints:` or `format:`, or a template tag's name, is not kept. A string over 512 characters is not kept: the plugin reads it as a value it does not know and says so as a gap, so two long strings never match on the part they share. A key-shaped token in a kept string (a run of letters, digits, `_` and `-` with a known key prefix such as `sk_live_` or `ghp_` at its start or after a `_` or `-` in it, or an opaque run of sixteen or more letters and digits) is replaced by `[redacted:` and the first eight hex digits of its SHA-256 `]`: the same token always reads the same, so a route or a template named with one still matches its request or its file, and two tokens never match. A string whose percent-encoded form hides a key is not kept at all. The packet and the brief also remove every secret the scanners found.

## Framework plugin: JUnit

| Plugin | Detection | Output |
|---|---|---|
| JUnit 4 and JUnit 5 | Proven annotation identity, through an import or a qualified name | Test and fixture method roles. Direct test calls retain each call's tier. |

JUnit uses exact annotation names. A Maven or Gradle dependency alone detects nothing.
Each Java project gets one application, anchored to its first proven annotation.
Supported test annotations are `Test`, `RepeatedTest`, and `ParameterizedTest` from their JUnit packages.
JUnit 5 lifecycle annotations are `BeforeEach`, `BeforeAll`, `AfterEach`, and `AfterAll`.
JUnit 4 lifecycle annotations are `Before`, `BeforeClass`, `After`, and `AfterClass`.
Lifecycle annotations give fixture roles. Fixture calls do not link tests to production methods.
Enclosing and inherited nested types shadow imports. A single-type import shadows a same-package type.
A same-package type shadows a star import. A competing repository type produces a file gap that affects tests.
One JUnit star with only unresolved external competitors gives a likely role, names those imports, and produces no gap.
Star imports from `java.*` and `javax.*` never compete with JUnit annotations.
The brief names directly calling test methods with their call tiers. Ambiguous overload calls remain possible.
A test that calls a helper is not linked to the helper's callees.
Disabled tests are still listed. The mapper reads `calls`, not `dispatches_to`.
An implementation reached only by dispatch is not linked. An absent link never means untested.
Maven and Gradle dependency versions are not read by this plugin.
The reader keeps at most 1,999 candidate annotations per file. A reader cap produces a gap that affects tests.

## Framework plugins: Express, React, Next.js, FastAPI and Go net/http

After the call graph is built, five plugins read the frameworks of JavaScript, TypeScript, Python and Go code: Express, React, Next.js, FastAPI and Go's net/http. Each reads its facts from the same parse tree as the call graph, so a route written in a comment or a string is never a route, and a string is decoded by its language's own escape rules. A plugin runs only in a project whose manifest declares the framework (`express`, `react`, `next`, `fastapi`; net/http is Go's standard library), and the dependency alone proves nothing: a value is an Express application only when the express module's own export made it, a FastAPI application only when fastapi's `FastAPI` made it, and a call on an object of the repository's own that happens to have a `get` method is no route. A name counts only through the binding it reads at that place: a parameter or a local of the same name shadows the import (a factory parameter named `express` makes no application), and a name written twice proves no value, so `let path = "/old"; path = "/new"; app.get(path, h)` is an unknown, not a route. What the plugins find is kept with the graph, apart from the calls.

What each plugin finds:

- Express: applications made by `express()`, routers made by `express.Router()` or `Router()`, routes registered with `get`, `post`, `put`, `patch`, `delete`, `options`, `head`, `all` and `route(...)`, and routers and middleware added with `use`, composed under their mount paths (`usersRouter.get("/:id", getUser)` mounted at `/users` is `GET /users/:id`), with the middleware in effect for each route in order. A supertest request such as `request(app).get("/users/42")` is linked to the matching routes of the application it was given.
- React: components (a top-level function with a capitalised name whose own body returns JSX, or a class on React's `Component` or `PureComponent`), hooks (a `use...` function that calls a hook of React or of the repository; the name alone is not enough), which component renders which through JSX elements bound like calls, and tests that render a component with Testing Library, react-test-renderer or Enzyme.
- Next.js: the routes of the app router and the pages router, read from the file tree with route groups dropped, private `_folders` serving nothing and dynamic segments kept as written (`/blog/[slug]`), each bound to its file's default export or its exported `GET`, `POST` and other method functions; layouts, templates, loading, error and not-found boundaries, and client components; the middleware and the routes its matcher selects; and server actions, which have no URL of their own.
- FastAPI: applications and routers made by fastapi's `FastAPI()` and `APIRouter()`, routes registered by decorators (`@app.get`, `@router.post`, `api_route`, `websocket`) and by `add_api_route`, prefixes joined as FastAPI joins them (`include_router(router, prefix="/items")` with `APIRouter(prefix="/v1")` and `@router.get("/{item_id}")` is `/items/v1/{item_id}`), the dependencies that run before each handler in order (`Depends`, `Security`), Pydantic models, pytest tests and `TestClient` requests, each joined to the path of the client's base URL as httpx joins it (`TestClient(app, base_url="http://testserver/api/")` and `client.get("items")` request `/api/items`; a base URL that is computed leaves the request unknown).
- Go net/http: each mux made by `http.NewServeMux()` and each project's default mux, routes registered with `Handle` and `HandleFunc` with Go 1.22 method patterns (`"GET /items/{id}"`), handlers that are functions, method values, `http.HandlerFunc(f)` conversions or types with a `ServeHTTP` method, middleware wrappers, muxes mounted under others through `http.StripPrefix`, go test functions and `httptest.NewRequest` requests.

Applications never merge: two Express applications, two FastAPI applications, two muxes and the two Next.js routers each keep their own routes, and a router mounted on two applications gives one route for each.

A route is kept apart from its handler. A handler that is missing, inline, from a dependency or wrapped (`asyncHandler(getItem)`, `logging(h)`) leaves the route in place with the handler's status and an unknown that says why, so deleting a handler never deletes its route. A wrapped handler is not bound to the function inside the wrapper, because nothing yet proves the wrapper calls it; a Go wrapper is listed as the route's middleware. A route whose own path is computed at run time, such as `` app.get(`/v${version}/status`, status) ``, is not a route: it is an unknown of cause dynamic that names its handler. A route under a mount or include prefix computed at run time is kept with no pattern. A FastAPI function wrapped by another decorator below its route decorator is registered as that decorator's result, so its handler is unresolved with an unknown naming the decorator. FastAPI copies a router's routes when the router is included, so a route added to the router after the include, in the same module, is not served by that application; a route added from another module, where the order is not known, is kept with an unknown that says so.

A test link says what the test does, never that it covers anything: the test calls a function (as sure as the call), renders a component (as sure as the element's binding), or sends a request whose literal method and path match a route of the application it names (likely; possible when routes of several Go muxes in the project match).

Not read yet: Express sub-applications mounted with `use` (each mount is an unknown), Next.js parallel (`@slot`) and intercepting (`(.)segment`) routes (each is an unknown), gin, echo and chi, FastAPI sub-dependencies and `dependency_overrides`, a literal `fetch("/api/users")` matched to a route, and which components read a React context.

The plugins read the repository's files, so a stranger controls what they read, and every read is bounded. A file over 256 KiB is not read, nothing is read in a region the parser could not read, and patterns are matched segment by segment, never with a regular expression made from the repository's text. A list the reader cuts, such as a call with more than 24 arguments or a longer matcher list, is never read as whole: the handler past the cut is not named and the cut is an unknown. A middleware or a dependency that cannot be bound is an unknown in its chain, and a test request the matcher cannot compare with a route (more than 64 segments, a pattern with a regular expression) is an unknown, not a missing link. A Next.js matcher entry the plugin cannot compare links its middleware to a route as possible, with the reason, and an entry of more than 64 segments is an unknown at the matcher. Each budget counts the work of the whole build (facts read, names looked up, mounts followed, routes made, middleware and test edges made, test requests and pattern steps matched) and, when reached, stops that work and says so with one unknown; one route keeps at most 64 middleware, and mounts are followed at most 8 levels deep. The tests build a hostile repository of more than 1 MiB for each plugin and require the plugin to finish in under a second. The facts the plugins cache under `.openqodex/graph/` hold a string from your code only where a plugin reads one: a route's path or pattern, a prefix, an HTTP method, a request's target, a Next.js middleware matcher, the `"use client"` and `"use server"` directives, or a constant one of those names, a later piece of a path included (the `v1` of `` `/${VERSION}/users` ``) but not a piece of an absolute URL. Any other literal, such as a key passed to a client, a header, a decorator's argument or a test's title, is not kept, and a URL keeps no user, password, query string or fragment. A string kept follows the Django and Rails plugins' rule (above), applied to the whole value a concatenation and the constants it names make, so pieces that each pass cannot rebuild a key, and a concatenation the rule would change is not kept. After an absolute URL (`"https://api.example.com/bot" + rest`), a later piece is kept only as a piece of the URL's path, and a URL with no host yet (`"https://" + rest`) is not kept. A request's target loses everything from its first `?` or `#`; a route's path is kept as the router writes it. An Express `get` call may be a route or a test agent's request, so its path keeps a `?` that ends a parameter (`/users/:id?`), loses a query of `name=value`, and is not kept at all when it holds any other `?` or a `#`. A constant is kept only for the binding the path reads, so a function's own value of the same name is not. What the plugins find is drawn from those facts, so the same holds for a kept build's framework data and for the graph files a review hands its reviewer.
