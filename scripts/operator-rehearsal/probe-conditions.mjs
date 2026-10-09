// Run the actual source matcher on fictional events; no database or LINE calls.
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../../apps/worker/src/utils/automation-conditions.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module:ts.ModuleKind.CommonJS },
}).outputText;
const context={exports:{}};
runInNewContext(javascript,context);
const probes = [
  { label: 'UIの入力例: tagId=A, 実イベントはB', conditions: { tagId: 'A', operator: 'equals' }, payload: { eventData: { tagId: 'B' } }, expectedForOperator: false },
  { label: '実装のキー: tag_id=A, 実イベントはB', conditions: { tag_id: 'A' }, payload: { eventData: { tagId: 'B' } }, expectedForOperator: false },
  { label: '実装のキー: tag_id=A, 実イベントはA', conditions: { tag_id: 'A' }, payload: { eventData: { tagId: 'A' } }, expectedForOperator: true },
  { label: '未対応キーだけを指定', conditions: { made_up_condition: true }, payload: { eventData: {} }, expectedForOperator: false },
];
const results = probes.map(p => {
  const matches = context.exports.matchConditions(p.conditions,p.payload);
  assert.equal(matches,p.expectedForOperator,p.label);
  return { ...p, observedMatch: matches, matchesOperatorExpectation: matches === p.expectedForOperator };
});
console.log(JSON.stringify({ source: 'apps/worker/src/utils/automation-conditions.ts', evidence: 'actual repaired source matcher, fictional events, assertions, no delivery', results }, null, 2));
