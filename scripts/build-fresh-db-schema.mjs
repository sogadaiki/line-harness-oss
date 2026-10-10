// Produce the current empty schema for a NEW dedicated DB, never mutate an existing DB.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const directory = resolve(root, 'packages/db');
const sql = new DatabaseSync(':memory:');
sql.exec(readFileSync(resolve(directory, 'schema.sql'), 'utf8'));
for (const name of readdirSync(resolve(directory, 'migrations')).filter(n => n.endsWith('.sql')).sort()) {
  for (const statement of readFileSync(resolve(directory, 'migrations', name), 'utf8').replace(/--[^\n]*/g, '').split(';').map(s => s.trim()).filter(Boolean)) {
    try { sql.exec(statement); }
    catch (error) {
      if (Number(name.slice(0, 3)) < 24 && /duplicate column name/.test(error.message)) continue;
      throw new Error(name + ': ' + error.message);
    }
  }
}
const objects = sql.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END,name").all();
const migrationNames = readdirSync(resolve(directory, 'migrations')).filter(n => n.endsWith('.sql')).sort();
const receipts = "CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);\n" + migrationNames.map(name => `INSERT INTO d1_migrations(name) VALUES('${name.replace(/'/g, "''")}');`).join('\n');
const source = '-- Fresh installation only. Generated from schema.sql and numeric migrations.\n' + objects.map(row => row.sql + ';').join('\n\n') + '\n\n' + receipts + '\n';
const check = new DatabaseSync(':memory:');
check.exec(source);
const count = check.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n;
const output = process.argv[2];
if (!output) throw new Error('Provide a destination SQL file');
writeFileSync(output, source);
console.log(`Validated empty schema: ${count} tables. No accounts, credentials or friends included.`);
sql.close(); check.close();
