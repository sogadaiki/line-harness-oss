import {createRequire} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const require=createRequire(import.meta.url),{build}=createRequire(require.resolve('wrangler/package.json'))('esbuild');
const dir=await mkdtemp(join(tmpdir(),'hinatama-funnel-test-'));
try {
 const file=join(dir,'tests.mjs');
 await build({entryPoints:['tests/hinatama-funnel.test.ts'],outfile:file,bundle:true,platform:'node',format:'esm',target:'node22',external:['node:*'],alias:{'@line-crm/line-sdk':resolve('../../packages/line-sdk/src/index.ts'),'@line-crm/db':resolve('../../packages/db/src/index.ts')},define:{'process.env.HARNESS_FIXTURE_ROOT':JSON.stringify(process.cwd())}});
 const result=spawnSync(process.execPath,['--test',file],{stdio:'inherit'});process.exitCode=result.status??1;
} finally {await rm(dir,{recursive:true,force:true});}
