/// <reference path="./picomatch.d.ts" />
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import picomatch from "picomatch";
import type { EngineConfig, SourceSet } from "./types.js";
export const SOURCE_SERVICE_EXCLUDES = [
  "**/.git/**",
  "**/.obsidian/**",
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.vite/**",
  "**/.cache/**",
];
export const SOURCE_SAFE_EXCLUDES = [
  ...SOURCE_SERVICE_EXCLUDES,
  "**/archive/**",
  "**/archives/**",
  "**/.env*",
  "**/secrets.md",
  "**/credentials*",
  "**/keys.md",
  "**/*.pem",
  "**/*.key",
];
export interface SourceRules {
  version: 1;
  include: string[];
  exclude: string[];
}
export interface SourcePreview {
  rules: SourceRules;
  files: string[];
  excluded: { path: string; reason: string }[];
}
export function normalizeSourceRules(value: unknown): SourceRules {
  const v = value as Partial<SourceRules> | null;
  function rules(input: unknown, includes: boolean): string[] {
    if (input === undefined) return [];
    if (!Array.isArray(input) || input.length > 200)
      throw new Error("Use at most 200 source rules.");
    return [
      ...new Set(
        input.map((raw) => {
          if (typeof raw !== "string")
            throw new Error("Source rules must be text.");
          let rule = raw
            .trim()
            .replace(/\\/g, "/")
            .replace(/^\.\//, "")
            .replace(/\/+$/, "");
          if (
            !rule ||
            rule.length > 500 ||
            rule.startsWith("/") ||
            /^[a-z]:/i.test(rule) ||
            rule.includes(":") ||
            rule.split("/").includes("..") ||
            rule.startsWith("!") ||
            rule.includes("\0")
          )
            throw new Error(
              "Use workspace-relative files, folders or globs; external paths are not allowed."
            );
          if (
            !/[*?{}[\]()]/.test(rule) &&
            (includes ? !/\.md$/i.test(rule) : !path.extname(rule))
          )
            rule += "/**/*" + (includes ? ".md" : "");
          return rule;
        })
      ),
    ];
  }
  return {
    version: 1,
    include: rules(v?.include, true),
    exclude: rules(v?.exclude, false),
  };
}
export function readSourceRules(dataDir: string): SourceRules {
  try {
    return normalizeSourceRules(
      JSON.parse(readFileSync(path.join(dataDir, "sources.json"), "utf8"))
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      return { version: 1, include: [], exclude: [] };
    throw new Error(
      "Saved source settings could not be read; correct them before applying changes."
    );
  }
}
export function writeSourceRules(dataDir: string, rules: SourceRules): void {
  mkdirSync(dataDir, { recursive: true });
  const target = path.join(dataDir, "sources.json");
  writeFileSync(target + ".tmp", JSON.stringify(rules, null, 2) + "\n", "utf8");
  renameSync(target + ".tmp", target);
}
export function sourcesWithRules(
  builtins: SourceSet[],
  rules: SourceRules
): SourceSet[] {
  return rules.include.length
    ? [...builtins, { sourceClass: "custom", include: rules.include }]
    : [...builtins];
}
/** Reject symlinks/junctions escaping the primary workspace before reading text. */
export async function isInsideRealRoot(
  root: string,
  abs: string
): Promise<boolean> {
  const [realRoot, realFile] = await Promise.all([
    realpath(root),
    realpath(abs),
  ]);
  const relative = path.relative(realRoot, realFile);
  return (
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
}
export async function previewSourceRules(
  config: EngineConfig,
  rules: SourceRules
): Promise<SourcePreview> {
  const files: string[] = [],
    excluded: { path: string; reason: string }[] = SOURCE_SERVICE_EXCLUDES.map(
      (p) => ({ path: p, reason: "Service/generated directory is not scanned" })
    );
  const candidates = rules.include.length
    ? await fg(rules.include, {
        cwd: config.root,
        dot: true,
        onlyFiles: true,
        followSymbolicLinks: false,
        suppressErrors: false,
        ignore: SOURCE_SERVICE_EXCLUDES,
      })
    : [];
  const reject = picomatch(
    [...SOURCE_SAFE_EXCLUDES, ...(config.exclude ?? []), ...rules.exclude],
    { dot: true, nocase: true }
  );
  for (const file of [...new Set(candidates)].sort()) {
    if (!/\.md$/i.test(file)) {
      excluded.push({ path: file, reason: "Markdown files only" });
      continue;
    }
    if (reject(file)) {
      excluded.push({ path: file, reason: "Matches an exclusion rule" });
      continue;
    }
    if (
      !(await isInsideRealRoot(config.root, path.resolve(config.root, file)))
    ) {
      excluded.push({ path: file, reason: "Link points outside workspace" });
      continue;
    }
    files.push(file.replace(/\\/g, "/"));
  }
  return { rules, files, excluded };
}
