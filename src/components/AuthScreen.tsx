import { useState } from 'react'
import { useAuth } from '@/store/useAuth'
import { Button, Card, Input, Label, Spinner } from '@/components/ui'

type Mode = 'signin' | 'signup' | 'reset'

export function AuthScreen() {
  const { signIn, signUp, sendReset, busy } = useAuth()
  const [mode, setMode] = useState<Mode>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [fullName, setFullName] = useState('')
  const [callsign, setCallsign] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setNotice('')

    if (mode === 'reset') {
      const { error } = await sendReset(email)
      if (error) setError(error)
      else setNotice('Check your email for a reset link.')
      return
    }

    if (mode === 'signup') {
      if (password.length < 8) {
        setError('Use a password of at least 8 characters.')
        return
      }
      const { error, needsConfirmation } = await signUp(
        email,
        password,
        fullName,
        callsign,
      )
      if (error) setError(error)
      else if (needsConfirmation) {
        setNotice('Account created. Check your email to confirm, then sign in.')
        setMode('signin')
      }
      return
    }

    const { error } = await signIn(email, password)
    if (error) setError(error)
  }

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="text-3xl" aria-hidden="true">
            ◈
          </div>
          <h1 className="mt-2 text-xl font-semibold text-slate-50">
            RescueGPS NavMate
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Coordinates, tracking and shared waypoints for SAR teams.
          </p>
        </div>

        <Card>
          <form onSubmit={submit} className="space-y-3">
            {mode === 'signup' && (
              <>
                <div>
                  <Label>Name</Label>
                  <Input
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="Jane Doe"
                    autoComplete="name"
                    required
                  />
                </div>
                <div>
                  <Label>Callsign (optional)</Label>
                  <Input
                    value={callsign}
                    onChange={(e) => setCallsign(e.target.value)}
                    placeholder="Rescue 12"
                  />
                </div>
              </>
            )}

            <div>
              <Label>Email</Label>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                inputMode="email"
                required
              />
            </div>

            {mode !== 'reset' && (
              <div>
                <Label>Password</Label>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={mode === 'signup' ? 'At least 8 characters' : ''}
                  autoComplete={
                    mode === 'signup' ? 'new-password' : 'current-password'
                  }
                  required
                />
              </div>
            )}

            {error && (
              <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">
                {error}
              </p>
            )}
            {notice && (
              <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
                {notice}
              </p>
            )}

            <Button type="submit" variant="primary" className="w-full" disabled={busy}>
              {busy && <Spinner />}
              {mode === 'signin'
                ? 'Sign in'
                : mode === 'signup'
                  ? 'Create account'
                  : 'Send reset link'}
            </Button>
          </form>

          <div className="mt-4 flex flex-wrap justify-center gap-x-4 gap-y-1 text-sm">
            {mode !== 'signin' && (
              <button
                type="button"
                onClick={() => { setMode('signin'); setError(''); setNotice('') }}
                className="text-sky-400 hover:underline"
              >
                Sign in
              </button>
            )}
            {mode !== 'signup' && (
              <button
                type="button"
                onClick={() => { setMode('signup'); setError(''); setNotice('') }}
                className="text-sky-400 hover:underline"
              >
                Create an account
              </button>
            )}
            {mode !== 'reset' && (
              <button
                type="button"
                onClick={() => { setMode('reset'); setError(''); setNotice('') }}
                className="text-slate-400 hover:underline"
              >
                Forgot password
              </button>
            )}
          </div>
        </Card>

        <p className="mt-4 text-center text-xs text-slate-500">
          Location access requires HTTPS. Your waypoints are private to your
          account unless you share them with a team.
        </p>
      </div>
    </div>
  )
}
