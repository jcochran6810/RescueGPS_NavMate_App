import { create } from 'zustand'
import { isNativeApp } from '@/lib/native'
import { ANDROID_RELEASES_URL, fetchLiveVersion, isNewer } from '@/lib/version'

/**
 * "A new version of NavMate is out." One store for both kinds of install:
 *
 * - **Website / home-screen app**: the service worker has already downloaded
 *   the new files and is waiting (`registerType: 'prompt'`); Update now
 *   switches to them and reloads.
 * - **Android app**: the APK carries its files inside it, so the new version
 *   is a new APK. The app compares its own build with the live site's
 *   `/version.json`; Update now opens the download page.
 *
 * "Later" hides the banner until the next new version, or until the app is
 * next opened — whichever comes first. Nothing ever updates by itself:
 * reloading under a crew mid-task loses whatever they were typing.
 */
interface UpdateState {
  available: boolean
  kind: 'web' | 'native' | null
  /** The live build the crew said "Later" to. */
  snoozed: string | null
  liveSha: string | null
  /** Set by main.tsx once the service worker reports a waiting version. */
  applyWeb: (() => Promise<void>) | null
  webReady: (apply: () => Promise<void>) => void
  checkNative: () => Promise<void>
  updateNow: () => void
  later: () => void
}

export const useUpdate = create<UpdateState>()((set, get) => ({
  available: false,
  kind: null,
  snoozed: null,
  liveSha: null,
  applyWeb: null,

  webReady: (apply) => set({ available: true, kind: 'web', applyWeb: apply }),

  checkNative: async () => {
    if (!isNativeApp()) return
    const live = await fetchLiveVersion()
    if (!live || !isNewer(live)) return
    if (get().snoozed === live.sha) return
    set({ available: true, kind: 'native', liveSha: live.sha })
  },

  updateNow: () => {
    const { kind, applyWeb } = get()
    if (kind === 'web' && applyWeb) {
      void applyWeb()
      return
    }
    if (kind === 'native') {
      // An external page: Capacitor hands it to the phone's browser, where
      // the APK downloads and installs over this one.
      window.location.href = ANDROID_RELEASES_URL
      set({ available: false })
    }
  },

  later: () => set({ available: false, snoozed: get().liveSha ?? get().snoozed }),
}))

/** How often to look for a new version while the app stays open. */
export const UPDATE_CHECK_MS = 30 * 60 * 1000
