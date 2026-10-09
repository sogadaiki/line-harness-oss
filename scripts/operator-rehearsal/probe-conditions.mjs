// Run the actual source matcher on fictional events; no database or LINE calls.
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../../apps/worker/src/services/event-bus.ts', import.meta.url), 'utf8');
const start = source.indexOf('function matchConditions(');
const end = source.indexOf('/** アクション実行 */', start);
if (start < 0 || end < 0) throw new Error('Matcher boundaries changed; review source.');
const javascript = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const probes = [
  { label: 'UIの入力例: tagId=A, 実イベントはB', conditions: { tagId: 'A', operator: 'equals' }, payload: { eventData: { tagId: 'B' } }, expectedForOperator: false },
  { label: '実装のキー: tag_id=A, 実イベントはB', conditions: { tag_id: 'A' }, payload: { eventData: { tagId: 'B' } }, expectedForOperator: false },
  { label: '実装のキー: tag_id=A, 実イベントはA', conditions: { tag_id: 'A' }, payload: { eventData: { tagId: 'A' } }, expectedForOperator: true },
  { label: '未対応キーだけを指定', conditions: { made_up_condition: true }, payload: { eventData: {} }, expectedForOperator: false },
];
const results = probes.map(p => {
  const matches = runInNewContext(javascript + '\nmatchConditions(conditions, payload)', { conditions: p.conditions, payload: p.payload });
  return { ...p, observedMatch: matches, matchesOperatorExpectation: matches === p.expectedForOperator };
});
console.log(JSON.stringify({ source: 'apps/worker/src/services/event-bus.ts', evidence: 'actual source matcher, fictional events, no delivery', results }, null, 2));
