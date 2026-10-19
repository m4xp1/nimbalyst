/// <reference path="./picomatch.d.ts" />
import { mkdirSync, readFileSync, writeFileSync, renameSync, statSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { SourceSet } from "./types.js";
import picomatch from "picomatch";
import {evaluateSourceRuleProgram,type SourceRuleProgram,type RulePattern} from "./ruleProgram.js";
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
    if (!Array.isArray(input) || input.length > 400)
      throw new Error("Use at most 400 source rules.");
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
    version: 1,
    ...visibleRules(rules(v?.include),rules(v?.exclude),overrides??[]),
  };
}
export function readSourceRules(dataDir: string): SourceRules {
  try {
    const saved=JSON.parse(readFileSync(path.join(dataDir, "sources.json"), "utf8"));
    const normalized=normalizeSourceRules(saved);
    if(saved.overrides!==undefined)writeSourceRules(dataDir,normalized);
    return normalized;
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
  writeFileSync(target + ".tmp", JSON.stringify(normalizeSourceRules(rules), null, 2) + "\n", "utf8");
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
  const normalized=normalizeSourceRules(rules);
  const base=builtins.filter(set=>!set.sourceRules);
  return normalized.include.length || normalized.exclude.length
    ? [...base,{sourceClass:'custom',include:normalized.include,sourceRules:{include:normalized.include,exclude:normalized.exclude}}]
    : [...base];
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

/** Literal paths from the tree use ordinary, editable glob escaping. */
export function literalSourceRule(relative:string,kind:'file'|'directory'):string {
 if(!relative && kind==='directory')return '**';
 return relative.replace(/[*?{}\[\]()!]/g,char=>'['+char+']');
}
/** Decode only literal patterns (including the tree's bracket escapes). */
export function sourceRulePath(rule:string):string|undefined {
 if(rule==='**')return '';
 const pattern=rule.replace(/\/\*\*$/,'');
 const decoded=pattern.replace(/\[([*?{}\[\]()!])\]/g,(_,char)=>'\u0001'+char+'\u0001');
 if(/[*?{}\[\]()!]/.test(decoded.replace(/\u0001.\u0001/g,'')))return undefined;
 return decoded.replace(/\u0001(.)\u0001/g,'$1');
}
function visibleRules(include:string[],exclude:string[],legacy:PathOverride[]){
 const same=(a:string,b:string)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
 for(const item of legacy){const rule=literalSourceRule(item.path,item.kind);
  include=include.filter(p=>!same(sourceRulePath(p)??p,item.path));exclude=exclude.filter(p=>!same(sourceRulePath(p)??p,item.path));
  (item.mode==='include'?include:exclude).push(rule);
 }
 const result={include:[...new Set(include)],exclude:[...new Set(exclude)]};
 if(result.include.length>400||result.exclude.length>400)throw Error('Use at most 400 source rules.');
 return result;
}
export function compileRulePatterns(patterns:string[]):RulePattern[]{
 return patterns.map(pattern=>{const re=picomatch.makeRe(pattern,{dot:true,nocase:process.platform==='win32'});return{source:re.source,flags:re.flags};});
}
/** Narrower matched path constraints win; equally specific exclusions win. */
export function compileSourceRuleProgram(rules:Pick<SourceRules,'include'|'exclude'>,root?:string):SourceRuleProgram{
 const options={dot:true,nocase:process.platform==='win32'};
 const patternRegex=(text:string)=>{const re=picomatch.makeRe(text,options);return{source:re.source,flags:re.flags};};
 const entries=(['include','exclude'] as const).flatMap(mode=>expandSourcePatterns(rules[mode],root).map(pattern=>{
  const segments=pattern.split('/');
  const prefixes=segments.flatMap((part,index)=>{
   if(part==='**'||part==='*')return[];
   const prefix=segments.slice(0,index+1).join('/'),literal=sourceRulePath(prefix),partLiteral=sourceRulePath(part)!==undefined;
   const anchored=segments[0]!=='**'&&segments[0]!=='*'&&sourceRulePath(segments[0])!==undefined;
   if(!partLiteral&&!anchored&&mode==='include')return[];
   return[{match:patternRegex(prefix),literal:partLiteral,weight:(literal??prefix.replace(/[*?{}\[\]()!+@|]/g,'')).length}];
  });
  return{mode,match:patternRegex(pattern),prefixes};
 }));
 return entries;
}
export function compileSourceRules(rules:Pick<SourceRules,'include'|'exclude'>,root:string){
 const program=compileSourceRuleProgram(rules,root);return(relative:string)=>evaluateSourceRuleProgram(program,relative);
}
