import { useState } from 'react'
import { Button } from '@/components/ui'
import { toast } from '@/store/useToast'

/**
 * Handing the join code to somebody.
 *
 * The code has always been on this screen; what was missing is every way a
 * crew actually passes one on. Reading six characters over a radio works and
 * is the fallback, but the person joining is usually holding a phone, and the
 * fastest route is a link they can tap.
 *
 * **The link carries the code**, and the app reads it on open and offers to
 * join. That is the whole trick: `?join=ABC123` turns a six-character code
 * into one tap, and it still cannot let anyone in who does not have the code,
 * because the code *is* the link.
 *
 * **It hands off to the phone's own apps rather than sending anything.**
 * NavMate has no server to send mail from and no business holding anyone's
 * contacts, so Message opens the messages app and Email opens the mail app,
 * both pre-filled, and the crew presses send. Where the phone offers the Web
 * Share API — which is most of them — one button covers every app they have.
 */
export function TeamInvite({
  teamName,
  joinCode,
}: {
  teamName: string
  joinCode: string
}) {
  const [open, setOpen] = useState(false)

  const url = `${window.location.origin}/?join=${encodeURIComponent(joinCode)}`
  const subject = `Join ${teamName} on NavMate`
  const body =
    `Join ${teamName} on NavMate.\n\n` +
    `Open this link: ${url}\n\n` +
    `Or open NavMate, go to Team, and enter the code: ${joinCode}`

  const canShare = typeof navigator !== 'undefined' && 'share' in navigator

  async function copy() {
    try {
      await navigator.clipboard.writeText(url)
      toast('Invite link copied', 'success')
    } catch {
      // A clipboard needs a secure context and a permission. Showing the link
      // is not as good, but it is better than a button that did nothing.
      toast(url)
    }
  }

  return (
    <div className="mt-2">
      <Button
        variant="ghost"
        className="w-full"
        onClick={async () => {
          await copy()
          if (canShare) {
            try {
              await navigator.share({ title: subject, text: body, url })
              return
            } catch {
              // Dismissed the share sheet, or it is not available after all.
              // The link is already copied, so there is nothing to recover.
            }
          }
          setOpen(true)
        }}
      >
        Invite teammates
      </Button>

      {open && (
        <div className="mt-2 grid grid-cols-2 gap-2">
          <a
            href={`sms:?&body=${encodeURIComponent(body)}`}
            className="flex min-h-11 items-center justify-center rounded-xl border border-white/10 px-3 text-sm font-semibold text-slate-100 hover:bg-white/5"
          >
            Text it
          </a>
          <a
            href={`mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`}
            className="flex min-h-11 items-center justify-center rounded-xl border border-white/10 px-3 text-sm font-semibold text-slate-100 hover:bg-white/5"
          >
            Email it
          </a>
          <p className="col-span-2 text-xs text-slate-400">
            The link is on your clipboard. Text and Email open your own apps
            with it already written — nothing is sent from here.
          </p>
        </div>
      )}
    </div>
  )
}
