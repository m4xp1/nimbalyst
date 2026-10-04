export interface SafeIndexError { category: 'authentication'|'quota'|'rate-limit'|'network'|'access'|'input'|'other'; action:string }
/** Classify locally; never forward provider responses, credentials or document text. */
export function safeIndexError(error:unknown):SafeIndexError {
 const e=error as {message?:string;code?:string;status?:number};const text=(e?.message??'').toLowerCase();
 if(/insufficient_quota|quota|billing/.test(text))return {category:'quota',action:'Check the provider quota, then use Rebuild. Automatic retries are not enabled.'};
 if(e?.status===401||/\b401\b|invalid.*key|unauthoriz/.test(text))return {category:'authentication',action:'Review provider access before retrying Rebuild.'};
 if(e?.status===403||/\b403\b|forbidden/.test(text))return {category:'access',action:'Check provider access or file permissions, then use Rebuild.'};
 if(e?.status===429||/\b429\b|rate.?limit/.test(text))return {category:'rate-limit',action:'Wait for the provider limit to clear, then use Rebuild. Automatic retries are not enabled.'};
 if(['EACCES','EPERM'].includes(e?.code??''))return {category:'access',action:'Check file access and source settings, then use Rebuild.'};
 if(e?.status===400||/\b400\b|too large|too long|invalid input/.test(text))return {category:'input',action:'Check source size and provider input limits before using Rebuild.'};
 if(/fetch|network|timeout|\b5\d\d\b/.test(text)||['ENOTFOUND','ECONNRESET','ETIMEDOUT'].includes(e?.code??''))return {category:'network',action:'Check the connection or provider availability, then use Rebuild.'};
 return {category:'other',action:'Check source settings and application logs, then use Rebuild.'};
}
export interface FileIndexStatus {
 state:'not-started'|'building'|'ready'|'partial'|'failed';
 phase:string|null; discoveredFiles:number|null; completedFiles:number|null; failedFiles:number|null;
 error:SafeIndexError|null;
}
