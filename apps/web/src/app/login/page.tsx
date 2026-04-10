'use client'
import { Suspense, useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8787'

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen" style={{ backgroundColor: '#06C755' }} />}>
      <LoginPageInner />
    </Suspense>
  )
}

function LoginPageInner() {
  const [apiKey, setApiKey] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [showApiKeyForm, setShowApiKeyForm] = useState(false)
  const router = useRouter()
  const searchParams = useSearchParams()

  // Handle LINE Login callback redirect params
  useEffect(() => {
    const authStatus = searchParams.get('auth')
    if (authStatus === 'success') {
      const name = searchParams.get('name')
      const role = searchParams.get('role')
      if (name) localStorage.setItem('lh_staff_name', name)
      if (role) localStorage.setItem('lh_staff_role', role)
      const permissions = searchParams.get('permissions')
      if (permissions) localStorage.setItem('lh_permissions', permissions)

      // iOS Safari fallback: extract JWT from URL hash fragment.
      // The worker callback appends #token=<jwt> so we can store it in
      // localStorage and send it as a Bearer token (cross-origin cookies
      // are blocked by Safari ITP for cross-site fetch).
      // Hash fragments are never sent to servers, so logs/referrers stay clean.
      if (typeof window !== 'undefined' && window.location.hash) {
        const hashParams = new URLSearchParams(window.location.hash.slice(1))
        const token = hashParams.get('token')
        if (token) {
          localStorage.setItem('lh_session_jwt', token)
          // Strip the token from the URL bar immediately (defense in depth)
          history.replaceState(null, '', window.location.pathname + window.location.search)
        }
      }

      // Mark as session-authenticated (no API key needed)
      localStorage.setItem('lh_auth_type', 'session')
      router.replace('/')
    }
  }, [searchParams, router])

  const handleLineLogin = () => {
    window.location.href = `${API_URL}/auth/staff/line`
  }

  const handleApiKeyLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')

    try {
      const res = await fetch(`${API_URL}/api/friends/count`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      })

      if (res.ok) {
        localStorage.setItem('lh_api_key', apiKey)
        localStorage.setItem('lh_auth_type', 'apikey')
        // Fetch staff profile for name/role display
        try {
          const profileRes = await fetch(`${API_URL}/api/staff/me`, {
            headers: { Authorization: `Bearer ${apiKey}` },
          })
          if (profileRes.ok) {
            const profileData = await profileRes.json() as { success: boolean; data?: { name: string; role: string } }
            if (profileData.success && profileData.data) {
              localStorage.setItem('lh_staff_name', profileData.data.name)
              localStorage.setItem('lh_staff_role', profileData.data.role)
            }
          }
        } catch {
          // Profile fetch is best-effort
        }
        router.push('/')
      } else {
        setError('APIキーが正しくありません')
      }
    } catch {
      setError('接続に失敗しました')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: '#06C755' }}>
      <div className="bg-white rounded-2xl shadow-xl p-8 w-full max-w-sm">
        <div className="text-center mb-6">
          <div className="w-12 h-12 rounded-xl flex items-center justify-center text-white font-bold text-lg mx-auto mb-3" style={{ backgroundColor: '#06C755' }}>
            H
          </div>
          <h1 className="text-xl font-bold text-gray-900">LINE Harness</h1>
          <p className="text-sm text-gray-500 mt-1">管理画面にログイン</p>
        </div>

        {/* LINE Login button */}
        <button
          onClick={handleLineLogin}
          className="w-full py-3.5 text-white font-bold rounded-lg transition-opacity hover:opacity-90 flex items-center justify-center gap-2 text-base"
          style={{ backgroundColor: '#06C755' }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19.365 9.863c.349 0 .63.285.63.631 0 .345-.281.63-.63.63H17.61v1.125h1.755c.349 0 .63.283.63.63 0 .344-.281.629-.63.629h-2.386c-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.63-.63h2.386c.346 0 .627.285.627.63 0 .349-.281.63-.63.63H17.61v1.125h1.755zm-3.855 3.016c0 .27-.174.51-.432.596-.064.021-.133.031-.199.031-.211 0-.391-.09-.51-.25l-2.443-3.317v2.94c0 .344-.279.629-.631.629-.346 0-.626-.285-.626-.629V8.108c0-.27.173-.51.43-.595.06-.023.136-.033.194-.033.195 0 .375.104.495.254l2.462 3.33V8.108c0-.345.282-.63.63-.63.345 0 .63.285.63.63v4.771zm-5.741 0c0 .344-.282.629-.631.629-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.63-.63.346 0 .628.285.628.63v4.771zm-2.466.629H4.917c-.345 0-.63-.285-.63-.629V8.108c0-.345.285-.63.63-.63.348 0 .63.285.63.63v4.141h1.756c.348 0 .629.283.629.63 0 .344-.282.629-.629.629M24 10.314C24 4.943 18.615.572 12 .572S0 4.943 0 10.314c0 4.811 4.27 8.842 10.035 9.608.391.082.923.258 1.058.59.12.301.079.766.038 1.08l-.164 1.02c-.045.301-.24 1.186 1.049.645 1.291-.539 6.916-4.078 9.436-6.975C23.176 14.393 24 12.458 24 10.314" />
          </svg>
          LINEでログイン
        </button>

        {/* API Key login toggle */}
        {!showApiKeyForm ? (
          <button
            onClick={() => setShowApiKeyForm(true)}
            className="w-full mt-4 text-sm text-gray-400 hover:text-gray-600 transition-colors"
          >
            APIキーでログイン
          </button>
        ) : (
          <form onSubmit={handleApiKeyLogin} className="mt-4">
            <div className="border-t border-gray-200 pt-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">API Key</label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="APIキーを入力"
                className="w-full px-4 py-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                autoFocus
              />
            </div>

            {error && (
              <p className="text-sm text-red-600 mt-2">{error}</p>
            )}

            <button
              type="submit"
              disabled={loading || !apiKey}
              className="w-full mt-3 py-2.5 text-gray-700 font-medium rounded-lg transition-opacity hover:opacity-90 disabled:opacity-50 border border-gray-300 text-sm"
            >
              {loading ? 'ログイン中...' : 'APIキーでログイン'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
