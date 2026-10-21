'use client'

import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { fetchApi } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'

type FunnelStep = { key: string; label: string; count: number; dropoff: number | null; rate: number | null }
type ResultStates = { pending: number; sending: number; awaiting_friend: number; sent: number; cancelled: number; failed: number }
type OutcomeCounts = { newFriends:number; unblocked:number; unknownFollows:number; inquiries:number }
type FunnelGroup = {
  lpVersion: string; source: string; medium: string; campaign: string; content: string; ref: string
  lpViews: number; visitsStarted: number; started: number; receiptPageViews?: number; steps: FunnelStep[]
  questionViews: { questionNumber: number; count: number }[]
  resultStates: ResultStates
  outcomes?: OutcomeCounts
}
type FunnelReport = {
  from: string; to: string; timezone: 'Asia/Tokyo'; observationHours: number; asOf: number
  groups: FunnelGroup[]; unattributedResultViews: number
}
type Filters = { from: string; to: string; source: string; campaign: string; version: string }

const stageLabels = [
  ['start', '1問目表示（旧版は開始クリック）'],
  ...Array.from({ length: 8 }, (_, i) => [`q${i + 1}`, `設問 ${i + 1} 回答完了`]),
  ['complete', '診断完了'],
  ['line_cta', 'LINEボタンクリック'],
  ['result_view', 'LINE送信受付済み画面の表示'],
]
const stateLabels: { key: keyof ResultStates; label: string }[] = [
  { key: 'pending', label: '送信待ち' },
  { key: 'sending', label: '送信処理中' },
  { key: 'awaiting_friend', label: '友だち追加待ち' },
  { key: 'sent', label: '送信受付済み' },
  { key: 'cancelled', label: '取り消し' },
  { key: 'failed', label: '送信エラー' },
]
const inputClass = 'min-h-[44px] w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-green-600 focus:outline-none focus:ring-2 focus:ring-green-100'
const number = (value: number) => value.toLocaleString('ja-JP')
const percent = (value: number | null) => value === null ? '—' : `${(value * 100).toLocaleString('ja-JP', { maximumFractionDigits: 1 })}%`
const ratio = (count: number, base: number) => base > 0 ? count / base : null

function jstDate(now = Date.now()) {
  return new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

function initialFilters(): Filters {
  const to = jstDate()
  const from = new Date(Date.parse(`${to}T00:00:00Z`) - 6 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  return { from, to, source: '', campaign: '', version: '' }
}

function validDate(value: string) {
  const parsed = Date.parse(`${value}T00:00:00Z`)
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value
}

function validReport(data: FunnelReport) {
  const validCount = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0
  return data.timezone === 'Asia/Tokyo' && validDate(data.from) && validDate(data.to)
    && Number.isFinite(data.asOf) && data.observationHours > 0
    && validCount(data.unattributedResultViews) && Array.isArray(data.groups)
    && data.groups.every(group => validCount(group.started) && validCount(group.lpViews) && validCount(group.visitsStarted)
      && (group.receiptPageViews === undefined || validCount(group.receiptPageViews))
      && Array.isArray(group.steps) && stageLabels.every(([key]) => {
        const step = group.steps.find(item => item.key === key)
        return step && validCount(step.count) && (step.dropoff === null || validCount(step.dropoff))
          && (step.rate === null || (Number.isFinite(step.rate) && step.rate >= 0 && step.rate <= 1))
      })
      && Array.isArray(group.questionViews) && Array.from({ length: 8 }, (_, index) => index + 1).every(questionNumber => validCount(group.questionViews.find(question => question.questionNumber === questionNumber)?.count))
      && group.resultStates && stateLabels.every(({ key }) => validCount(group.resultStates[key])))
}

function totals(groups: FunnelGroup[]): FunnelGroup {
  const started = groups.reduce((sum, group) => sum + group.started, 0)
  const steps = stageLabels.map(([key, label], index) => {
    const count = groups.reduce((sum, group) => sum + (group.steps.find(step => step.key === key)?.count ?? 0), 0)
    const previous = index > 0 ? groups.reduce((sum, group) => sum + (group.steps.find(step => step.key === stageLabels[index - 1][0])?.count ?? 0), 0) : null
    return { key, label, count, dropoff: previous === null ? null : previous - count, rate: ratio(count, started) }
  })
  return {
    lpVersion: '', source: '', medium: '', campaign: '', content: '', ref: '', started, steps,
    lpViews: groups.reduce((sum, group) => sum + group.lpViews, 0),
    visitsStarted: groups.reduce((sum, group) => sum + group.visitsStarted, 0),
    receiptPageViews: groups.reduce((sum, group) => sum + (group.receiptPageViews ?? stateLabels.reduce((n, {key}) => n + group.resultStates[key], 0)), 0),
    questionViews: Array.from({ length: 8 }, (_, index) => ({
      questionNumber: index + 1,
      count: groups.reduce((sum, group) => sum + (group.questionViews.find(question => question.questionNumber === index + 1)?.count ?? 0), 0),
    })),
    resultStates: Object.fromEntries(stateLabels.map(({ key }) => [key, groups.reduce((sum, group) => sum + group.resultStates[key], 0)])) as ResultStates,
    outcomes: groups.every(group=>group.outcomes) ? {
      newFriends:groups.reduce((n,g)=>n+g.outcomes!.newFriends,0),
      unblocked:groups.reduce((n,g)=>n+g.outcomes!.unblocked,0),
      unknownFollows:groups.reduce((n,g)=>n+g.outcomes!.unknownFollows,0),
      inquiries:groups.reduce((n,g)=>n+g.outcomes!.inquiries,0),
    } : undefined,
  }
}

function FunnelTable({ group, caption }: { group: FunnelGroup; caption: string }) {
  return <>
    <p className="mb-2 text-xs text-gray-500 sm:hidden">表は横にスクロールできます。</p>
    <div tabIndex={0} aria-label={caption} className="overflow-x-auto rounded-lg border border-gray-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-green-600">
    <table className="w-full min-w-[750px] whitespace-nowrap text-sm">
      <caption className="sr-only">{caption}</caption>
      <thead className="bg-gray-50 text-gray-600">
        <tr>
          <th scope="col" className="px-4 py-3 text-left font-medium">段階</th>
          <th scope="col" className="px-4 py-3 text-right font-medium">設問表示</th>
          <th scope="col" className="px-4 py-3 text-right font-medium">通過した診断回数</th>
          <th scope="col" className="px-4 py-3 text-right font-medium">開始からの通過率</th>
          <th scope="col" className="px-4 py-3 text-right font-medium">前段階からの離脱</th>
          <th scope="col" className="px-4 py-3 text-right font-medium">離脱率</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-100">
        {stageLabels.map(([key, label], index) => {
          const step = group.steps.find(item => item.key === key)
          const previous = index > 0 ? group.steps.find(item => item.key === stageLabels[index - 1][0]) : null
          const questionNumber = /^q[1-8]$/.test(key) ? Number(key.slice(1)) : null
          const questionViews = group.questionViews.find(item => item.questionNumber === questionNumber)
          return <tr key={key} className={key === 'result_view' ? 'bg-green-50' : ''}>
            <th scope="row" className="px-4 py-3 text-left font-medium text-gray-900">{label}</th>
            <td className="px-4 py-3 text-right tabular-nums text-gray-600">{questionViews ? `${number(questionViews.count)}回` : '—'}</td>
            <td className="px-4 py-3 text-right font-semibold tabular-nums">{step ? `${number(step.count)}回` : '—'}</td>
            <td className="px-4 py-3 text-right tabular-nums">{percent(step?.rate ?? null)}</td>
            <td className="px-4 py-3 text-right tabular-nums text-gray-600">{step?.dropoff === null || step?.dropoff === undefined ? '—' : `${number(step.dropoff)}回`}</td>
            <td className="px-4 py-3 text-right tabular-nums text-gray-600">{percent(step?.dropoff === null || step?.dropoff === undefined || !previous ? null : ratio(step.dropoff, previous.count))}</td>
          </tr>
        })}
      </tbody>
    </table>
    </div>
  </>
}

export default function DiagnosisFunnel() {
  const { selectedAccountId } = useAccount()
  const [filters, setFilters] = useState<Filters>(initialFilters)
  const [applied, setApplied] = useState<Filters>(filters)
  const [refresh, setRefresh] = useState(0)
  const [result, setResult] = useState<{ accountId: string; data: FunnelReport } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [validation, setValidation] = useState('')

  useEffect(() => {
    let active = true
    setResult(null)
    setError('')
    if (!selectedAccountId) {
      setLoading(false)
      return () => { active = false }
    }
    setLoading(true)
    const query = new URLSearchParams({ from: applied.from, to: applied.to })
    if (applied.source) query.set('source', applied.source)
    if (applied.campaign) query.set('campaign', applied.campaign)
    if (applied.version) query.set('version', applied.version)
    fetchApi<{ success: boolean; data: FunnelReport }>(`/api/diagnosis/funnel?${query}`)
      .then(response => {
        if (!response.success || !response.data || !validReport(response.data)) throw new Error('Funnel data unavailable')
        if (active) setResult({ accountId: selectedAccountId, data: response.data })
      })
      .catch(() => { if (active) setError('診断ファネルを取得できませんでした。「集計する」で再取得してください。') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [selectedAccountId, applied, refresh])

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!validDate(filters.from) || !validDate(filters.to) || filters.from > filters.to || filters.to > jstDate()) {
      setValidation('開始日は今日までの範囲で、期間の初日から最終日の順に指定してください。')
      return
    }
    setValidation('')
    setApplied({ ...filters, source: filters.source.trim(), campaign: filters.campaign.trim(), version: filters.version.trim() })
    setRefresh(value => value + 1)
  }

  const report = result?.accountId === selectedAccountId ? result?.data ?? null : null
  const summary = report && report.groups.length > 0 ? totals(report.groups) : null
  const resultCount = summary?.steps.find(step => step.key === 'result_view')?.count ?? null
  const asOf = report ? new Date(report.asOf * 1000) : null
  const matureAfter = report ? Date.parse(`${report.to}T00:00:00+09:00`) + (24 + report.observationHours) * 60 * 60 * 1000 : null
  const isProvisional = asOf && matureAfter !== null ? asOf.getTime() < matureAfter : false

  return <section className="mt-6 rounded-lg border border-gray-200 bg-white p-4 sm:p-6" aria-labelledby="diagnosis-funnel-title" aria-busy={loading}>
    <h2 id="diagnosis-funnel-title" className="text-lg font-semibold text-gray-900">診断ファネル</h2>
    <p className="mt-2 text-sm leading-6 text-gray-600">診断 1 回ごとに、どこまで進んだかを確認します。同じ人がやり直した診断は別の 1 回です。</p>

    <form onSubmit={submit} className="mt-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <label className="block text-sm font-medium text-gray-700">開始日の初日（日本時間）
          <input type="date" value={filters.from} max={jstDate()} required onChange={event => setFilters({ ...filters, from: event.target.value })} className={`mt-1 ${inputClass}`} />
        </label>
        <label className="block text-sm font-medium text-gray-700">開始日の最終日（含む）
          <input type="date" value={filters.to} max={jstDate()} required onChange={event => setFilters({ ...filters, to: event.target.value })} className={`mt-1 ${inputClass}`} />
        </label>
        <label className="block text-sm font-medium text-gray-700">UTM source
          <input value={filters.source} onChange={event => setFilters({ ...filters, source: event.target.value })} placeholder="すべて" maxLength={200} className={`mt-1 ${inputClass}`} />
        </label>
        <label className="block text-sm font-medium text-gray-700">UTM campaign
          <input value={filters.campaign} onChange={event => setFilters({ ...filters, campaign: event.target.value })} placeholder="すべて" maxLength={200} className={`mt-1 ${inputClass}`} />
        </label>
        <label className="block text-sm font-medium text-gray-700">LP版
          <input value={filters.version} onChange={event => setFilters({ ...filters, version: event.target.value })} placeholder="すべて" maxLength={100} className={`mt-1 ${inputClass}`} />
        </label>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="submit" disabled={loading || !selectedAccountId} className="min-h-[44px] rounded-md bg-gray-900 px-5 py-2 text-sm font-medium text-white focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2 disabled:cursor-wait disabled:opacity-50">{loading ? '集計中…' : '集計する'}</button>
        <p className="text-xs leading-5 text-gray-500">初期表示は今日を含む過去 7 日間。流入とLP版は完全一致で絞り込みます。</p>
      </div>
      {validation && <p role="alert" className="mt-3 text-sm text-red-700">{validation}</p>}
    </form>

    {loading && <p role="status" className="mt-6 text-sm text-gray-600">診断ファネルを読み込み中…</p>}
    {error && <p role="alert" className="mt-6 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</p>}
    {!selectedAccountId && !loading && <p className="mt-6 text-sm text-gray-600">LINEアカウントを選択すると、診断ファネルを確認できます。</p>}
    {report && !summary && <div className="mt-6">
      <p className="text-sm font-medium text-gray-900">{report.from} 〜 {report.to} に開始した診断</p>
      <p className="mt-3 rounded-md bg-gray-50 p-4 text-sm text-gray-600">計測データなし。指定した期間・条件の計測データはありません。</p>
      <div className="mt-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
        {['診断開始', '診断完了', 'LINEボタンクリック', 'LINE送信受付済み画面の表示'].map(label => <div key={label} className="rounded-lg border border-gray-200 p-4">
          <p className="text-xs font-medium leading-5 text-gray-600">{label}</p>
          <p className="mt-2 text-2xl font-bold text-gray-900">—</p>
          <p className="mt-1 text-xs text-gray-500">計測データなし</p>
        </div>)}
      </div>
      <p className="mt-3 text-xs leading-6 text-gray-600">開始した診断と結び付かない受け取り画面の表示（途中状態を含む）：{number(report.unattributedResultViews)}回。期間全体の件数で、流入・LP版の絞り込み対象外です。ファネルの通過数には含めません。</p>
    </div>}
    {report && summary && <>
      <div className="mt-6 flex flex-wrap items-center justify-between gap-2 text-sm">
        <p className="font-medium text-gray-900">{report.from} 〜 {report.to} に開始した診断</p>
        <p className="text-xs text-gray-500">集計時点：{asOf?.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', hour12: false })}（日本時間）</p>
      </div>
      <div className="mt-3 rounded-md border border-gray-200 bg-gray-50 p-3 text-xs leading-6 text-gray-600">
        <p>開始から {report.observationHours} 時間以内に、順番に通過した同じ診断を集計します。翌日に進んでも開始した日に帰属します。</p>
        {isProvisional && <p className="font-medium text-amber-800">この期間には、開始から {report.observationHours} 時間を経過していない診断が含まれます。通過数と離脱数はまだ変わる可能性があります。</p>}
        <p>計測を開始した後の診断が対象です。過去の設問別進捗はさかのぼって集計できません。</p>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
        {[
          { label: '診断開始', count: summary.started },
          { label: '診断完了', count: summary.steps.find(step => step.key === 'complete')?.count },
          { label: 'LINEボタンクリック', count: summary.steps.find(step => step.key === 'line_cta')?.count },
          { label: 'LINE送信受付済み画面の表示', count: resultCount },
        ].map(card => <div key={card.label} className={`rounded-lg border p-4 ${card.label === 'LINE送信受付済み画面の表示' ? 'border-green-200 bg-green-50' : 'border-gray-200'}`}>
          <p className="text-xs font-medium leading-5 text-gray-600">{card.label}</p>
          <p className="mt-2 text-2xl font-bold tabular-nums text-gray-900">{card.count === null || card.count === undefined ? '—' : number(card.count)}<span className="ml-1 text-sm font-normal">回</span></p>
          <p className="mt-1 text-xs text-gray-500">開始から {percent(card.count === null || card.count === undefined ? null : ratio(card.count, summary.started))}</p>
        </div>)}
      </div>

      <p className="mt-5 mb-3 text-xs leading-6 text-gray-600">「設問表示」は設問を開いた診断回数、「通過」はその回答を完了した診断回数です。通過率の分母は診断開始、離脱率の分母は直前の段階です。</p>
      <FunnelTable group={summary} caption="診断開始からLINE送信受付済み画面表示までのファネル" />

      <div className="mt-5 rounded-lg border border-green-200 bg-green-50 p-4">
        <h3 className="text-sm font-semibold text-gray-900">LINE追加・問い合わせ（開始から7日以内）</h3>
        <div className="mt-3 grid grid-cols-2 gap-4 xl:grid-cols-4">{[
          ['新規友だち追加（LINE判定）',summary.outcomes?.newFriends],
          ['ブロック解除',summary.outcomes?.unblocked],
          ['追加／解除の区分不明',summary.outcomes?.unknownFollows],
          ['本人からの初回問い合わせ',summary.outcomes?.inquiries],
        ].map(([label,value])=><div key={String(label)}><p className="text-xs leading-5 text-gray-600">{label}</p><p className="mt-1 text-2xl font-bold">{typeof value==='number'?number(value):'—'}<span className="ml-1 text-sm font-normal">人</span></p></div>)}</div>
        <p className="mt-3 text-xs leading-6 text-gray-600">署名を検証したLINEの追加・受信イベントを集計。既存友だちの認証、結果送信、画面表示を新規追加とは数えません。問い合わせは本人が送った最初のテキスト（結果請求キーワード・スタンプ・自動返信を除く）で、面談実施とは別です。</p>
        <p className="mt-2 text-xs leading-6 text-gray-600">最後にLINE認証した診断へ1人1回帰属します。追加せず相談する既存友だちもいるため、上の段階と単純な離脱率で比較できません。LINEの新規／解除判定は完全な正確性を保証せず、流入情報のない問い合わせは媒体へ推定配分しません。</p>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <div className="rounded-lg border border-gray-200 p-4">
          <h3 className="text-sm font-semibold text-gray-900">LP訪問から診断開始</h3>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex justify-between gap-4"><dt className="text-gray-600">LPを表示した訪問</dt><dd className="tabular-nums">{number(summary.lpViews)}回</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-gray-600">うち診断を開始した訪問</dt><dd className="tabular-nums">{number(summary.visitsStarted)}回</dd></div>
            <div className="flex justify-between gap-4"><dt className="font-medium">訪問からの開始率</dt><dd className="font-semibold tabular-nums">{percent(ratio(summary.visitsStarted, summary.lpViews))}</dd></div>
          </dl>
          <p className="mt-3 text-xs leading-5 text-gray-500">1 回の訪問で複数回診断できるため、LP訪問数と診断回数は分けて確認します。</p>
        </div>
        <div className="rounded-lg border border-gray-200 p-4">
          <h3 className="text-sm font-semibold text-gray-900">受け取り画面の最後の表示報告時点の状態（途中状態を含む）</h3>
            <p className="mt-2 text-xs leading-5 text-gray-600">受け取り画面を表示した診断：{number(summary.receiptPageViews ?? 0)}回。追加待ち・失敗も含み、上の最終到達とは区別します。</p>
          <dl className="mt-3 grid grid-cols-2 gap-x-5 gap-y-2 text-sm">
            {stateLabels.map(({ key, label }) => <div key={key} className="flex justify-between gap-3"><dt className="text-gray-600">{label}</dt><dd className="tabular-nums">{number(summary.resultStates[key])}回</dd></div>)}
          </dl>
          <p className="mt-3 text-xs leading-5 text-gray-500">画面見出し「結果をLINEに送りました」が見える状態で描画され、表示報告された診断回数です。LINEでの実際の受信・既読は分かりません。新規友だち追加の実数は別の指標です。</p>
        </div>
      </div>
      <p className="mt-3 text-xs leading-6 text-gray-600">開始した診断と結び付かない受け取り画面の表示（途中状態を含む）：{number(report.unattributedResultViews)}回。期間全体の件数で、流入・LP版の絞り込み対象外です。ファネルの通過数には含めません。</p>

      {report.groups.length > 0 && <div className="mt-6">
        <h3 className="text-sm font-semibold text-gray-900">流入・LP版ごとの比較</h3>
        <p className="mt-1 text-xs leading-5 text-gray-500">行を開くと、流入条件と設問ごとの進捗を確認できます。</p>
        <div className="mt-3 divide-y divide-gray-200 rounded-lg border border-gray-200">
          {report.groups.map(group => <details key={JSON.stringify([group.lpVersion, group.source, group.medium, group.campaign, group.content, group.ref])} className="p-4">
            <summary className="cursor-pointer text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-green-600">
              <span className="font-medium">{group.lpVersion || 'LP版未指定'} ／ {group.source || '流入元未指定'} ／ {group.campaign || 'キャンペーン未指定'}</span>
              <span className="mt-1 block pl-4 text-xs leading-5 text-gray-600">開始 {number(group.started)}回 → 送信受付済み画面 {number(group.steps.find(step => step.key === 'result_view')?.count ?? 0)}回</span>
              <span className="mt-1 block pl-4 text-xs leading-5 text-gray-600">新規追加 {group.outcomes?number(group.outcomes.newFriends):'—'}人 ／ 問い合わせ {group.outcomes?number(group.outcomes.inquiries):'—'}人 ／ {group.content}・{group.ref}</span>
            </summary>
            <dl className="my-4 grid gap-2 text-xs sm:grid-cols-2 xl:grid-cols-3">
              {[
                ['LP版', group.lpVersion], ['source', group.source], ['medium', group.medium],
                ['campaign', group.campaign], ['content', group.content], ['ref', group.ref],
              ].map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-gray-500">{label}</dt><dd className="mt-1 break-all text-gray-900">{value || '未指定'}</dd></div>)}
            </dl>
            <FunnelTable group={group} caption={`${group.lpVersion || 'LP版未指定'}の診断ファネル`} />
          </details>)}
        </div>
      </div>}
    </>}
  </section>
}
