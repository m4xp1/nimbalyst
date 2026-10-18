/// <reference path="./picomatch.d.ts" />
import { mkdirSync, readFileSync, writeFileSync, renameSync, statSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { SourceSet } from "./types.js";
import fg from "fast-glob";
export interface PathOverride {path:string;kind:"file"|"directory";mode:"include"|"exclude";}
export interface SourceRules {
  version: 1;
  include: string[];
  exclude: string[];
  overrides?:PathOverride[];
}
export function normalizeSourceRules(value: unknown): SourceRules {
  const v = value as Partial<SourceRules> | null;
  function rules(input: unknown): string[] {
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
          return rule;
        })
      ),
    ];
  }
  let overrides:PathOverride[]|undefined;
  if(v?.overrides!==undefined){
    if(!Array.isArray(v.overrides)||v.overrides.length>200)throw Error('Use at most 200 path overrides.');
    const unique=new Map<string,PathOverride>();
    for(const value of v.overrides){
      if(!value || typeof value.path!=='string' || !['file','directory'].includes(value.kind) || !['include','exclude'].includes(value.mode))throw Error('Invalid path override.');
      const p=value.path.replace(/\\/g,'/').replace(/^\.\//,'').replace(/\/+$/,'');
      if(p.length>500||p.startsWith('/')||p.includes(':')||p.split('/').some(part=>part==='..'||part==='.')||p.includes('\0')||(!p&&value.kind!=='directory'))throw Error('Use a root-relative literal path for overrides.');
      const item={path:p,kind:value.kind,mode:value.mode} as PathOverride;
      unique.set((process.platform==='win32'?p.toLowerCase():p)+'|'+item.kind,item);
    }
    overrides=[...unique.values()];
  }
  return {
    ...(overrides===undefined?{}:{overrides}),
    version: 1,
    include: rules(v?.include),
    exclude: rules(v?.exclude),
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
/** A literal may name a file or a directory; preserve the user's spelling. */
export function expandSourcePatterns(rules: string[], root?: string): string[] {
  return rules.flatMap(rule => {
    if (/[*?{}[\\]()]/.test(rule)) return [rule];
    if (root) {
      try { return statSync(path.resolve(root, rule)).isDirectory() ? [rule + '/**'] : [rule]; }
      catch (error) { if (!['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    }
    return [rule, rule + '/**'];
  });
}
export function sourcesWithRules(
  builtins: SourceSet[],
  rules: SourceRules
): SourceSet[] {
  const explicit=(rules.overrides??[]).filter(o=>o.mode==='include').map(o=>{
    const literal=fg.posix.escapePath(o.path);
    return o.kind==='directory'?(literal?literal+'/**':'**'):literal;
  });
  return rules.include.length || rules.overrides?.length
    ? [...builtins, {sourceClass:'custom',include:[...rules.include,...explicit],pathOverrides:rules.overrides}]
    : [...builtins];
}
/** Most-specific literal path wins; globs and text content never determine identity. */
export function pathOverrideFor(overrides:PathOverride[],relative:string):PathOverride|undefined {
  const key=(p:string)=>process.platform==='win32'?p.toLowerCase():p;
  const pathKey=key(relative.replace(/\\/g,'/').replace(/\/+$/,''));
  return overrides.filter(o=>pathKey===key(o.path) || o.kind==='directory' && (!o.path || pathKey.startsWith(key(o.path)+'/')))
    .sort((a,b)=>b.path.length-a.path.length || (a.kind==='file'?-1:1))[0];
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
