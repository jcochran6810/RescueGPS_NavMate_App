import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * A panel that rises from the bottom of the screen over everything else.
 *
 * It is portalled to the body rather than rendered where it is declared: the
 * footer both callers live in carries a backdrop blur, and a blurred ancestor
 * becomes the containing block for anything fixed inside it, which would trap
 * the panel in the forty-pixel strip the footer occupies.
 *
 * Dismissing is deliberately one behaviour for all three routes out — the
 * close control, Escape, and a tap on the backdrop — so a caller that commits
 * on dismiss commits whichever way the crew leaves.
 */
export function Sheet({
  label,
  children,
  onDismiss,
}: {
  /** Announced to screen readers as the name of the dialog. */
  label: string
  children: ReactNode
  onDismiss: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss()
    }
    window.addEventListener('keydown', onKey)
    // Stop the page behind from scrolling under the sheet.
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [onDismiss])

  return createPortal(
    <div
      className="fixed inset-0 z-40 flex items-end bg-black/60"
      onClick={onDismiss}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onClick={(e) => e.stopPropagation()}
        className="safe-bottom max-h-[85vh] w-full overflow-y-auto rounded-t-2xl border-t border-white/10 bg-navy-900 px-4 pt-4 shadow-2xl shadow-black/50"
      >
        <div className="mx-auto max-w-3xl">
          <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-white/15" />
          {children}
        </div>
      </div>
    </div>,
    document.body,
  )
}
