'use client'
import { useEffect, useState } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'

export default function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [checked, setChecked] = useState(false)

  useEffect(() => {
    if (pathname === '/login') {
      setChecked(true)
      return
    }

    // Handle LINE Login callback params on root path
    const authStatus = searchParams.get('auth')
    if (authStatus === 'success') {
      setChecked(true)
      return
    }

    // Check for API key auth
    const key = localStorage.getItem('lh_api_key')
    // Check for session auth (cookie-based, set via LINE Login)
    const authType = localStorage.getItem('lh_auth_type')

    if (!key && authType !== 'session') {
      router.replace('/login')
    } else {
      setChecked(true)
    }
  }, [pathname, router, searchParams])

  if (!checked) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-[3px] border-gray-200 border-t-green-500 rounded-full" />
      </div>
    )
  }

  return <>{children}</>
}
