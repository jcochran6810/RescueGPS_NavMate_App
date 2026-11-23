import { useEffect, useState } from 'react'
import { Download, Share, SquarePlus, X } from 'lucide-react'
import { Button, Card, Label } from '@/components/ui'
import {
  currentInstallEnv,
  installPlatform,
  onInstallChange,
  promptInstall,
} from '@/lib/install'

const DISMISS_KEY = 'navmate.installCard.dismissed'

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * "Install NavMate" — straight onto the phone from the browser, no app store.
 *
 * `dismissible` cards (Home) can be closed for good; the Help copy always
 * shows so the instructions are never lost. Nothing renders once the app is
 * running installed.
 */
export function InstallCard({ dismissible = false }: { dismissible?: boolean }) {
  const [platform, setPlatform] = useState(() => installPlatform(currentInstallEnv()))
  const [dismissed, setDismissed] = useState(() => dismissible && readDismissed())
  const [busy, setBusy] = useState(false)

  useEffect(
    () => onInstallChange(() => setPlatform(installPlatform(currentInstallEnv()))),
    [],
  )

  if (platform === 'installed' || dismissed) return null

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, '1')
    } catch {
      /* private mode: closes for this visit only */
    }
    setDismissed(true)
  }

  return (
    <Card>
      <div className="flex items-start justify-between gap-2">
        <Label>Install NavMate on this phone</Label>
        {dismissible ? (
          <button
            onClick={dismiss}
            aria-label="Hide install card"
            className="-mt-1 -mr-1 flex size-9 items-center justify-center rounded-lg text-slate-400 hover:bg-white/5"
          >
            <X size={16} />
          </button>
        ) : null}
      </div>
      <p className="mb-3 text-sm text-slate-300">
        Downloads straight from this page — no App Store or Play Store. It
        opens full screen from its own icon and works with no signal.
      </p>

      {platform === 'prompt' ? (
        <Button
          variant="primary"
          className="w-full"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              await promptInstall()
            } finally {
              setBusy(false)
              setPlatform(installPlatform(currentInstallEnv()))
            }
          }}
        >
          <Download size={18} /> Install NavMate
        </Button>
      ) : platform === 'ios' ? (
        <ol className="space-y-2 text-sm text-slate-200">
          <li className="flex items-center gap-2">
            <span className="tnum text-slate-400">1.</span> Tap
            <Share size={16} className="text-sky-300" aria-label="Share" />
            <strong>Share</strong> at the bottom of Safari
          </li>
          <li className="flex items-center gap-2">
            <span className="tnum text-slate-400">2.</span> Tap
            <SquarePlus size={16} className="text-sky-300" aria-hidden />
            <strong>Add to Home Screen</strong>, then <strong>Add</strong>
          </li>
        </ol>
      ) : platform === 'ios-other' ? (
        <p className="text-sm text-slate-200">
          Open <strong>{location.host}</strong> in <strong>Safari</strong>,
          then tap <Share size={14} className="inline text-sky-300" aria-label="Share" />{' '}
          Share → <strong>Add to Home Screen</strong>.
        </p>
      ) : (
        <p className="text-sm text-slate-200">
          Open your browser&rsquo;s menu (<strong>⋮</strong>) and choose{' '}
          <strong>Install app</strong> or <strong>Add to Home screen</strong>.
        </p>
      )}
    </Card>
  )
}
