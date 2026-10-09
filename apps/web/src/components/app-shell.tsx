'use client'
import { usePathname } from 'next/navigation'
import Sidebar from './layout/sidebar'
import AuthGuard from './auth-guard'
import { AccountProvider, useAccount } from '@/contexts/account-context'

function AccountContent({children}: {children:React.ReactNode}) {
  const {selectedAccountId, loading} = useAccount()
  if (loading) return <p>LINEアカウントを読み込み中...</p>
  // Drop stale lists, editor drafts and confirmations when the account changes.
  return <div key={selectedAccountId ?? 'no-account'}>{children}</div>
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  if (pathname === '/login') {
    return <>{children}</>
  }

  return (
    <AuthGuard>
      <AccountProvider>
        <div className="flex min-h-screen">
          <Sidebar />
          <main className="flex-1 pt-[72px] px-4 pb-6 sm:px-6 lg:pt-8 lg:px-8 lg:pb-8 overflow-auto">
            <AccountContent>{children}</AccountContent>
          </main>
        </div>
      </AccountProvider>
    </AuthGuard>
  )
}
