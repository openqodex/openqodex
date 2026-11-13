// The code graph on real code. Two failures this file guards against:
// 1. The graph misses a real caller (recall) or invents one (precision) on a
//    large public repo. Four repos are pinned to a commit; for selected symbols
//    in each, every call site below was read by hand from `git grep -n` at
//    that commit. `calls` are the sites the resolution rules can bind (an
//    import, a known receiver type, self); `gaps` are real calls the rules do
//    not bind by design (a receiver whose type no annotation or constructor
//    names), kept so the overall recall is honest. `dispatch` are the sites
//    of calls through an interface or a base type that must reach the
//    target's implementations and overrides as `dispatches_to`. The test
//    checks each listed site against grep, requires every `calls` and
//    `dispatch` site, prints recall and precision, and fails when precision
//    drops under 0.9.
// 2. The brief's blast radius block does not name a caller's call line on a
//    cross-file change (TypeScript and Python), run through the built CLI.
// 3. The saved report of a Java change does not name its callers with their
//    tiers: a static call from the same package (certain) and a call through
//    an interface field (possible, to the implementation the change edits).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildGraph, openStore } from "../../packages/graph/src/index.js";
import { git, readJson, reportDir, run } from "./support.js";
import type { ImpactSummary } from "@openqodex/core";
import { cacheFolder, removeTempDirs, tempDir } from "../temp-dirs.mjs";

afterAll(removeTempDirs);

type Target = { file: string; symbol: string; grep: string[]; calls: string[]; gaps?: string[]; dispatch?: string[] };
type Repo = { name: string; url: string; sha: string; targets: Target[] };

const REPOS: Repo[] = [
  {
    name: "nest",
    url: "https://github.com/nestjs/nest.git",
    sha: "35142c3eca8edaaf6abc5984d915da2fbd458aa2",
    targets: [
      {
        // Three calls have a result type whose source the graph can resolve.
        file: "packages/common/interfaces/features/arguments-host.interface.ts",
        symbol: "WsArgumentsHost.getPattern",
        grep: ["getPattern"],
        calls: [
          "integration/websockets/src/request.filter.ts:8",
          "integration/websockets/src/request.interceptor.ts:7",
          "packages/websockets/exceptions/base-ws-exception-filter.ts:59",
        ],
        // Both hosts are typed ExecutionContextHost values. Its result imports WsArgumentsHost through @nestjs/common/internal.
        // The graph does not read the referenced build config's source mapping for that JavaScript entry.
        gaps: [
          "packages/core/test/helpers/execution-context-host.spec.ts:75",
          "packages/websockets/test/context/ws-context-creator.spec.ts:302",
        ],
      },
      {
        file: "packages/common/utils/validate-each.util.ts",
        symbol: "validateEach",
        grep: ["validateEach"],
        calls: [
          "packages/common/decorators/core/exception-filters.decorator.ts:45",
          "packages/common/decorators/core/exception-filters.decorator.ts:59",
          "packages/common/decorators/core/use-guards.decorator.ts:40",
          "packages/common/decorators/core/use-guards.decorator.ts:50",
          "packages/common/decorators/core/use-interceptors.decorator.ts:43",
          "packages/common/decorators/core/use-interceptors.decorator.ts:57",
          "packages/common/decorators/core/use-pipes.decorator.ts:41",
          "packages/common/decorators/core/use-pipes.decorator.ts:45",
          "packages/common/test/utils/validate-each.util.spec.ts:11",
          "packages/common/test/utils/validate-each.util.spec.ts:17",
        ],
      },
      {
        file: "packages/core/injector/container.ts",
        symbol: "NestContainer.getModuleByKey",
        grep: ["getModuleByKey"],
        calls: [
          "packages/core/inspector/graph-inspector.ts:168",
          "packages/core/middleware/container.ts:24",
          "packages/core/middleware/middleware-module.ts:150",
          "packages/core/middleware/middleware-module.ts:151",
          "packages/core/middleware/middleware-module.ts:197",
          "packages/core/router/router-explorer.ts:191",
          "packages/core/test/injector/container.spec.ts:264",
          "packages/microservices/listeners-controller.ts:76",
          "packages/websockets/web-sockets-controller.ts:156",
        ],
      },
      {
        // `sign` is also a method of the cookie-signature library, called in the same tests.
        file: "packages/core/helpers/cookies/cookie-signer.ts",
        symbol: "CookieSigner.sign",
        grep: ["sign"],
        calls: [
          "packages/core/adapters/http-adapter.ts:481",
          "packages/core/test/helpers/cookies/cookie-signer.spec.ts:19",
          "packages/core/test/helpers/cookies/cookie-signer.spec.ts:22",
          "packages/core/test/helpers/cookies/cookie-signer.spec.ts:28",
          "packages/core/test/helpers/cookies/cookie-signer.spec.ts:40",
          "packages/core/test/helpers/cookies/cookie-signer.spec.ts:46",
          "packages/core/test/helpers/cookies/cookie-signer.spec.ts:57",
          "packages/core/test/helpers/cookies/cookie-signer.spec.ts:64",
          "packages/core/test/helpers/cookies/cookie-signer.spec.ts:65",
          "packages/core/test/helpers/cookies/cookie-signer.spec.ts:66",
          "packages/core/test/helpers/cookies/cookie-signer.spec.ts:72",
          "packages/core/test/helpers/cookies/request-cookies.spec.ts:54",
          "packages/core/test/helpers/cookies/request-cookies.spec.ts:75",
          "packages/core/test/router/route-params-factory.spec.ts:194",
        ],
      },
      {
        file: "packages/core/middleware/route-info-path-extractor.ts",
        symbol: "RouteInfoPathExtractor.extractPathsFrom",
        grep: ["extractPathsFrom"],
        calls: [
          "packages/core/middleware/middleware-module.ts:326",
          ...[21, 28, 40, 47, 64, 71, 79, 87, 97, 105, 113, 125, 133].map((l) => `packages/core/test/middleware/route-info-path-extractor.spec.ts:${l}`),
        ],
      },
      {
        file: "packages/common/utils/cli-colors.util.ts",
        symbol: "isColorAllowed",
        grep: ["isColorAllowed"],
        calls: [
          "packages/common/services/console-logger.service.ts:212",
          "packages/common/test/utils/cli-colors.util.spec.ts:17",
          "packages/common/test/utils/cli-colors.util.spec.ts:22",
          "packages/common/test/utils/cli-colors.util.spec.ts:27",
          "packages/common/utils/cli-colors.util.ts:5",
        ],
      },
    ],
  },
  {
    name: "django",
    url: "https://github.com/django/django.git",
    sha: "7847227a3fecde4b2a169552b84c60c6286b6025",
    targets: [
      {
        file: "django/contrib/admin/widgets.py",
        symbol: "url_params_from_lookup_dict",
        grep: ["url_params_from_lookup_dict"],
        calls: [
          "django/contrib/admin/options.py:514",
          "django/contrib/admin/widgets.py:202",
          "tests/admin_widgets/tests.py:356",
          "tests/admin_widgets/tests.py:357",
          "tests/admin_widgets/tests.py:365",
          "tests/admin_widgets/tests.py:366",
        ],
      },
      {
        file: "django/db/backends/utils.py",
        symbol: "split_tzname_delta",
        grep: ["split_tzname_delta"],
        calls: [
          "django/db/backends/mysql/operations.py:88",
          "django/db/backends/oracle/operations.py:126",
          "django/db/backends/postgresql/operations.py:108",
          "django/db/backends/sqlite3/_functions.py:129",
          "tests/backends/test_utils.py:91",
        ],
      },
      {
        // `signature` is also inspect.signature and django.utils.inspect.signature.
        file: "django/core/signing.py",
        symbol: "Signer.signature",
        grep: ["signature"],
        calls: [
          "django/core/signing.py:245",
          "django/core/signing.py:252",
          "tests/signing/tests.py:21",
          "tests/signing/tests.py:29",
          "tests/signing/tests.py:34",
          "tests/signing/tests.py:43",
          "tests/signing/tests.py:44",
          "tests/signing/tests.py:59",
        ],
      },
      {
        // `login` is also a method of the test client, the admin site and smtplib; views.py imports it as auth_login.
        file: "django/contrib/auth/__init__.py",
        symbol: "login",
        grep: ["login", "auth_login"],
        calls: [
          "django/contrib/auth/middleware.py:172",
          "django/contrib/auth/views.py:116",
          "django/contrib/auth/views.py:325",
          "django/test/client.py:894",
          "tests/auth_tests/test_login.py:17",
          "tests/auth_tests/test_login.py:24",
          "tests/auth_tests/test_login.py:32",
        ],
      },
      {
        file: "django/db/models/fields/__init__.py",
        symbol: "Field.has_default",
        grep: ["has_default"],
        calls: [
          ...[1068, 1150, 1159, 1236, 1493, 1626, 2623, 2755, 2781].map((l) => `django/db/models/fields/__init__.py:${l}`),
          "django/db/models/fields/related.py:1109",
        ],
        // Fields iterated from _meta, and self inside mixins that do not inherit Field.
        gaps: [
          "django/db/backends/base/schema.py:477",
          "django/db/backends/base/schema.py:1216",
          "django/db/migrations/autodetector.py:1163",
          "django/db/migrations/autodetector.py:1183",
          "django/db/migrations/autodetector.py:1343",
          "django/db/migrations/operations/models.py:768",
          "django/db/models/base.py:1118",
          "django/db/models/fields/__init__.py:1407",
          "django/db/models/fields/mixins.py:42",
          "django/forms/models.py:76",
          "django/forms/models.py:1220",
          "tests/model_fields/test_booleanfield.py:114",
        ],
      },
    ],
  },
  {
    name: "etcd",
    url: "https://github.com/etcd-io/etcd.git",
    sha: "64f26db45f5feb2c491a9eb82768a2f41fc857df",
    targets: [
      {
        // KV returns WatchableKV, which embeds KV. Both chained calls bind to KV.Commit.
        file: "server/storage/mvcc/kv.go",
        symbol: "KV.Commit",
        grep: ["Commit"],
        calls: [
          "server/etcdserver/server.go:2099",
          "server/etcdserver/snapshot_merge.go:36",
        ],
      },
      {
        file: "client/v3/op.go",
        symbol: "WithCountOnly",
        grep: ["WithCountOnly"],
        calls: [
          "cache/cache.go:261",
          "client/v3/kubernetes/client.go:76",
          "etcdctl/ctlv3/command/get_command.go:208",
          "server/proxy/grpcproxy/kv.go:192",
          "tests/framework/integration/integration.go:215",
          "tests/integration/cache_test.go:1546",
          "tests/integration/clientv3/kv_test.go:457",
          "tests/integration/tracing_test.go:66",
          "tools/benchmark/cmd/range.go:125",
        ],
      },
      {
        file: "pkg/httputil/httputil.go",
        symbol: "GracefulClose",
        grep: ["GracefulClose"],
        calls: [
          "server/etcdserver/api/rafthttp/snapshot_sender.go:169",
          ...[615, 622, 631, 642, 675].map((l) => `server/etcdserver/api/rafthttp/stream.go:${l}`),
          "server/lease/leasehttp/http.go:291",
          "server/lease/leasehttp/http.go:298",
        ],
      },
      {
        file: "server/auth/store.go",
        symbol: "NewTokenProvider",
        grep: ["NewTokenProvider"],
        calls: [
          ...[50, 73, 92, 905, 974, 1049, 1103].map((l) => `server/auth/store_test.go:${l}`),
          "server/etcdserver/apply/auth_test.go:91",
          "server/etcdserver/apply/auth_test.go:1066",
          "server/etcdserver/apply/uber_applier_test.go:55",
          "server/etcdserver/server.go:355",
        ],
      },
      {
        // `Step` is also raft's Node.Step and the robustness model's EtcdState.Step.
        file: "pkg/traceutil/trace.go",
        symbol: "Trace.Step",
        grep: ["Step"],
        calls: [
          "pkg/traceutil/trace.go:156",
          "pkg/traceutil/trace_test.go:84",
          "server/etcdserver/read/read.go:126",
          "server/etcdserver/read/read.go:142",
          "server/etcdserver/txn/range.go:78",
          "server/etcdserver/txn/range.go:81",
          "server/etcdserver/txn/txn.go:59",
          ...[140, 176, 347, 414, 1048].map((l) => `server/etcdserver/v3_server.go:${l}`),
          "server/storage/mvcc/kvstore.go:258",
          "server/storage/mvcc/kvstore.go:276",
          ...[86, 92, 109, 150, 234, 258, 262, 265, 290].map((l) => `server/storage/mvcc/kvstore_txn.go:${l}`),
        ],
      },
      {
        // `KeyBytes` is also a method of Cmp.
        file: "client/v3/op.go",
        symbol: "Op.KeyBytes",
        grep: ["KeyBytes"],
        calls: [
          ...[90, 105, 195, 280].map((l) => `client/v3/leasing/cache.go:${l}`),
          ...[219, 243, 250, 317, 364, 387].map((l) => `client/v3/leasing/kv.go:${l}`),
          ...[98, 110, 127].map((l) => `client/v3/leasing/txn.go:${l}`),
          "client/v3/namespace/kv.go:89",
          "client/v3/namespace/kv.go:144",
          "tests/integration/clientv3/lease/leasing_test.go:927",
          ...[226, 232, 238].map((l) => `tests/robustness/model/history.go:${l}`),
        ],
        // A loop over the slice an unexported helper returns.
        gaps: ["client/v3/leasing/txn.go:163", "client/v3/leasing/txn.go:175"],
      },
    ],
  },
  {
    // Java, a Maven build with several modules: nested classes named
    // `Adapter` in three files, and overloads with different argument counts.
    name: "gson",
    url: "https://github.com/google/gson.git",
    sha: "57731049da3e415be3d5d34db1ca3b80f3c73810",
    targets: [
      {
        // Bare calls from the nested classes of GsonTypes to their outer
        // type's static method, and a call from the same package with no import.
        file: "gson/src/main/java/com/google/gson/internal/GsonTypes.java",
        symbol: "GsonTypes.canonicalize",
        grep: ["canonicalize"],
        calls: [
          ...[107, 526, 527, 532, 590, 640, 647].map((l) => `gson/src/main/java/com/google/gson/internal/GsonTypes.java:${l}`),
          "gson/src/main/java/com/google/gson/reflect/TypeToken.java:82",
          "gson/src/main/java/com/google/gson/reflect/TypeToken.java:100",
          "gson/src/test/java/com/google/gson/internal/GsonTypesTest.java:111",
        ],
      },
      {
        // An explicit import in every package but its own.
        file: "gson/src/main/java/com/google/gson/internal/TroubleshootingGuide.java",
        symbol: "TroubleshootingGuide.createUrl",
        grep: ["createUrl"],
        calls: [
          "gson/src/main/java/com/google/gson/internal/ConstructorConstructor.java:86",
          "gson/src/main/java/com/google/gson/internal/bind/ReflectiveTypeAdapterFactory.java:338",
          "gson/src/main/java/com/google/gson/internal/bind/TypeAdapters.java:78",
          "gson/src/main/java/com/google/gson/internal/bind/TypeAdapters.java:86",
          "gson/src/main/java/com/google/gson/internal/reflect/ReflectionHelper.java:54",
          "gson/src/main/java/com/google/gson/reflect/TypeToken.java:114",
          "gson/src/main/java/com/google/gson/reflect/TypeToken.java:130",
          "gson/src/main/java/com/google/gson/stream/JsonReader.java:1945",
          "gson/src/main/java/com/google/gson/stream/JsonReader.java:1959",
        ],
      },
      {
        // An interface method called through fields, typed locals, declared
        // results and `var` locals set from a call's result, two of them
        // inside lambdas; ThrowingObjectConstructor and
        // InstanceCreatorConstructor implement it.
        file: "gson/src/main/java/com/google/gson/internal/ObjectConstructor.java",
        symbol: "ObjectConstructor.construct",
        grep: ["construct"],
        calls: [
          "gson/src/main/java/com/google/gson/internal/bind/CollectionTypeAdapterFactory.java:81",
          "gson/src/main/java/com/google/gson/internal/bind/JsonAdapterAnnotationTypeAdapterFactory.java:96",
          "gson/src/main/java/com/google/gson/internal/bind/MapTypeAdapterFactory.java:183",
          "gson/src/main/java/com/google/gson/internal/bind/ReflectiveTypeAdapterFactory.java:577",
          ...[59, 73, 128, 149, 161, 164, 168, 177, 245, 257].map((l) => `gson/src/test/java/com/google/gson/internal/ConstructorConstructorTest.java:${l}`),
        ],
        dispatch: [
          "gson/src/main/java/com/google/gson/internal/bind/CollectionTypeAdapterFactory.java:81",
          "gson/src/main/java/com/google/gson/internal/bind/JsonAdapterAnnotationTypeAdapterFactory.java:96",
          "gson/src/main/java/com/google/gson/internal/bind/MapTypeAdapterFactory.java:183",
          "gson/src/main/java/com/google/gson/internal/bind/ReflectiveTypeAdapterFactory.java:577",
          ...[59, 73, 128, 149, 161, 164, 168, 177, 245, 257].map((l) => `gson/src/test/java/com/google/gson/internal/ConstructorConstructorTest.java:${l}`),
        ],
      },
      {
        // A static import, and bare calls inside its own class.
        file: "gson/src/main/java/com/google/gson/GsonBuilder.java",
        symbol: "GsonBuilder.newImmutableList",
        grep: ["newImmutableList"],
        calls: [
          "gson/src/main/java/com/google/gson/Gson.java:263",
          "gson/src/main/java/com/google/gson/Gson.java:264",
          "gson/src/main/java/com/google/gson/Gson.java:267",
          "gson/src/main/java/com/google/gson/GsonBuilder.java:999",
        ],
      },
      {
        // `get(TypeToken)`, the first of two overloads; the calls with two
        // arguments are `get(TypeToken, boolean)`'s and must not be counted here.
        file: "gson/src/main/java/com/google/gson/internal/ConstructorConstructor.java",
        symbol: "ConstructorConstructor.get",
        grep: ["get"],
        calls: [58, 72, 127, 148, 161, 164, 168, 176, 244, 256].map((l) => `gson/src/test/java/com/google/gson/internal/ConstructorConstructorTest.java:${l}`),
      },
    ],
  },
];

const CLONES = cacheFolder("openqodex-graph-acceptance");

// A shallow clone of exactly `sha`, reused when it is already there.
function clone(repo: Repo): string {
  const dir = join(CLONES, repo.name);
  if (existsSync(join(dir, ".git")) && git(dir, "rev-parse", "HEAD").trim() === repo.sha) return dir;
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "fetch", "-q", "--depth", "1", repo.url, repo.sha);
  git(dir, "checkout", "-q", "--force", repo.sha);
  return dir;
}

function grepSites(dir: string, words: string[]): Set<string> {
  const out = new Set<string>();
  for (const w of words) {
    let text = "";
    try {
      text = execFileSync("git", ["grep", "-n", "-w", w], { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const m = /^([^:]+):(\d+):/.exec(line);
      if (m) out.add(`${m[1]}:${m[2]}`);
    }
  }
  return out;
}

describe.skipIf(process.env.OPENQODEX_E2E_OFFLINE === "1")("graph acceptance on four public repos", () => {
  for (const repo of REPOS) {
    it(`${repo.name} at ${repo.sha.slice(0, 12)}: every bindable caller found, precision at least 0.9`, async () => {
      const dir = clone(repo);
      // The graph folder of the clone itself, as a review keeps it; the
      // record of its builds in a temporary OpenQodex home.
      const opened = await openStore(dir, { home: tempDir("oq-e2e-graph-home-") });
      if (!opened.ok) throw new Error(opened.reason);
      const cold = await buildGraph({ repoRoot: dir, store: opened.store, budgetMs: 120_000, maxFiles: 100_000 });
      const warm = await buildGraph({ repoRoot: dir, store: opened.store, budgetMs: 120_000, maxFiles: 100_000 });
      expect(cold.status.status).toBe("ok");
      expect(warm.status.parses).toBe(0);
      const lines = [
        `${repo.name} ${repo.sha}: ${cold.status.filesParsed} files, cold ${cold.status.durationMs} ms, warm ${warm.status.durationMs} ms`,
      ];
      let truthTotal = 0;
      let truthFound = 0;
      let graphTotal = 0;
      let graphTrue = 0;
      for (const t of repo.targets) {
        const grep = grepSites(dir, t.grep);
        const truth = [...t.calls, ...(t.gaps ?? [])];
        for (const site of [...truth, ...(t.dispatch ?? [])]) expect(grep, `${site} is not a grep hit for ${t.grep.join(", ")}`).toContain(site);
        const id = (cold.defsByFile.get(t.file) ?? []).find((n) => n.id.includes(`#${t.symbol}@`))?.id;
        expect(id, `${t.symbol} in ${t.file}`).toBeDefined();
        const found = new Set(
          (cold.in.get(id as string) ?? []).filter((e) => e.kind === "calls").flatMap((e) => e.sites.map((s) => `${s.file}:${s.line}`)),
        );
        const missed = t.calls.filter((s) => !found.has(s));
        expect(missed, `${t.symbol}: bindable callers the graph missed`).toEqual([]);
        const inTruth = [...found].filter((s) => truth.includes(s)).length;
        truthTotal += truth.length;
        truthFound += truth.filter((s) => found.has(s)).length;
        graphTotal += found.size;
        graphTrue += inTruth;
        lines.push(`  ${t.symbol}: ${found.size} found, ${t.calls.length} bindable, ${(t.gaps ?? []).length} by design out of reach, ${found.size - inTruth} false`);
        if (t.dispatch) {
          // The implementations and overrides of the target, through every
          // level (`overrides` edges are references, not calls).
          const impls = new Set<string>();
          const queue = [id as string];
          while (queue.length > 0) {
            for (const e of cold.refsIn.get(queue.pop() as string) ?? []) {
              if (e.kind === "overrides" && !impls.has(e.from)) {
                impls.add(e.from);
                queue.push(e.from);
              }
            }
          }
          const dispatched = new Set(
            [...impls].flatMap((i) => (cold.in.get(i) ?? []).filter((e) => e.kind === "dispatches_to").flatMap((e) => e.sites.map((s) => `${s.file}:${s.line}`))),
          );
          const missedDispatch = t.dispatch.filter((s) => !dispatched.has(s));
          expect(missedDispatch, `${t.symbol}: calls that do not dispatch to its ${impls.size} implementations`).toEqual([]);
          const dispatchTrue = [...dispatched].filter((s) => t.dispatch?.includes(s)).length;
          truthTotal += t.dispatch.length;
          truthFound += dispatchTrue;
          graphTotal += dispatched.size;
          graphTrue += dispatchTrue;
          lines.push(`  ${t.symbol} dispatch: ${dispatched.size} found to ${impls.size} implementations, ${t.dispatch.length} expected, ${dispatched.size - dispatchTrue} false`);
        }
      }
      const precision = graphTotal === 0 ? 1 : graphTrue / graphTotal;
      lines.push(`  recall ${(truthFound / truthTotal).toFixed(3)} (${truthFound}/${truthTotal}), precision ${precision.toFixed(3)} (${graphTrue}/${graphTotal})`);
      process.stderr.write(`${lines.join("\n")}\n`);
      expect(precision).toBeGreaterThanOrEqual(0.9);
    }, 600_000);
  }
});

// A cross-file change: `price` changes, `checkout` in another file calls it.
function plantedRepo(files: Record<string, string>, change: Record<string, string>): string {
  const dir = tempDir("oq-graph-planted-");
  const write = (set: Record<string, string>) => {
    for (const [path, content] of Object.entries(set)) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
  };
  write(files);
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "Base");
  write(change);
  return dir;
}

describe("blast radius in the brief", () => {
  const cases = [
    {
      lang: "TypeScript",
      files: {
        "src/price.ts": "export function price(cents: number): number {\n  return cents / 100;\n}\n",
        "src/cart.ts": 'import { price } from "./price.js";\n\nexport function checkout(items: number[]): number {\n  return items.map((c) => price(c)).reduce((a, b) => a + b, 0);\n}\n',
      },
      change: { "src/price.ts": "export function price(cents: number): string {\n  return (cents / 100).toFixed(2);\n}\n" },
      site: "src/cart.ts:4 in `checkout` calls `price` (1 hop, certain)",
    },
    {
      lang: "Python",
      files: {
        "shop/__init__.py": "",
        "shop/price.py": "def price(cents):\n    return cents / 100\n",
        "shop/cart.py": "from shop.price import price\n\n\ndef checkout(items):\n    return sum(price(c) for c in items)\n",
      },
      change: { "shop/price.py": 'def price(cents):\n    return f"{cents / 100:.2f}"\n' },
      site: "shop/cart.py:5 in `checkout` calls `price` (1 hop, certain)",
    },
  ];
  for (const c of cases) {
    it(`names the caller's call line for a ${c.lang} change in another file`, () => {
      const dir = plantedRepo(c.files, c.change);
      const r = run(`graph-brief-${c.lang}`, dir, ["review", "--agent", "--only", "gitleaks", "--no-install", "--offline"]);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("## What this change reaches");
      expect(r.stdout).toContain(`- ${c.site}`);
      const off = run(`graph-brief-off-${c.lang}`, dir, ["review", "--agent", "--only", "gitleaks", "--no-install", "--offline", "--no-graph"]);
      expect(off.status, off.stderr).toBe(0);
      expect(off.stdout).toContain("The code graph is off: --no-graph was given.");
    });
  }
});

describe("the saved report of a Java change", () => {
  // An interface, two implementations and a service that calls through a
  // field typed by the interface. The change edits one implementation.
  const files = {
    "src/main/java/shop/Repo.java": "package shop;\n\npublic interface Repo {\n  String find(String id);\n}\n",
    "src/main/java/shop/SqlRepo.java":
      'package shop;\n\npublic class SqlRepo implements Repo {\n  public static String normalize(String id) {\n    return id.trim();\n  }\n\n  public String find(String id) {\n    return "sql:" + id;\n  }\n}\n',
    "src/main/java/shop/MemRepo.java": 'package shop;\n\npublic class MemRepo implements Repo {\n  public String find(String id) {\n    return "mem:" + id;\n  }\n}\n',
    "src/main/java/shop/Service.java":
      "package shop;\n\npublic class Service {\n  private final Repo repo;\n\n  public Service(Repo repo) {\n    this.repo = repo;\n  }\n\n  public String lookup(String id) {\n    String key = SqlRepo.normalize(id);\n    return repo.find(key);\n  }\n}\n",
  };
  const change = {
    "src/main/java/shop/SqlRepo.java":
      'package shop;\n\npublic class SqlRepo implements Repo {\n  public static String normalize(String id) {\n    return id.trim().toLowerCase();\n  }\n\n  public String find(String id) {\n    return "sql:" + id.toLowerCase();\n  }\n}\n',
  };

  it("names the certain caller and the possible caller through the interface, with their lines", () => {
    const dir = plantedRepo(files, change);
    const r = run("graph-java-report", dir, ["review", "--agent", "--only", "gitleaks", "--no-install", "--offline"]);
    expect(r.status, r.stderr).toBe(0);
    const saved = reportDir(dir);
    const impact = readJson<ImpactSummary>(join(saved, "impact.json"));
    expect(impact.status).toBe("ok");
    const sites = (paths: ImpactSummary["callers"]) =>
      paths.flatMap((p) => p.edges.flatMap((e) => e.sites.map((s) => `${e.kind} ${e.from.split("#")[1]?.split("@")[0]} -> ${e.to.split("#")[1]?.split("@")[0]} ${s.file}:${s.line} ${s.tier}`)));
    expect(sites(impact.callers)).toContain("calls Service.lookup -> SqlRepo.normalize src/main/java/shop/Service.java:11 certain");
    expect(sites(impact.possible ?? [])).toContain("dispatches_to Service.lookup -> SqlRepo.find src/main/java/shop/Service.java:12 possible");
    // MemRepo did not change, so its dispatch is not part of this change's reach.
    expect(sites([...impact.callers, ...(impact.possible ?? [])]).filter((l) => l.includes("MemRepo"))).toEqual([]);
    const brief = readFileSync(join(saved, "brief.md"), "utf8");
    expect(brief).toContain("- src/main/java/shop/Service.java:11 in `lookup` calls `normalize` (1 hop, certain)");
    expect(brief).toContain("- src/main/java/shop/Service.java:12 in `lookup` may call `SqlRepo.find` (1 hop, possible");
  });
});
