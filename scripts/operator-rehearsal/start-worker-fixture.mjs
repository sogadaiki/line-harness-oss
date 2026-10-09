// Actual patched worker + in-memory SQLite. Every outbound request is intercepted.
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {fixture} from '../../apps/worker/tests/d1-fixture.mjs';
const root=resolve(import.meta.dirname,'../..');
process.env.HARNESS_FIXTURE_ROOT=resolve(root,'apps/worker');
const require=createRequire(resolve(root,'apps/worker/package.json'));
const {build}=createRequire(require.resolve('wrangler/package.json'))('esbuild');
const dir=await mkdtemp(join(tmpdir(),'harness-worker-fixture-'));
await build({entryPoints:[resolve(root,'apps/worker/src/index.ts')],outfile:join(dir,'worker.mjs'),bundle:true,format:'esm',platform:'node',target:'node22',alias:{'@line-crm/line-sdk':resolve(root,'packages/line-sdk/src/index.ts'),'@line-crm/db':resolve(root,'packages/db/src/index.ts')}});
const {default:worker}=await import(pathToFileURL(join(dir,'worker.mjs')).href);
const f=fixture();
for(const id of ['a','b']) {
  f.sql.prepare(`INSERT INTO scenarios(id,name,trigger_type,line_account_id,is_active) VALUES (?,?,?,?,1)`).run('scenario-'+id,'架空：停止確認 '+id,'manual',id);
  f.sql.prepare(`INSERT INTO friend_scenarios(id,friend_id,scenario_id,next_delivery_at) VALUES (?,?,?,?)`).run('enrollment-'+id,'friend-'+id,'scenario-'+id,'2099-01-01T00:00:00+09:00');
}
const outbound=[];
globalThis.fetch=async(input,init={})=>{
  const url=String(input);
  if (!url.startsWith('https://api.line.me/')) throw new Error('External network blocked by fixture');
  outbound.push({url,method:init.method??'GET',simulated:true});
  return new Response(JSON.stringify({displayName:'架空LINE・外部送信なし',basicId:'@fixture'}),{headers:{'Content-Type':'application/json'}});
};
const env={DB:f.db,API_KEY:'fixture-owner-key',WORKER_URL:'',LINE_CHANNEL_ACCESS_TOKEN:'fixture-unused',LINE_CHANNEL_SECRET:'fixture-unused',ALLOWED_ORIGINS:'http://127.0.0.1:8345',ASSETS:{fetch:()=>new Response('Not found',{status:404})}};
const server=createServer(async(req,res)=>{
  try {
    if(req.url==='/fixture/state') {
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify({accounts:f.sql.prepare(`SELECT s.line_account_id,s.is_active,fs.status,fs.next_delivery_at FROM scenarios s JOIN friend_scenarios fs ON fs.scenario_id=s.id`).all(),outbound}));return;
    }
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const body=Buffer.concat(chunks);
    const waits=[];
    const response=await worker.fetch(new Request('http://127.0.0.1:8344'+req.url,{method:req.method,headers:req.headers,...(body.length?{body}:{})}),env,{waitUntil:p=>waits.push(p)});
    await Promise.all(waits);
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  } catch(error) {res.writeHead(500);res.end(JSON.stringify({success:false,error:error.message}));}
});
server.listen(8344,'127.0.0.1',()=>console.log('Actual patched worker fixture: 8344. Dummy login: fixture-owner-key. No LINE delivery.'));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{server.close();f.close();await rm(dir,{recursive:true,force:true});process.exit(0)});
