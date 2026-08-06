import { useState } from 'react'
import { useAuth } from '@/store/useAuth'
import { toast } from '@/store/useToast'
import { Button, Card, Input, Label, Spinner } from '@/components/ui'

/**
 * The other half of "Forgot password".
 *
 * The emailed reset link signs the user in with a recovery session, but that
 * session is temporary — without actually setting a new password here, the
 * user is locked out again the moment it expires. This screen is shown once,
 * straight after arriving through the link.
 */
export function RecoverPassword() {
  const { busy, updatePassword, dismissRecovery } = useAuth()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')

  async function submit() {
    if (password.length < 8) {
      toast('Use at least 8 characters', 'error')
      return
    }
    if (password !== confirm) {
      toast('The two passwords do not match', 'error')
      return
    }
    const { error } = await updatePassword(password)
    if (error) toast(error, 'error')
    else toast('Password updated — you are signed in', 'success')
  }

  return (
    <div className="grid min-h-full place-items-center px-4">
      <Card className="w-full max-w-sm">
        <Label>Set a new password</Label>
        <p className="mb-3 text-sm text-slate-300">
          You arrived here from a password-reset email. Choose a new password
          to finish, or keep the old one if you remember it after all.
        </p>
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="New password"
          autoComplete="new-password"
          aria-label="New password"
        />
        <Input
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="Repeat it"
          autoComplete="new-password"
          aria-label="Repeat the new password"
          className="mt-2"
        />
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button variant="ghost" onClick={dismissRecovery} disabled={busy}>
            Keep current
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy}>
            {busy && <Spinner />}
            Save password
          </Button>
        </div>
      </Card>
    </div>
  )
}
