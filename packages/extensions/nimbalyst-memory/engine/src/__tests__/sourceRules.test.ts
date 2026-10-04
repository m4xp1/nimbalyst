// @vitest-environment node
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  normalizeSourceRules,
  readSourceRules,
  writeSourceRules,
  sourcesWithRules,
  previewSourceRules,
} from "../sourceRules.js";
import { MemoryEngine } from "../engine.js";
import { FakeEmbedder } from "./fakeEmbedder.js";
import { Indexer } from "../indexer/indexer.js";
import { SqliteStore } from "../store/sqliteStore.js";
const dirs: string[] = [];
const engines: MemoryEngine[] = [];
function root() {
  const r = mkdtempSync(path.join(tmpdir(), "memory-source-"));
  dirs.push(r);
  return r;
}
function file(r: string, p: string, text = "# Fixture\nquartzorchid") {
  const f = path.join(r, p);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, text);
}
function config(r: string) {
  return {
    root: r,
    dbPath: path.join(r, "index.db"),
    factsDir: "facts",
    sources: [{ sourceClass: "docs", include: ["docs/**/*.md"] }],
  };
}
afterEach(async () => {
  for (const e of engines.splice(0)) await e.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
describe("custom Markdown sources", () => {
  it("normalizes Windows relative folders and persists per-project rules", () => {
    const a = root(),
      b = root(),
      rules = normalizeSourceRules({
        include: ["research\\русский каталог", "MAP.md", "MAP.md"],
        exclude: ["research/drafts"],
      });
    expect(rules.include).toEqual([
      "research/русский каталог/**/*.md",
      "MAP.md",
    ]);
    writeSourceRules(a, rules);
    expect(readSourceRules(a)).toEqual(rules);
    expect(readSourceRules(b).include).toEqual([]);
    for (const unsafe of [
      "../outside.md",
      "C:\\outside.md",
      "/outside.md",
      "\\\\server\\file.md",
    ])
      expect(() => normalizeSourceRules({ include: [unsafe] })).toThrow();
  });
  it("previews exclusions and indexes overlaps once with built-in classification", async () => {
    const r = root();
    for (const p of [
      "docs/good.md",
      "MAP.md",
      "docs/SeCrEtS.MD",
      "docs/credentials.md",
      ".obsidian/private.md",
      "node_modules/lib.md",
      "docs/archive/old.md",
      "research/skip.md",
    ])
      file(r, p);
    const rules = normalizeSourceRules({
      include: ["**/*.md", "docs"],
      exclude: ["research/**"],
    });
    const cfg = {
      ...config(r),
      sources: sourcesWithRules(config(r).sources, rules),
      workspaceExclude: rules.exclude,
    };
    const preview = await previewSourceRules(cfg, rules);
    expect(preview.files).toEqual(["MAP.md", "docs/good.md"]);
    expect(preview.excluded.some((x) => x.path === "docs/credentials.md")).toBe(
      true
    );
    const store = new SqliteStore(cfg.dbPath),
      embedder = new FakeEmbedder(),
      idx = new Indexer(cfg, store, embedder);
    expect(await idx.enumerate()).toEqual(
      expect.arrayContaining([
        { sourcePath: "docs/good.md", sourceClass: "docs" },
        { sourcePath: "MAP.md", sourceClass: "custom" },
      ])
    );
    expect(await idx.enumerate()).toHaveLength(2);
    expect(idx.classify(path.join(r, "docs/SeCrEtS.MD"))).toBeNull();
    await idx.indexAll();
    expect(store.fileSourcePaths().sort()).toEqual(["MAP.md", "docs/good.md"]);
    store.close();
  });
  it("rejects junctions outside the workspace", async () => {
    const r = root(),
      outside = root();
    file(outside, "external.md");
    symlinkSync(outside, path.join(r, "escape"), "junction");
    const rules = normalizeSourceRules({ include: ["escape/**/*.md"] });
    const cfg = { ...config(r), sources: sourcesWithRules([], rules) };
    expect((await previewSourceRules(cfg, rules)).files).toEqual([]);
    const store = new SqliteStore(cfg.dbPath),
      idx = new Indexer(cfg, store, new FakeEmbedder());
    expect(await idx.enumerate()).toEqual([]);
    await idx.indexFile("escape/external.md", "custom");
    expect(store.count()).toBe(0);
    store.close();
  });
  it("applies rules without resetting records or re-embedding unchanged files", async () => {
    const r = root();
    file(r, "docs/good.md");
    file(r, "MAP.md");
    const cfg = config(r),
      embedder = new FakeEmbedder(),
      engine = MemoryEngine.create(cfg, embedder);
    engines.push(engine);
    await engine.indexAll();
    await engine.ingestRecords([
      {
        id: "tracker:1",
        sourceClass: "trackers",
        refType: "tracker",
        refId: "1",
        title: "Tracker",
        text: "virtual fixture",
      },
    ]);
    const spy = vi.spyOn(embedder, "embed");
    await engine.updateSources(
      sourcesWithRules(
        cfg.sources,
        normalizeSourceRules({ include: ["MAP.md"] })
      ),
      []
    );
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockClear();
    await engine.updateSources(cfg.sources, ["MAP.md"]);
    expect(spy).not.toHaveBeenCalled();
    expect(engine.status().bySourceClass.trackers).toBeGreaterThan(0);
    expect(engine.status().bySourceClass.custom ?? 0).toBe(0);
    expect(readSourceRules(r).include).toEqual([]);
  });
  it("discovers previously missing folders, changes and deletes without a restart", async () => {
    const r = root(),
      cfg = config(r);
    const engine = MemoryEngine.create(
      {
        ...cfg,
        sources: sourcesWithRules(
          cfg.sources,
          normalizeSourceRules({ include: ["future"] })
        ),
      },
      new FakeEmbedder()
    );
    engines.push(engine);
    await engine.indexAll();
    engine.startWatching();
    file(r, "future/русский.md", "# First\nquartzorchid");
    await vi.waitFor(
      () => expect(engine.status().bySourceClass.custom).toBeGreaterThan(0),
      { timeout: 9000, interval: 100 }
    );
    file(r, "future/русский.md", "# Second\nchangedmarigold");
    await vi.waitFor(
      () =>
        expect(engine.expand("future/русский.md", ["Second"])?.text).toContain(
          "changedmarigold"
        ),
      { timeout: 9000, interval: 100 }
    );
    rmSync(path.join(r, "future/русский.md"));
    await vi.waitFor(
      () => expect(engine.status().bySourceClass.custom ?? 0).toBe(0),
      { timeout: 9000, interval: 100 }
    );
  });
});
