// Read-only aggregate export through the existing Wrangler OAuth session.
// Never extracts credentials, LINE IDs, message contents or raw DB backups.
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const require=createRequire(import.meta.url),{build}=createRequire(require.resolve('wrangler/package.json'))('esbuild');
const [from,to]=process.argv.slice(2),valid=d=>/^\d{4}-\d{2}-\d{2}$/.test(d||'')&&new Date(d).toISOString().slice(0,10)===d;
if(!valid(from)||!valid(to)||from>to||(Date.parse(to)-Date.parse(from))/86400000>90)throw Error('Valid JST dates within 90 days required');
const root=resolve(import.meta.dirname,'..'),config=join(root,'wrangler.hinatama-diagnosis.production.toml');
const literal=v=>typeof v==='number'&&Number.isFinite(v)?String(v):typeof v==='string'?"'"+v.replaceAll("'","''")+"'":v===null?'NULL':(()=>{throw Error('Invalid query binding');})();
function query(sql,values=[]){
  if(!/^SELECT\b/i.test(sql.trim()))throw Error('Only SELECT is allowed');
  let i=0;const bound=sql.replaceAll('?',()=>literal(values[i++]));if(i!==values.length)throw Error('Binding mismatch');
  const raw=execFileSync(join(root,'node_modules/.bin/wrangler'),['d1','execute','hinatama-line-c','--remote','--config',config,'--command',bound,'--json'],{cwd:root,encoding:'utf8',maxBuffer:16*1024*1024,timeout:60000,stdio:['ignore','pipe','pipe']});
  const result=JSON.parse(raw);if(result.length!==1||!result[0].success)throw Error('Aggregate query failed');return result[0].results;
}
const wrap=(sql,values=[])=>({bind:(...next)=>wrap(sql,next),all:async()=>({results:query(sql,values)})});
const dir=await mkdtemp(join(tmpdir(),'hinatama-aggregate-'));
try {
  const file=join(dir,'funnel.mjs');await build({entryPoints:[join(root,'src/services/hinatama-funnel.ts')],outfile:file,bundle:true,platform:'node',format:'esm',target:'node22'});
  const {funnelReport}=await import(pathToFileURL(file));
  const report=await funnelReport({prepare:sql=>wrap(sql)},'c9cf9b32-c893-4fe1-9041-e63b87c62dd5',from,to,{version:'20261021-q1-v1'});
  process.stdout.write(JSON.stringify(report)+'\n');
} finally {await rm(dir,{recursive:true,force:true});}
