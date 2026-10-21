/** Minimal YAML frontmatter parsing for facts files. */
import yaml from 'js-yaml';

export interface ParsedFrontmatter {
  data: Record<string, unknown>;
  body: string;
}

/**
 * Split a leading `--- ... ---` YAML block from the markdown body. Returns an
 * empty `data` object when there is no frontmatter or it fails to parse.
 */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  if (!raw.startsWith('---')) return { data: {}, body: raw };
  const lines = raw.split('\n');
  if (lines[0].trim() !== '---') return { data: {}, body: raw };
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      const yamlText = lines.slice(1, i).join('\n');
      const body = lines.slice(i + 1).join('\n');
      try {
        const data = yaml.load(yamlText);
        return {
          data: data && typeof data === 'object' ? (data as Record<string, unknown>) : {},
          body,
        };
      } catch {
        return { data: {}, body };
      }
    }
  }
  return { data: {}, body: raw };
}

/** Document metadata is data, not an instruction; invalid blocks stay literal. */
export function documentFrontmatter(raw:string):{data:Record<string,unknown>;bodyStart:number;warning?:'invalid-frontmatter'} {
 const first=/^(?:\uFEFF)?---[ \t]*\r?\n/.exec(raw);if(!first)return{data:{},bodyStart:0};
 const closing=/^---[ \t]*\r?$/gm;closing.lastIndex=first[0].length;const end=closing.exec(raw);if(!end)return{data:{},bodyStart:0};
 const bodyStart=end.index+end[0].length+(raw[end.index+end[0].length]==='\n'?1:0);
 try{const data=yaml.load(raw.slice(first[0].length,end.index),{schema:yaml.JSON_SCHEMA});if(data===undefined||data===null)return{data:{},bodyStart};if(typeof data!=='object'||Array.isArray(data))throw Error('Frontmatter must be a mapping');// Reject cycles/overly complex graphs instead of hiding an unindexable YAML block.
 const active=new Set<object>(),done=new Set<object>(),sizes=new Map<object,number>(),stack:Array<{value:unknown;exit?:boolean}>=[{value:data}];let nodes=0;
 while(stack.length){const item=stack.pop()!,value=item.value;if(!value||typeof value!=='object')continue;if(item.exit){active.delete(value);done.add(value);const size=Object.values(value).reduce<number>((total,child)=>total+(child&&typeof child==='object'?(sizes.get(child)??0):1),0);if(size>10000)throw Error('Expanded YAML is too complex');sizes.set(value,size);continue;}if(active.has(value))throw Error('Cyclic YAML');if(done.has(value))continue;if(++nodes>10000)throw Error('Complex YAML');active.add(value);stack.push({value,exit:true});for(const child of Object.values(value))stack.push({value:child});}
 return{data:data as Record<string,unknown>,bodyStart};}
 catch{return{data:{},bodyStart:0,warning:'invalid-frontmatter'};}
}
