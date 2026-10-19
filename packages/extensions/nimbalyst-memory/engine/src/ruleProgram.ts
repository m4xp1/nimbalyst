/** Browser-safe, serialized source policy. No filesystem or index dependencies. */
export interface RulePattern {source:string;flags:string}
export interface SourceRuleEntry {mode:'include'|'exclude';match:RulePattern;prefixes:Array<{match:RulePattern;literal:boolean;weight:number}>}
export type SourceRuleProgram=SourceRuleEntry[];
const compiled=new WeakMap<RulePattern,RegExp>();
export function matchesRule(pattern:RulePattern,text:string):boolean {
 let regex=compiled.get(pattern);if(!regex){regex=new RegExp(pattern.source,pattern.flags);compiled.set(pattern,regex);}return regex.test(text);
}
export function evaluateSourceRuleProgram(entries:SourceRuleProgram,relative:string):'include'|'exclude'|undefined {
 const parts=relative.replace(/\\/g,'/').split('/');let best=-1,decision:'include'|'exclude'|undefined;
 for(const entry of entries){if(!matchesRule(entry.match,relative))continue;let score=0;
  for(const prefix of entry.prefixes)for(let depth=1;depth<=parts.length;depth++)if(matchesRule(prefix.match,parts.slice(0,depth).join('/')))score=Math.max(score,depth*1000000+(prefix.literal?100000:0)+prefix.weight);
  if(score>best||score===best&&entry.mode==='exclude'){best=score;decision=entry.mode;}
 }return decision;
}
export interface TreePolicyRoot {id:string|null;path:string;treePaths?:string[];available:boolean;includes:RulePattern[];hardExcludes:RulePattern[];rules:SourceRuleProgram;directoryTargets:string[];entityFiles:string[]}
export interface MemoryTreePolicy {roots:TreePolicyRoot[];caseInsensitive:boolean}
function normalized(value:string,lower:boolean):string {const p=value.replace(/\\/g,'/').replace(/\/+$/,'');return lower?p.toLowerCase():p;}
export function treePolicyRoot(policy:MemoryTreePolicy,value:string):{root:TreePolicyRoot;relative:string}|undefined {
 const file=normalized(value,policy.caseInsensitive),matches=policy.roots.flatMap(root=>root.available?[root.path,...root.treePaths??[]].flatMap(alias=>{const base=normalized(alias,policy.caseInsensitive);return file===base||file.startsWith(base+'/')?[{root,relative:file.slice(base.length).replace(/^\//,''),length:base.length}]:[];}):[]);
 return matches.find(hit=>hit.root.id===null)??matches.sort((a,b)=>b.length-a.length)[0];
}
export function treePolicyIncludes(policy:MemoryTreePolicy,value:string,directory=false):boolean {
 const hit=treePolicyRoot(policy,value);if(!hit)return false;const {root,relative}=hit;
 if(root.hardExcludes.some(pattern=>matchesRule(pattern,relative)))return false;
 const decision=evaluateSourceRuleProgram(root.rules,relative);
 if(decision==='include')return true;
 if(directory&&root.directoryTargets.some(target=>{const name=normalized(target,policy.caseInsensitive);return (name===relative||name.startsWith(relative+'/')||relative==='')&&evaluateSourceRuleProgram(root.rules,name)!=='exclude';}))return true;
 if(decision==='exclude')return false;
 // Default subtree masks also cover collapsed descendant folders.
 if(directory&&root.directoryTargets.some(target=>relative.startsWith(normalized(target,policy.caseInsensitive)+'/')))return true;
 return root.includes.some(pattern=>matchesRule(pattern,relative))||root.entityFiles.some(file=>normalized(file,policy.caseInsensitive)===relative);
}
