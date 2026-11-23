/**
 * Putting NavMate on the phone's home screen, without an app store.
 *
 * NavMate installs the way any PWA does — from the browser — so this is about
 * making that step findable. Android/Chrome fires `beforeinstallprompt`, which
 * must be caught *before* React mounts or it is gone; it is held here and
 * replayed when the crew presses Install. iOS Safari has no such event and
 * never will, so there the screen shows the two taps instead.
 */

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

import { isNativeApp } from './native'

export type InstallPlatform = 'installed' | 'prompt' | 'ios' | 'ios-other' | 'manual'

let deferred: InstallPromptEvent | null = null
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((l) => l())

/** Called once from main.tsx, before the app renders. */
export function captureInstallPrompt(win: Window = window): void {
  win.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    deferred = e as InstallPromptEvent
    notify()
  })
  win.addEventListener('appinstalled', () => {
    deferred = null
    notify()
  })
}

export function onInstallChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function hasInstallPrompt(): boolean {
  return deferred !== null
}

/** Shows the browser's own install dialog. True when the crew accepted. */
export async function promptInstall(): Promise<boolean> {
  const e = deferred
  if (!e) return false
  deferred = null
  notify()
  await e.prompt()
  const choice = await e.userChoice
  return choice.outcome === 'accepted'
}

export interface InstallEnv {
  userAgent: string
  standalone: boolean
  hasPrompt: boolean
  maxTouchPoints?: number
}

/** Pure, so it can be tested without a browser. */
export function installPlatform(env: InstallEnv): InstallPlatform {
  if (env.standalone) return 'installed'
  if (env.hasPrompt) return 'prompt'
  const ua = env.userAgent
  // iPadOS reports itself as a Mac; touch points give it away.
  const ios =
    /iPhone|iPad|iPod/.test(ua) ||
    (/Macintosh/.test(ua) && (env.maxTouchPoints ?? 0) > 1)
  if (ios) {
    // Only Safari can add to the home screen on older iOS; other iOS
    // browsers (CriOS, FxiOS, EdgiOS) have to hand over to it.
    return /CriOS|FxiOS|EdgiOS|OPiOS/.test(ua) ? 'ios-other' : 'ios'
  }
  return 'manual'
}

export function currentInstallEnv(): InstallEnv {
  const nav = navigator as Navigator & { standalone?: boolean }
  return {
    userAgent: nav.userAgent,
    // The Android app is installed by definition.
    standalone:
      isNativeApp() ||
      nav.standalone === true ||
      (typeof matchMedia === 'function' &&
        matchMedia('(display-mode: standalone)').matches),
    hasPrompt: hasInstallPrompt(),
    maxTouchPoints: nav.maxTouchPoints,
  }
}
