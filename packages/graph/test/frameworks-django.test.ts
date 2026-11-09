// The Django plugin on a small real application and on hostile input.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getChange } from "@openqodex/core";
import { afterAll, describe, expect, it } from "vitest";
import { PACKET_DIR, writePacket } from "../src/review/packet.js";
import { buildGraph, detectImpact, frameworkLayer, openStore, renderImpactBlock } from "../src/index.js";
import type { Graph, Registration } from "../src/index.js";
import { django } from "../src/frameworks/django/index.js";
import { expectLinear, growthTests, readerCpuMs, stageCpuMs } from "../src/test-timing.js";
import { commitAll, git, makeHome, makeRepo, symbol, writeFiles } from "./helpers.js";
import { removeTempDirs } from "../../../tests/temp-dirs.mjs";

// Every folder the shared helpers made for this file goes when it ends (tests/temp-guard.ts).
afterAll(removeTempDirs);

const MiB = 1024 * 1024;
const home = makeHome();

// A small blog: a project urls module including the app's, function and
// class views, templates, models with a relation and two migrations, a
// management command, a signal receiver, a template tag, a settings key
// read in code, and tests that call, request and name routes.
const APP: Record<string, string> = {
  "requirements.txt": "Django==5.0\n",
  "manage.py": 'import os\n\nif __name__ == "__main__":\n    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "mysite.settings")\n',
  "mysite/__init__.py": "",
  "mysite/settings.py": 'INSTALLED_APPS = ["blog"]\nROOT_URLCONF = "mysite.urls"\nPAGE_SIZE = 20\n',
  "mysite/urls.py": 'from django.urls import include, path\n\nurlpatterns = [\n    path("blog/", include("blog.urls")),\n]\n',
  "blog/__init__.py": "",
  "blog/urls.py": 'from django.urls import path\n\nfrom blog import views\n\napp_name = "blog"\nurlpatterns = [\n    path("", views.PostList.as_view(), name="list"),\n    path("<int:pk>/", views.detail, name="detail"),\n]\n',
  "blog/views.py":
    'from django.conf import settings\nfrom django.shortcuts import get_object_or_404, render\nfrom django.views.generic import ListView\n\nfrom blog.models import Post\n\n\ndef load(pk):\n    return get_object_or_404(Post, pk=pk)\n\n\ndef detail(request, pk):\n    post = load(pk)\n    return render(request, "blog/detail.html", {"post": post, "size": settings.PAGE_SIZE})\n\n\nclass PostList(ListView):\n    template_name = "blog/list.html"\n\n    def get(self, request):\n        return None\n\n\ndef about(request):\n    return render(request, "blog/about.html")\n',
  "blog/models.py": 'from django.db import models\n\n\nclass Author(models.Model):\n    name = models.CharField(max_length=80)\n\n\nclass Post(models.Model):\n    title = models.CharField(max_length=200)\n    author = models.ForeignKey(Author, on_delete=models.CASCADE)\n',
  "blog/migrations/__init__.py": "",
  "blog/migrations/0001_initial.py": 'from django.db import migrations, models\n\n\nclass Migration(migrations.Migration):\n    dependencies = []\n    operations = [\n        migrations.CreateModel(name="Author", fields=[]),\n        migrations.CreateModel(name="Post", fields=[]),\n    ]\n',
  "blog/migrations/0002_post_title.py": 'from django.db import migrations, models\n\n\nclass Migration(migrations.Migration):\n    dependencies = [("blog", "0001_initial")]\n    operations = [\n        migrations.AddField(model_name="post", name="title", field=models.CharField(max_length=200)),\n    ]\n',
  "blog/management/__init__.py": "",
  "blog/management/commands/__init__.py": "",
  "blog/management/commands/reindex.py": 'from django.core.management.base import BaseCommand\n\nfrom blog.views import load\n\n\nclass Command(BaseCommand):\n    def handle(self, *args, **options):\n        load(1)\n',
  "blog/signals.py": 'from django.db.models.signals import post_save\nfrom django.dispatch import receiver\n\nfrom blog.models import Post\n\n\n@receiver(post_save, sender=Post)\ndef on_post_saved(sender, instance, **kwargs):\n    return None\n',
  "blog/templatetags/__init__.py": "",
  "blog/templatetags/blog_tags.py": 'from django import template\n\nregister = template.Library()\n\n\n@register.inclusion_tag("blog/card.html")\ndef card(post):\n    return {"post": post}\n',
  "blog/templates/blog/detail.html": "<h1>{{ post.title }}</h1>\n",
  "blog/templates/blog/list.html": "<ul></ul>\n",
  "blog/templates/blog/card.html": "<div></div>\n",
  "blog/tests.py": 'from django.test import TestCase\nfrom django.urls import reverse\n\nfrom blog.views import load\n\n\nclass DetailTests(TestCase):\n    def test_request(self):\n        self.client.get("/blog/7/")\n\n    def test_named(self):\n        self.client.get(reverse("blog:list"))\n\n    def test_load(self):\n        load(7)\n',
};

async function storeOf(root: string) {
  const opened = await openStore(root, { home });
  if (!opened.ok) throw new Error(opened.reason);
  return opened.store;
}

const registrationAt = (g: Graph, site: string): Registration | undefined => g.frameworks?.entities.find((e): e is Registration => e.kind === "registration" && `${e.site.file}:${e.site.line}` === site);

describe("the Django plugin on a small application", () => {
  it("writes every route and test link past the brief's cut into the packet, and the brief names the file that holds them", async () => {
    const many = Array.from({ length: 15 }, (_, i) => `    path("r${i}/", views.detail, name="r${i}"),\n`).join("");
    const files = { ...APP, "blog/urls.py": `from django.urls import path\n\nfrom blog import views\n\napp_name = "blog"\nurlpatterns = [\n${many}]\n` };
    const root = makeRepo(files);
    commitAll(root);
    writeFiles(root, { "blog/views.py": (APP["blog/views.py"] as string).replace("return get_object_or_404(Post, pk=pk)", "return get_object_or_404(Post, pk=str(pk))") });
    const change = await getChange({ repoRoot: root, scope: { uncommitted: true }, exclude: [] });
    const g = await buildGraph({ repoRoot: root, store: null, files: change.changedPaths, base: { sha: change.baseSha, files: change.files } });
    const impact = detectImpact(g, change);
    const packet = await writePacket({ root, repoRoot: root, graph: g, impact, baseSha: change.baseSha, secrets: [] });
    impact.packet = packet.dir;
    expect(packet.files).toContain("frameworks.json");
    const held = JSON.parse(readFileSync(join(root, PACKET_DIR, "frameworks.json"), "utf8")) as { routes: { pattern: string | null }[]; tests: unknown[] };
    expect(held.routes.map((r) => r.pattern).sort()).toEqual(Array.from({ length: 15 }, (_, i) => `blog/r${i}/`).sort());
    const brief = renderImpactBlock(impact);
    expect(brief).toContain(`| and 3 more, every one in \`${PACKET_DIR}/frameworks.json\` |`);
  }, 60_000);

  it("finds the routes of unchanged files once Django is added to the manifest, from cached facts, never from a stale build", async () => {
    const root = makeRepo({ ...APP, "requirements.txt": "requests==2.32\n" });
    commitAll(root);
    const store = await storeOf(root);
    const before = await buildGraph({ repoRoot: root, store });
    expect(before.frameworks?.apps).toEqual([]);
    expect(before.frameworks?.entities.filter((e) => e.kind === "registration")).toEqual([]);
    writeFiles(root, { "requirements.txt": "requests==2.32\nDjango==5.0\n" });
    git(root, "add", "-A");
    const after = await buildGraph({ repoRoot: root, store });
    // Every Python file's facts come from the cache: nothing was parsed again.
    expect(after.status.parses).toBe(0);
    expect(after.frameworks?.apps.length).toBe(1);
    expect(registrationAt(after, "blog/urls.py:8")?.handler.status).toBe("bound");
  }, 60_000);

  it("keeps the framework data in a retained index equal to the fresh build, and never reuses it once a template it names is added", async () => {
    const root = makeRepo(APP);
    commitAll(root);
    const store = await storeOf(root);
    const fresh = await buildGraph({ repoRoot: root, store, mode: "retained" });
    const loaded = await buildGraph({ repoRoot: root, store, mode: "retained" });
    expect(loaded.status.parses).toBe(0);
    expect(loaded.status.generation).toBe(fresh.status.generation);
    expect(JSON.stringify(loaded.frameworks)).toBe(JSON.stringify(fresh.frameworks));
    const about = (g: Graph) => {
      const layer = frameworkLayer(g);
      const edge = layer?.edgesFrom(symbol(g, "blog/views.py", "about")).find((e) => e.kind === "renders");
      const t = edge ? layer?.entity(edge.to) : null;
      return t && t.kind !== "registration" ? t.file : "no edge";
    };
    expect(about(loaded)).toBeNull();
    // A template is not a source file: only the plugins' inputs name it.
    writeFiles(root, { "blog/templates/blog/about.html": "about\n" });
    git(root, "add", "-A");
    const next = await buildGraph({ repoRoot: root, store, mode: "retained" });
    expect(next.frameworks?.fingerprint).not.toBe(fresh.frameworks?.fingerprint);
    expect(about(next)).toBe("blog/templates/blog/about.html");
  }, 60_000);
});

// Repeats `unit` until the text is just under `bytes`.
function fill(head: string, unit: (i: number) => string, tail: string, bytes: number): string {
  const parts = [head];
  let size = Buffer.byteLength(head) + Buffer.byteLength(tail);
  for (let i = 0; ; i++) {
    const u = unit(i);
    const n = Buffer.byteLength(u);
    if (size + n >= bytes) break;
    parts.push(u);
    size += n;
  }
  parts.push(tail);
  return parts.join("");
}

describe("the Django plugin on hostile input", () => {
  // Backtracking patterns, long routes, includes that multiply, and test
  // requests built to make a regex engine backtrack: a urls module and a
  // test module just under 1 MiB each. At `q` = 1/4 the same at a quarter of
  // each size and count, which the timing checks compare it with.
  const hostile = (q: number) => {
    const urls = fill(
      "from django.urls import include, path, re_path\n\nfrom mysite import views\n\nurlpatterns = [\n",
      (i) => (i % 3 === 0 ? `    re_path(r"^(a+)+$", views.v, name="n${i}"),\n` : i % 3 === 1 ? `    path("${"<path:p>".repeat(8)}x${i}/", views.v),\n` : `    path("m${i}/", include("mysite.more")),\n`),
      "]\n",
      (MiB - 1024) * q,
    );
    const more = `from django.urls import include, path\n\nfrom mysite import views\n\nurlpatterns = [\n${Array.from({ length: 400 * q }, (_, i) => `    path("k${i}/", include("mysite.leaf")),\n`).join("")}]\n`;
    const leaf = `from django.urls import path\n\nfrom mysite import views\n\nurlpatterns = [\n${Array.from({ length: 400 * q }, (_, i) => `    path("l${i}/<int:x>/", views.v),\n`).join("")}]\n`;
    const tests = fill(
      "from django.test import TestCase\n\n\nclass T(TestCase):\n    def test_x(self):\n",
      () => `        self.client.get("/${"a".repeat(400)}!")\n`,
      "",
      (MiB - 1024) * q,
    );
    const files: Record<string, string> = {
      "requirements.txt": "Django==5.0\n",
      "mysite/__init__.py": "",
      "mysite/settings.py": 'INSTALLED_APPS = []\nROOT_URLCONF = "mysite.urls"\n',
      "mysite/urls.py": urls,
      "mysite/more.py": more,
      "mysite/leaf.py": leaf,
      "mysite/views.py": "def v(request, **kw):\n    return None\n",
      "mysite/tests.py": tests,
    };
    return { urls, tests, files };
  };
  const { urls, tests, files } = hostile(1);
  const quarter = hostile(1 / 4);
  const build = (root: string) => () => buildGraph({ repoRoot: root, store: null, maxFileBytes: 2 * MiB, budgetMs: 120_000 });
  const committed = (of: Record<string, string>) => {
    const root = makeRepo(of);
    commitAll(root);
    return root;
  };
  // At `q` = 1/4 a quarter of each count, for the timing check.
  const shop = (q: number) => {
    const models = `from django.db import models\n\n${Array.from({ length: 25_000 * q }, (_, i) => `class C${i}: pass\n`).join("")}\nclass MoneyField(models.DecimalField): pass\n\n\nclass Price(models.Model):\n${Array.from({ length: 1_900 * q }, (_, i) => `    p${i} = MoneyField()\n`).join("")}`;
    const related = `from django.db import models\n\n\nclass Link(models.Model):\n${Array.from({ length: 1_900 * q }, (_, i) => `    l${i} = models.ForeignKey("Missing${i}", on_delete=models.CASCADE)\n`).join("")}`;
    const files: Record<string, string> = { "requirements.txt": "Django==5.0\n", "mysite/__init__.py": "", "mysite/settings.py": 'INSTALLED_APPS = []\nROOT_URLCONF = "mysite.urls"\n', "mysite/urls.py": "urlpatterns = []\n", "shop/models.py": models };
    for (let i = 0; i < 8; i++) files[`links${i}/models.py`] = related;
    for (let i = 0; i < 4_000 * q; i++) files[`shop/templates/t${i}.html`] = "";
    return committed(files);
  };
  // At `q` = 1/4 a quarter of each count and of the depth, for the timing check.
  const project = (q: number) => {
    const models = `from django.db import models\n\n\nclass First(models.Model):\n    f = models.IntegerField()\n${Array.from({ length: 25_000 * q }, (_, i) => `class M${i}(models.Model): pass\n`).join("")}`;
    const deep = `from django.conf import settings\n\n\ndef f():\n    return ${"(".repeat(200 * q)}settings.KEY${")".repeat(200 * q)}\n`;
    const reads = `from django.conf import settings\n\n\ndef g():\n${Array.from({ length: 5_000 * q }, (_, i) => `    x${i} = settings.KEY_${i % 50}\n`).join("")}`;
    return committed({ "requirements.txt": "Django==5.0\n", "mysite/__init__.py": "", "mysite/settings.py": 'INSTALLED_APPS = []\nROOT_URLCONF = "mysite.urls"\nKEY = 1\n', "mysite/urls.py": "urlpatterns = []\n", "mysite/models.py": models, "mysite/deep.py": deep, "mysite/reads.py": reads });
  };

  growthTests("in time that grows with it", () => {
    it("reads the facts of a 1 MiB hostile urls module and test module in time that grows with each", async () => {
      const read = (root: Parameters<typeof django.facts>[0]) => django.facts(root, "python");
      expectLinear("the Django fact reader on urls modules of 256 KiB and of 1 MiB", await readerCpuMs("python", [quarter.urls], read), await readerCpuMs("python", [urls], read));
      expectLinear("the Django fact reader on test modules of 256 KiB and of 1 MiB", await readerCpuMs("python", [quarter.tests], read), await readerCpuMs("python", [tests], read));
    }, 120_000);

    it("resolves hostile routes, multiplying includes and backtracking requests, under one work budget, in time that grows with them", async () => {
      expectLinear("the frameworks stage on the hostile Django input", await stageCpuMs(build(committed(quarter.files)), "frameworks"), await stageCpuMs(build(committed(files)), "frameworks"));
    }, 120_000);

    it("resolves fields built by a field class among 25,000 classes, and string relations to absent models among 4,000 paths, in time that grows with them", async () => {
      expectLinear("the frameworks stage on a quarter of the classes, fields and paths and on all of them", await stageCpuMs(build(shop(1 / 4)), "frameworks"), await stageCpuMs(build(shop(1)), "frameworks"));
    }, 120_000);

    it("resolves a models module of 25,000 classes and one field, and settings reads nested deep, in time that grows with them", async () => {
      expectLinear("the frameworks stage on 6,250 and on 25,000 models", await stageCpuMs(build(project(1 / 4)), "frameworks"), await stageCpuMs(build(project(1)), "frameworks"));
    }, 120_000);
  });

  it("resolves hostile routes, multiplying includes and backtracking requests, with every cap named as a gap", async () => {
    const graph = await build(committed(files))();
    const data = graph.frameworks;
    expect(data?.plugins.find((p) => p.id === "django")?.status).toBe("ok");
    // The includes multiply past the cap: the cap stops the walk and says so.
    const capped = data?.unknowns.filter((u) => u.plugin === "django" && (u.cause === "fan-out-capped" || u.cause === "budget")) ?? [];
    expect(capped.length).toBeGreaterThan(0);
    const registrations = data?.entities.filter((e) => e.kind === "registration").length ?? 0;
    expect(registrations).toBeLessThanOrEqual(10_000);
  }, 120_000);

  // A 600-route table under twenty prefixes: 12,000 registrations, past the
  // 10,000 one application keeps.
  const capped = {
    "requirements.txt": "Django==5.0\n",
    "mysite/__init__.py": "",
    "mysite/settings.py": 'INSTALLED_APPS = []\nROOT_URLCONF = "mysite.urls"\n',
    "mysite/urls.py": `from django.urls import include, path\n\nurlpatterns = [\n${Array.from({ length: 20 }, (_, i) => `    path("p${i}/", include("mysite.table")),\n`).join("")}]\n`,
    "mysite/table.py": `from django.urls import path\n\nfrom mysite import views\n\nurlpatterns = [\n${Array.from({ length: 600 }, (_, i) => `    path("r${i}/", views.page),\n`).join("")}]\n`,
    "mysite/views.py": "def page(request):\n    return None\n",
  };

  it("says when an application's routes pass the registration cap, so the routes it leaves out are a gap, never silent", async () => {
    const root = makeRepo(capped);
    commitAll(root);
    const graph = await buildGraph({ repoRoot: root, store: null });
    const data = graph.frameworks;
    expect(data?.entities.filter((e) => e.kind === "registration").length).toBe(10_000);
    const gap = data?.unknowns.find((u) => u.plugin === "django" && u.cause === "fan-out-capped" && "app" in u.scope);
    expect(gap?.note).toContain("10000");
  }, 120_000);

  it("carries an application's gaps into the brief and the packet for a change in that application", async () => {
    const root = makeRepo(capped);
    commitAll(root);
    writeFiles(root, { "mysite/views.py": "def page(request):\n    return 1\n" });
    const change = await getChange({ repoRoot: root, scope: { uncommitted: true }, exclude: [] });
    const g = await buildGraph({ repoRoot: root, store: null, files: change.changedPaths, base: { sha: change.baseSha, files: change.files } });
    const impact = detectImpact(g, change);
    expect(impact.frameworks?.unknown.some((u) => u.cause === "fan-out-capped")).toBe(true);
    const packet = await writePacket({ root, repoRoot: root, graph: g, impact, baseSha: change.baseSha, secrets: [] });
    const held = JSON.parse(readFileSync(join(root, PACKET_DIR, "frameworks.json"), "utf8")) as { unknowns: { cause: string }[] };
    expect(held.unknowns.some((u) => u.cause === "fan-out-capped")).toBe(true);
    impact.packet = packet.dir;
    expect(renderImpactBlock(impact)).toMatch(/What the framework plugins could not see[\s\S]*fan-out-capped/);
  }, 120_000);

  it("writes every route a change declares into the packet when no handler changes, past the summary's forty", async () => {
    const root = makeRepo({ ...capped, "mysite/urls.py": 'from django.urls import path\n\nfrom mysite import views\n\nurlpatterns = []\n' });
    commitAll(root);
    writeFiles(root, { "mysite/urls.py": `from django.urls import path\n\nfrom mysite import views\n\nurlpatterns = [\n${Array.from({ length: 50 }, (_, i) => `    path("n${i}/", views.page),\n`).join("")}]\n` });
    const change = await getChange({ repoRoot: root, scope: { uncommitted: true }, exclude: [] });
    const g = await buildGraph({ repoRoot: root, store: null, files: change.changedPaths, base: { sha: change.baseSha, files: change.files } });
    const impact = detectImpact(g, change);
    expect(impact.touched).toEqual([]);
    expect(impact.frameworks?.routesTotal).toBe(50);
    await writePacket({ root, repoRoot: root, graph: g, impact, baseSha: change.baseSha, secrets: [] });
    const held = JSON.parse(readFileSync(join(root, PACKET_DIR, "frameworks.json"), "utf8")) as { routes: { pattern: string }[] };
    expect(held.routes.map((r) => r.pattern).sort()).toEqual(Array.from({ length: 50 }, (_, i) => `n${i}/`).sort());
  }, 120_000);

  it("resolves fields built by a field class among 25,000 classes, and string relations to absent models among 4,000 paths", async () => {
    const graph = await build(shop(1))();
    expect(graph.frameworks?.plugins.find((p) => p.id === "django")?.status).toBe("ok");
    expect(graph.frameworks?.edges.filter((e) => e.kind === "declares_field").length).toBe(17_100);
    expect(graph.frameworks?.unknowns.filter((u) => u.cause === "miss" && u.note.startsWith("no model named Missing")).length).toBe(15_200);
  }, 120_000);

  it("draws the whole resolve from one work budget and says once per project when it runs out", async () => {
    const graph = await build(committed(files))();
    const spent = graph.frameworks?.unknowns.filter((u) => u.plugin === "django" && u.cause === "budget" && u.site === null && "project" in u.scope) ?? [];
    expect(spent.length).toBe(1);
    expect(spent[0]?.note).toContain("work budget");
  }, 120_000);

  it("resolves a models module of 25,000 classes and one field, and settings reads nested deep", async () => {
    const graph = await build(project(1))();
    expect(graph.frameworks?.plugins.find((p) => p.id === "django")?.status).toBe("ok");
    expect(graph.frameworks?.roles.filter((r) => r.role === "model").length).toBe(25_001);
  }, 120_000);
});
