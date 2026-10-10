'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { fetchApi } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'

type Status = {friends:number;resultsAccepted:number;unreadChats:number;replies:number;currentFailures:number;paused:boolean}
export default function DiagnosisDashboard() {
  const {selectedAccountId,selectedAccount}=useAccount()
  const [status,setStatus]=useState<Status|null>(null)
  const [error,setError]=useState('')
  useEffect(()=>{let active=true;setStatus(null);setError('');
    fetchApi<{success:boolean;data:Status}>('/api/diagnosis/status').then(r=>{if(active)setStatus(r.data)}).catch(()=>{if(active)setError('状況を読み込めませんでした。画面を更新してください。')})
    return ()=>{active=false}
  },[selectedAccountId])
  const cards=[
    {label:'登録された友だち',value:status?.friends,href:'/friends',note:'この環境へ連携した友だちの数です。'},
    {label:'診断結果の送信',value:status?.resultsAccepted,href:'/friends',note:'LINEが受け付けた件数です。既読や面談数とは別です。'},
    {label:'未読の相談トーク',value:status?.unreadChats,href:'/chats',note:'店舗スタッフが内容を確認して日程を調整します。'}]
  return <div>
    <h1 className="text-2xl font-bold text-gray-900">診断結果・お仕事相談</h1>
    <p className="mt-2 text-gray-600">{selectedAccount?.displayName||selectedAccount?.name}</p>
    {error&&<p role="alert" className="mt-4 text-red-700">{error}</p>}
    <div className="mt-6 grid gap-4 md:grid-cols-3">{cards.map(c=><Link key={c.href+c.label} href={c.href} className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
      <p className="text-sm text-gray-600">{c.label}</p><p className="my-3 text-3xl font-bold">{c.value??'—'}</p><p className="text-sm leading-6 text-gray-500">{c.note}</p>
    </Link>)}</div>
    <section className="mt-6 rounded-lg border border-gray-200 bg-white p-6">
      <h2 className="text-lg font-semibold">日々の確認</h2>
      {status?.paused&&<p role="alert" className="mt-3 text-red-700">診断の自動返信は休止中です。「診断返信の休止・再開」で状態を確認してください。</p>}
      <p className="mt-3 leading-7">診断のあとにLINE連携すると、結果の画像と解説が自動で届きます。相談や面談希望が届いたら、「個別チャット」で確認してください。面談の日時は店舗スタッフの返信で確定します。</p>
      <p className="mt-3 text-sm text-gray-600">結果12タイプ＋相談4案内：{status?.replies??'—'}件登録 ／ 現在の送信エラー：{status?.currentFailures??'—'}件</p>
      <div className="mt-5 flex flex-wrap gap-3"><Link className="rounded-md bg-gray-900 px-5 py-3 text-white" href="/chats">個別チャットを開く</Link>
      {process.env.NEXT_PUBLIC_DIAGNOSIS_LP_URL&&<a className="rounded-md border border-gray-300 px-5 py-3" target="_blank" rel="noopener noreferrer" href={process.env.NEXT_PUBLIC_DIAGNOSIS_LP_URL}>診断ページでテストする</a>}</div>
    </section>
  </div>
}
