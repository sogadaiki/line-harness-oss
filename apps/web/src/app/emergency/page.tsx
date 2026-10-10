'use client'

import { useState, useEffect, useRef } from 'react'
import { api } from '@/lib/api'
import Header from '@/components/layout/header'
import CcPromptButton from '@/components/cc-prompt-button'
import { useAccount } from '@/contexts/account-context'
import DiagnosisEmergency from '@/components/diagnosis-emergency'

type ActionStatus = 'idle' | 'confirming' | 'executing' | 'done' | 'error'

interface EmergencyAction {
  id: string
  label: string
  description: string
  status: ActionStatus
  errorMessage?: string
  resultMessage?: string
}

const emergencyPrompts = [
  {
    title: '緊急停止の確認手順',
    prompt: `画面で選択したLINEのIDと名前を照合し、他のLINEに影響しない停止手順を説明してください。停止はこの画面の対象確認と実行ボタンで行います。すでにLINE APIへ渡した送信は取消できません。`,
  },
  {
    title: 'アカウント移行の確認手順',
    prompt: `LINE CRM のアカウント移行の確認手順を説明してください。移行実行は別途承認が必要です。
1. /health ページで現在のアカウント状態を確認
2. BAN リスクが高いアカウントを特定
3. 移行先アカウントを選択して移行を実行
各ステップの結果を報告してください。`,
  },
]

export default function EmergencyPage() {
  return process.env.NEXT_PUBLIC_DIAGNOSIS_ONLY==='true'?<DiagnosisEmergency/>:<FullEmergencyPage/>
}
function FullEmergencyPage() {
  const {selectedAccountId, selectedAccount} = useAccount()
  const currentAccount = useRef(selectedAccountId)
  currentAccount.current = selectedAccountId
  const [actions, setActions] = useState<EmergencyAction[]>([
    {
      id: 'stop-broadcasts',
      label: '予約一斉配信を停止',
      description: '選択アカウントの予約と残りの一斉配信を下書きへ戻します',
      status: 'idle',
    },
    {
      id: 'stop-scenarios',
      label: 'シナリオ一括停止',
      description: '選択アカウントのシナリオと登録済みの個人配信を停止します',
      status: 'idle',
    },
    {
      id: 'stop-automation',
      label: '自動送信を停止',
      description: '選択アカウントの予約・シナリオ・自動応答・自動化・リマインダ・送信Webhookを停止します',
      status: 'idle',
    },
    {
      id: 'switch-account',
      label: 'アカウント切替',
      description: 'BAN検知時のアカウント移行ページへ移動します',
      status: 'idle',
    },
  ])
  useEffect(() => {setActions(prev=>prev.map(a=>({...a,status:'idle',errorMessage:undefined,resultMessage:undefined})))},[selectedAccountId])

  const updateAction = (id: string, updates: Partial<EmergencyAction>) => {
    setActions((prev) =>
      prev.map((a) => (a.id === id ? { ...a, ...updates } : a))
    )
  }

  const handleAction = async (id: string) => {
    if (!selectedAccountId) return
    const action = actions.find((a) => a.id === id)
    if (!action) return

    if (action.status === 'idle' || action.status === 'done' || action.status === 'error') {
      updateAction(id, { status: 'confirming', errorMessage: undefined, resultMessage: undefined })
      return
    }

    if (action.status === 'confirming') {
      updateAction(id, { status: 'executing' })

      try {
        if (id === 'switch-account') {
          window.location.href = '/health'
          return
        }
        const result=await api.stop(id==='stop-broadcasts'?'broadcasts':id==='stop-scenarios'?'scenarios':'all-automation')
        if (currentAccount.current !== selectedAccountId) return
        if (!result.success || result.data.accountId !== selectedAccountId) throw new Error('停止対象または結果の確認に失敗しました')
        updateAction(id, { status: 'done',resultMessage:`${selectedAccount?.name ?? selectedAccountId}：停止後の残存件数を確認しました（更新 ${result.data.changed} 件）` })
      } catch (error) {
        if (currentAccount.current !== selectedAccountId) return
        updateAction(id, { status: 'error', errorMessage: error instanceof Error ? error.message : '停止結果を確認できませんでした。対象LINEと残存配信を確認してください。' })
      }
    }
  }

  const handleCancel = (id: string) => {
    updateAction(id, { status: 'idle', errorMessage: undefined, resultMessage: undefined })
  }

  const getStatusBadge = (status: ActionStatus) => {
    switch (status) {
      case 'done':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            完了
          </span>
        )
      case 'executing':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-700">
            実行中...
          </span>
        )
      case 'error':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">
            エラー
          </span>
        )
      default:
        return null
    }
  }

  return (
    <div>
      <Header title="緊急コントロール" />
      <p className="mb-4 text-sm font-semibold">停止対象：{selectedAccount?.name ?? 'アカウントを選択してください'}</p>

      {/* Warning banner */}
      <div className="mb-6 p-4 bg-red-50 border-2 border-red-300 rounded-lg">
        <div className="flex items-start gap-3">
          <svg className="w-6 h-6 text-red-500 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.072 16.5c-.77.833.192 2.5 1.732 2.5z" />
          </svg>
          <div>
            <p className="text-sm font-bold text-red-800">注意: この操作は即時実行されます</p>
            <p className="text-xs text-red-600 mt-1">
              各ボタンをクリックすると確認ダイアログが表示されます。「実行」で操作が開始されます。
              既にLINEへ送信したメッセージや、LINE APIで処理中の送信は取り消せません。有人チャット返信は別の操作です。
            </p>
          </div>
        </div>
      </div>

      {/* Action cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
        {actions.map((action) => (
          <div
            key={action.id}
            className="bg-white rounded-lg shadow-sm border-2 border-red-200 p-5 flex flex-col"
          >
            <div className="flex items-start justify-between mb-2">
              <h3 className="text-sm font-bold text-gray-900">{action.label}</h3>
              {getStatusBadge(action.status)}
            </div>
            <p className="text-xs text-gray-500 mb-4 flex-1">{action.description}</p>

            {action.errorMessage && (
              <p className="text-xs text-red-600 mb-3">{action.errorMessage}</p>
            )}
            {action.resultMessage && <p className="text-xs text-green-700 mb-3">{action.resultMessage}</p>}

            {action.status === 'confirming' ? (
              <div className="space-y-2">
                <p className="text-xs font-medium text-red-700">「{selectedAccount?.name}」で「{action.label}」を実行しますか？</p>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleAction(action.id)}
                    className="flex-1 px-3 py-2 min-h-[44px] text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors"
                  >
                    実行
                  </button>
                  <button
                    onClick={() => handleCancel(action.id)}
                    className="flex-1 px-3 py-2 min-h-[44px] text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
                  >
                    キャンセル
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => handleAction(action.id)}
                disabled={!selectedAccountId || action.status === 'executing'}
                className="w-full px-3 py-2 min-h-[44px] text-sm font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 rounded-lg transition-colors"
              >
                {action.status === 'executing' ? '実行中...' : action.label}
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Current status section */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h2 className="text-sm font-semibold text-gray-800 mb-3">現在のステータス</h2>
        <div className="space-y-2">
          {actions.map((action) => (
            <div key={action.id} className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
              <span className="text-sm text-gray-600">{action.label}</span>
              <span className={`text-xs font-medium ${
                action.status === 'done'
                  ? 'text-green-600'
                  : action.status === 'error'
                  ? 'text-red-600'
                  : action.status === 'executing'
                  ? 'text-yellow-600'
                  : 'text-gray-400'
              }`}>
                {action.status === 'idle' && '未実行'}
                {action.status === 'confirming' && '確認待ち'}
                {action.status === 'executing' && '実行中'}
                {action.status === 'done' && '実行済み'}
                {action.status === 'error' && 'エラー'}
              </span>
            </div>
          ))}
        </div>
      </div>

      <CcPromptButton prompts={emergencyPrompts} />
    </div>
  )
}
