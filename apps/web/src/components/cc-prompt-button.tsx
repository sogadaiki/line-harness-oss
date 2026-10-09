'use client'

import { useState } from 'react'
import PromptModal, { type PromptTemplate } from '@/components/prompt-modal'
import { useAccount } from '@/contexts/account-context'

interface CcPromptButtonProps {
  prompts: PromptTemplate[]
}

export default function CcPromptButton({ prompts }: CcPromptButtonProps) {
  const [isOpen, setIsOpen] = useState(false)
  const { selectedAccount } = useAccount()
  const scopedPrompts = prompts.map(p => ({ ...p, prompt: `対象LINE: ${selectedAccount?.name ?? '未選択'}\nline_account_id: ${selectedAccount?.id ?? '未選択'}\nこのLINEだけを対象にしてください。未選択の場合は作業を開始しないでください。他アカウントへの変更・送信は対象外です。\n\n${p.prompt}` }))

  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        className="fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-3 min-h-[48px] bg-gray-900 text-white text-sm font-medium rounded-full shadow-lg hover:bg-gray-800 transition-colors"
        aria-label="CCに依頼"
      >
        <span className="text-base leading-none">📋</span>
        <span className="hidden sm:inline">CCに依頼</span>
      </button>

      <PromptModal
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        prompts={scopedPrompts}
      />
    </>
  )
}
