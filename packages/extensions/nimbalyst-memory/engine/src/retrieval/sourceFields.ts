import {RussianStemmer,normalizeSearchText} from '@nimbalyst/search-text';
import {hasContentTerms,informativeTerms,tokenize} from './bm25.js';
import type {SourceSearchRecord,SearchFieldMatch} from '../types.js';
function pathVariants(value:string):string[]{const parts=value.split('/');return [...new Set([...parts,...parts.map((_,i)=>parts.slice(0,i+1).join('/')),...parts.map((_,i)=>parts.slice(i).join('/'))])];}
export function sourceKeywordText(record:SourceSearchRecord):string {
 const base=record.fileName.replace(/\.[^.]+$/,'');
 return[record.fileName,base,record.relativePath,...pathVariants(record.relativePath),...Object.values(record.fields).flat()].join('\n');
}
const normalized=(text:string)=>normalizeSearchText(text).trim().replace(/\s+/g,' ');
const metadataStemmer=new RussianStemmer();
const stemWord=(term:string)=>/^[а-я]+$/u.test(term)?metadataStemmer.stem(term):term;
interface PreparedField {field:string;value:string;normalized:string;base:string;exact:Set<string>;forms:Set<string>;}
const preparedFields=new WeakMap<SourceSearchRecord,PreparedField[]>();
export function prepareSourceFields(record:SourceSearchRecord):PreparedField[]{
 const cached=preparedFields.get(record);if(cached)return cached;
 const candidates:Array<[string,string]>=[['fileName',record.fileName],['path',record.relativePath],...Object.entries(record.fields).flatMap(([key,values])=>values.map(value=>[key,value] as [string,string]))];
 const fields=candidates.map(([field,value])=>{const base=field==='fileName'?value.replace(/\.[^.]+$/,''):value,words=tokenize(value+' '+(field==='fileName'?base:field==='path'?pathVariants(value).join(' '):''));return{field,value,normalized:normalized(value),base:normalized(base),exact:new Set(words),forms:new Set(words.map(stemWord))};});preparedFields.set(record,fields);return fields;
}
export function sourceFieldMatcher(query:string):(record:SourceSearchRecord)=>{priority:number;matches:SearchFieldMatch[]}{
 const terms=informativeTerms(query),stemmed=new Map(terms.map(term=>[term,stemWord(term)])),needle=normalized(query);
 const stem=(term:string)=>stemmed.get(term)??stemWord(term);
 const generic=new Set(['проект','работа','состояние','сессия','документ','project','work','state','session','document'].map(stem));
 const meaningful=hasContentTerms(query)&&(terms.length>1||!generic.has(stem(terms[0]??'')));
 return record=>{
  let priority=0;const matches:SearchFieldMatch[]=[];
  for(const {field,value,normalized:normal,base,exact,forms}of prepareSourceFields(record)){
   const fullValue=!!needle&&(normal===needle||field==='fileName'&&base===needle),covered=terms.filter(term=>exact.has(term)||forms.has(stem(term))),complete=terms.length>0&&covered.length===terms.length;
   if(!fullValue&&!covered.length)continue;
   const strong=meaningful&&(['fileName','title','description','aliases'].includes(field)||field==='path'&&fullValue);
   const strongComplete=complete&&(terms.length>1||!generic.has(stem(terms[0])));
   if(strong&&(fullValue||strongComplete))priority=Math.max(priority,fullValue?2:1);
   const matched:SearchFieldMatch={field,value,match:covered.every(term=>exact.has(term))?'exact':'stem',...(!['fileName','path'].includes(field)&&record.metadataRange?{sourceRange:record.metadataRange}:{})};if(strong&&(fullValue||strongComplete))matches.unshift(matched);else matches.push(matched);
  }
  return{priority,matches:matches.slice(0,6)};
 };
}
export function compareSearchResults(a:{score:number;fieldPriority?:number},b:{score:number;fieldPriority?:number}):number{return(b.fieldPriority??0)-(a.fieldPriority??0)||b.score-a.score;}
