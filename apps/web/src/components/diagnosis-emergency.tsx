'use client'
import {useEffect,useState} from 'react'
import {fetchApi} from '@/lib/api'
import {useAccount} from '@/contexts/account-context'

export default function DiagnosisEmergency(){
  const {selectedAccountId,selectedAccount}=useAccount()
  const [paused,setPaused]=useState<boolean|null>(null)
  const [confirm,setConfirm]=useState(false)
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  useEffect(()=>{let active=true;setPaused(null);setConfirm(false);setError('')
    fetchApi<{data:{paused:boolean}}>('/api/diagnosis/status').then(r=>{if(active)setPaused(r.data.paused)}).catch(()=>{if(active)setError('状態を読み込めませんでした。画面を更新してください。')})
    return ()=>{active=false}
  },[selectedAccountId])
  async function execute(){
    if(paused===null||busy)return
    setBusy(true);setError('')
    try{
      const r=await fetchApi<{data:{accountId:string;paused:boolean}}>(`/api/diagnosis/${paused?'resume':'pause'}`,{method:'POST'})
      if(r.data.accountId!==selectedAccountId||r.data.paused===paused)throw Error('対象と状態を確認できませんでした')
      setPaused(r.data.paused);setConfirm(false)
    }catch(e){setError(e instanceof Error?e.message:'操作を完了できませんでした')}
    finally{setBusy(false)}
  }
  return <div className="max-w-2xl">
    <h1 className="text-2xl font-bold">診断返信の休止・再開</h1>
    <p className="mt-3">対象：{selectedAccount?.displayName||selectedAccount?.name}</p>
    <section className="mt-6 rounded-lg border bg-white p-6">
      <h2 className="text-lg font-semibold">自動返信：{paused===null?'確認中':paused?'休止中':'稼働中'}</h2>
      <p className="mt-4 leading-7">休止すると、診断結果の送信とキーワードへの自動返信を止めます。相談トークの受信とスタッフの手動返信は続けられます。</p>
      <p className="mt-3 text-sm leading-6 text-gray-600">すでにLINEへ渡した送信は取り消せません。休止前の未送信結果は取り消され、再開しても自動送信しません。再開後は診断ページから新しく結果を受け取れます。</p>
      <p className="mt-3 text-sm text-gray-600">操作できるのは管理者・オーナーです。</p>
      {error&&<p role="alert" className="mt-4 text-red-700">{error}</p>}
      {confirm?<div className="mt-5"><p>{paused?'このLINEの自動返信を再開します。':'このLINEの自動返信を休止し、未送信結果を取り消します。'}</p><div className="mt-3 flex gap-3"><button className="rounded bg-red-700 px-5 py-3 text-white" disabled={busy} onClick={execute}>{busy?'処理中…':'実行する'}</button><button className="rounded border px-5 py-3" disabled={busy} onClick={()=>setConfirm(false)}>キャンセル</button></div></div>
      :<button className="mt-5 rounded bg-gray-900 px-5 py-3 text-white disabled:opacity-50" disabled={paused===null||busy} onClick={()=>setConfirm(true)}>{paused?'自動返信を再開':'自動返信を休止'}</button>}
    </section>
  </div>
}
