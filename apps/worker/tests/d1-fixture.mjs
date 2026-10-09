import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/** Actual SQLite SQL execution, with the small D1 interface used by production. No remote DB. */
export function fixture() {
  const sql=new DatabaseSync(':memory:');
  const directory=resolve(process.env.HARNESS_FIXTURE_ROOT,'../../packages/db');
  sql.exec(readFileSync(resolve(directory,'schema.sql'),'utf8'));
  for (const filename of readdirSync(resolve(directory,'migrations')).filter(f=>/^\d{3}_.*\.sql$/.test(f)).sort()) {
    const source=readFileSync(resolve(directory,'migrations',filename),'utf8').replace(/--[^\n]*/g,'');
    for (const statement of source.split(';').map(s=>s.trim()).filter(Boolean)) {
      try {sql.exec(statement);}
      catch(error) {
        // schema.sql includes some historical migrations. New migrations must pass strictly.
        if (Number(filename.slice(0,3))<24 && /duplicate column name/.test(error.message)) continue;
        throw new Error(filename+': '+error.message);
      }
    }
  }
  sql.exec('PRAGMA foreign_keys=ON');
  const wrap=(source, values=[])=>({
    bind(...next){return wrap(source,next)},
    async first(column){const row=sql.prepare(source).get(...values);return row ? (column ? row[column] : {...row}) : null},
    async all(){return {success:true,results:sql.prepare(source).all(...values).map(row=>({...row})),meta:{changes:0}}},
    async run(){const result=sql.prepare(source).run(...values);return {success:true,results:[],meta:{changes:Number(result.changes),last_row_id:Number(result.lastInsertRowid)}}},
  });
  const db={prepare:wrap,async exec(source){sql.exec(source);return {count:1,duration:0}},async batch(statements){sql.exec('BEGIN');try {const results=[];for(const statement of statements)results.push(await statement.run());sql.exec('COMMIT');return results;}catch(error){sql.exec('ROLLBACK');throw error;}}};
  for(const id of ['a','b']) {
    sql.prepare(`INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret,token_expires_at) VALUES (?,?,?,?,?,?)`).run(id,'channel-'+id,'練習LINE '+id,'fixture-token-'+id,'fixture-secret-'+id,'2099-01-01T00:00:00+09:00');
    sql.prepare(`INSERT INTO friends(id,line_user_id,display_name,line_account_id,metadata) VALUES (?,?,?,?,?)`).run('friend-'+id,'user-'+id,'架空利用者 '+id,id,'{}');
    sql.prepare(`INSERT INTO tags(id,name,line_account_id) VALUES (?,?,?)`).run('tag-'+id,'練習タグ '+id,id);
  }
  sql.prepare(`INSERT INTO staff_members(id,name,role,api_key) VALUES (?,?,?,?)`).run('staff-test','架空スタッフ','staff','fixture-staff-key');
  sql.prepare(`INSERT INTO staff_line_accounts(staff_id,line_account_id) VALUES (?,?)`).run('staff-test','a');
  return {db,sql,close:()=>sql.close()};
}
