// The Rails plugin on a small real application and on hostile input.
import { afterAll, describe, expect, it } from "vitest";
import { buildGraph, frameworkLayer, openStore } from "../src/index.js";
import type { Graph, Registration } from "../src/index.js";
import { rails } from "../src/frameworks/rails/index.js";
import { expectLinear, growthTests, readerCpuMs, stageCpuMs } from "../src/test-timing.js";
import { commitAll, git, makeHome, makeRepo, symbol, writeFiles } from "./helpers.js";
import { removeTempDirs } from "../../../tests/temp-dirs.mjs";

// Every folder the shared helpers made for this file goes when it ends (tests/temp-guard.ts).
afterAll(removeTempDirs);

const MiB = 1024 * 1024;
const home = makeHome();

// A small blog: routes with resources, a nested resource, a namespace and
// root; two posts controllers (the public one and the admin one) and a
// comments controller; a model with an association and the migrations that
// name its table; views and a partial; a job and a mailer with its view;
// config keys set in two files and read in an action; a request spec and
// a model spec.
const POSTS = `class PostsController < ApplicationController
  before_action :set_post, only: %i[show edit update destroy]

  def index
    render partial: "summary"
  end

  def show
    @size = Rails.application.config.x.page_size
  end

  def new
  end

  def create
    PublishJob.perform_later(1)
    PostMailer.published(1).deliver_later
  end

  def edit
    render :form
  end

  def update
  end

  def destroy
  end

  private

  def set_post
    @post = Post.find(params[:id])
  end
end
`;
const ADMIN_POSTS = `module Admin
  class PostsController < ApplicationController
    def index
    end

    def destroy
    end
  end
end
`;
const POST_MODEL = `class Post < ApplicationRecord
  has_many :comments

  def excerpt
    "x"
  end
end
`;
const APP: Record<string, string> = {
  Gemfile: 'source "https://rubygems.org"\n\ngem "rails", "~> 7.1"\ngem "rspec-rails", group: :test\n',
  "config/application.rb": 'module Blog\n  class Application < Rails::Application\n    config.x.page_size = 20\n    config.x.api_token = "s3cr3t-value"\n  end\nend\n',
  "config/environments/production.rb": "Rails.application.configure do\n  config.x.page_size = 50\nend\n",
  "config/routes.rb": `Rails.application.routes.draw do
  root "posts#index"
  resources :posts do
    resources :comments, only: [:create]
  end
  namespace :admin do
    resources :posts, only: [:index, :destroy]
  end
end
`,
  "app/controllers/application_controller.rb": "class ApplicationController < ActionController::Base\nend\n",
  "app/controllers/posts_controller.rb": POSTS,
  "app/controllers/comments_controller.rb": "class CommentsController < ApplicationController\n  def create\n  end\nend\n",
  "app/controllers/admin/posts_controller.rb": ADMIN_POSTS,
  "app/models/application_record.rb": "class ApplicationRecord < ActiveRecord::Base\n  primary_abstract_class\nend\n",
  "app/models/post.rb": POST_MODEL,
  "app/models/comment.rb": "class Comment < ApplicationRecord\n  belongs_to :post\nend\n",
  "db/migrate/20240101000000_create_posts.rb": "class CreatePosts < ActiveRecord::Migration[7.1]\n  def change\n    create_table :posts do |t|\n      t.string :title\n    end\n  end\nend\n",
  "db/migrate/20240102000000_add_slug_to_posts.rb": "class AddSlugToPosts < ActiveRecord::Migration[7.1]\n  def change\n    add_column :posts, :slug, :string\n  end\nend\n",
  "db/migrate/20240103000000_create_comments.rb": "class CreateComments < ActiveRecord::Migration[7.1]\n  def change\n    create_table :comments do |t|\n      t.references :post\n    end\n  end\nend\n",
  "app/views/posts/index.html.erb": "<h1>Posts</h1>\n",
  "app/views/posts/_summary.html.erb": "<p>Summary</p>\n",
  "app/views/posts/show.html.erb": "<h1>Post</h1>\n",
  "app/views/posts/form.html.erb": "<form></form>\n",
  "app/views/admin/posts/index.html.erb": "<h1>Admin</h1>\n",
  "app/jobs/application_job.rb": "class ApplicationJob < ActiveJob::Base\nend\n",
  "app/jobs/publish_job.rb": "class PublishJob < ApplicationJob\n  def perform(id)\n    @id = id\n  end\nend\n",
  "app/mailers/application_mailer.rb": "class ApplicationMailer < ActionMailer::Base\nend\n",
  "app/mailers/post_mailer.rb": "class PostMailer < ApplicationMailer\n  def published(id)\n    mail(to: id)\n  end\nend\n",
  "app/views/post_mailer/published.html.erb": "<p>Published</p>\n",
  "spec/requests/posts_spec.rb": 'require "rails_helper"\n\nRSpec.describe "Posts", type: :request do\n  it "shows a post" do\n    get "/posts/1"\n  end\n\n  it "deletes a post as an admin" do\n    delete "/admin/posts/1"\n  end\nend\n',
  "spec/models/post_spec.rb": 'require "rails_helper"\n\nRSpec.describe Post do\n  it "has an excerpt" do\n    Post.new.excerpt\n  end\nend\n',
};

const SHOW = "app/controllers/posts_controller.rb";

async function storeOf(root: string) {
  const opened = await openStore(root, { home });
  if (!opened.ok) throw new Error(opened.reason);
  return opened.store;
}

async function built(files: Record<string, string> = APP): Promise<Graph> {
  const root = makeRepo(files);
  commitAll(root);
  return buildGraph({ repoRoot: root, store: null });
}

const registrations = (g: Graph) => g.frameworks?.entities.filter((e): e is Registration => e.kind === "registration" && e.plugin === "rails") ?? [];
const registration = (g: Graph, methods: string, pattern: string) => registrations(g).find((r) => r.methods.join("|") === methods && r.pattern === pattern);

function layerOf(g: Graph) {
  const layer = frameworkLayer(g);
  if (!layer) throw new Error("no framework layer");
  return layer;
}

// The names an edge kind leads to from a symbol or file: an entity's name, else the symbol id without its position.
function targets(g: Graph, from: string, kind: string): string[] {
  const layer = layerOf(g);
  return layer
    .edgesFrom(from)
    .filter((e) => e.kind === kind)
    .map((e) => {
      const x = layer.entity(e.to);
      if (!x) return e.to.replace(/@.*/, "");
      return x.kind === "registration" ? `${x.methods.join("|")} ${x.pattern}` : x.name;
    })
    .sort();
}

describe("the Rails plugin on a small application", () => {
  it("keeps the known part of a route whose prefix is computed for display, and never matches it as a pattern", async () => {
    const g = await built({
      ...APP,
      "config/routes.rb": 'Rails.application.routes.draw do\n  scope ENV["PREFIX"] do\n    get "/posts", to: "posts#index"\n    resources :comments, only: :create\n  end\nend\n',
    });
    const shown = registrations(g).map((r) => [r.methods.join("|"), r.pattern, r.partial ?? null]);
    expect(shown).toEqual([
      ["GET", null, "/{computed}/posts"],
      ["POST", null, "/{computed}/comments"],
    ]);
    expect(registrations(g)[0]?.handler.status).toBe("bound");
  });

  it("finds the routes of unchanged files once rails is added to the Gemfile, from cached facts, never from a stale build", async () => {
    const root = makeRepo({ ...APP, Gemfile: 'source "https://rubygems.org"\n\ngem "sinatra"\n' });
    commitAll(root);
    const store = await storeOf(root);
    const before = await buildGraph({ repoRoot: root, store });
    expect(before.frameworks?.apps.filter((a) => a.plugin === "rails")).toEqual([]);
    expect(registrations(before)).toEqual([]);
    writeFiles(root, { Gemfile: APP.Gemfile as string });
    git(root, "add", "-A");
    const after = await buildGraph({ repoRoot: root, store });
    // Every Ruby file's facts come from the cache: nothing was parsed again.
    expect(after.status.parses).toBe(0);
    expect(after.frameworks?.apps.filter((a) => a.plugin === "rails").length).toBe(1);
    expect(registration(after, "GET", "/posts/:id")?.handler.status).toBe("bound");
  });

  it("keeps the framework data in a retained index equal to the fresh build, and never reuses it once a view it names is added", async () => {
    const root = makeRepo(APP);
    commitAll(root);
    const store = await storeOf(root);
    const fresh = await buildGraph({ repoRoot: root, store, mode: "retained" });
    const loaded = await buildGraph({ repoRoot: root, store, mode: "retained" });
    expect(loaded.status.parses).toBe(0);
    expect(loaded.status.generation).toBe(fresh.status.generation);
    expect(JSON.stringify(loaded.frameworks)).toBe(JSON.stringify(fresh.frameworks));
    expect(targets(loaded, symbol(loaded, SHOW, "new", "PostsController"), "renders")).toEqual([]);
    // A view is not a source file: only the plugin's inputs name it.
    writeFiles(root, { "app/views/posts/new.html.erb": "<h1>New</h1>\n" });
    git(root, "add", "-A");
    const next = await buildGraph({ repoRoot: root, store, mode: "retained" });
    expect(next.frameworks?.fingerprint).not.toBe(fresh.frameworks?.fingerprint);
    expect(targets(next, symbol(next, SHOW, "new", "PostsController"), "renders")).toEqual(["app/views/posts/new.html.erb"]);
  });
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

describe("the Rails plugin on hostile input", () => {
  // Resources that multiply past the registration cap, route blocks nested
  // past the depth cap, patterns with many slots, optional groups and globs,
  // and test requests built to make a pattern matcher backtrack: a routes
  // file and a spec file just under 1 MiB each. At `q` = 1/4 the same at a
  // quarter of the size, which the timing checks compare it with.
  const deep = `resources :n do ${"resources :m do ".repeat(10)}${"end ".repeat(10)}end`;
  const hostile = (q: number) => {
    const routes = fill(
      "Rails.application.routes.draw do\n",
      (i) =>
        i % 4 === 0
          ? `  resources :r${i}\n`
          : i % 4 === 1
            ? `  get "/a${"/:p".repeat(40)}/x${i}", to: "x#y"\n`
            : i % 4 === 2
              ? `  get "/a${"(/:o)".repeat(6)}/*g/*h/x${i}", to: "x#y"\n`
              : `  ${deep}\n`,
      "end\n",
      (MiB - 1024) * q,
    );
    const spec = fill(
      'RSpec.describe "Hostile", type: :request do\n  it "requests" do\n',
      (i) => (i % 2 === 0 ? `    get "/${"a/".repeat(254)}!"\n` : `    get "/a/${"(".repeat(100)}${"a".repeat(300)}"\n    get r${i}_path\n`),
      "  end\nend\n",
      (MiB - 1024) * q,
    );
    const files: Record<string, string> = {
      Gemfile: 'source "https://rubygems.org"\n\ngem "rails"\ngem "rspec-rails"\n',
      "config/routes.rb": routes,
      "app/controllers/x_controller.rb": "class XController < ActionController::Base\n  def y\n  end\nend\n",
      "spec/requests/hostile_spec.rb": spec,
    };
    return { routes, spec, files };
  };
  const { routes, spec, files } = hostile(1);
  const quarter = hostile(1 / 4);
  const build = (root: string) => () => buildGraph({ repoRoot: root, store: null, maxFileBytes: 2 * MiB, budgetMs: 120_000 });
  const committed = (of: Record<string, string>) => {
    const root = makeRepo(of);
    commitAll(root);
    return root;
  };

  growthTests("in time that grows with it", () => {
    it("reads the facts of a 1 MiB hostile routes file and spec file in time that grows with each", async () => {
      const read = (root: Parameters<typeof rails.facts>[0]) => rails.facts(root, "ruby");
      expectLinear("the Rails fact reader on routes files of 256 KiB and of 1 MiB", await readerCpuMs("ruby", [quarter.routes], read), await readerCpuMs("ruby", [routes], read));
      expectLinear("the Rails fact reader on spec files of 256 KiB and of 1 MiB", await readerCpuMs("ruby", [quarter.spec], read), await readerCpuMs("ruby", [spec], read));
    }, 120_000);

    it("resolves hostile resources, deep nesting, slot-heavy patterns and backtracking requests in time that grows with them", async () => {
      expectLinear("the frameworks stage on the hostile Rails input", await stageCpuMs(build(committed(quarter.files)), "frameworks"), await stageCpuMs(build(committed(files)), "frameworks"));
    }, 120_000);
  });

  it("resolves hostile resources, deep nesting, slot-heavy patterns and backtracking requests, with every cap named as a gap", async () => {
    const graph = await build(committed(files))();
    const data = graph.frameworks;
    expect(data?.plugins.find((p) => p.id === "rails")?.status).toBe("ok");
    const capped = data?.unknowns.filter((u) => u.plugin === "rails" && (u.cause === "fan-out-capped" || u.cause === "budget")) ?? [];
    expect(capped.length).toBeGreaterThan(0);
    expect(registrations(graph).length).toBeLessThanOrEqual(10_000);
  }, 120_000);
});
