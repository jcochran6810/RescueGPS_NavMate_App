/**
 * The Android app (Capacitor) runs the same build as the website, but from
 * `https://localhost` inside the phone. Two things follow, and this file is
 * where both are answered:
 *
 * - **The app's public address.** Email links (sign-up, password reset), team
 *   invite links and the `/api/enc` chart relay all need the real site, not
 *   `localhost`. On the web it is wherever the page came from — NavMate still
 *   hardcodes no hostname there. Only the native app, which has no address of
 *   its own, falls back to `VITE_PUBLIC_ORIGIN` (default: the live site).
 * - **Background GPS.** A browser stops a page's geolocation when the screen
 *   locks. The native app uses a foreground service (a "NavMate is using your
 *   location" notification) so the track keeps recording.
 */
import { Capacitor, registerPlugin } from '@capacitor/core'
import type { BackgroundGeolocationPlugin } from '@capacitor-community/background-geolocation'

export const PUBLIC_ORIGIN: string =
  (import.meta.env.VITE_PUBLIC_ORIGIN as string | undefined) ??
  'https://navmate.stationinsight.com'

export function isNativeApp(): boolean {
  try {
    return Capacitor.isNativePlatform()
  } catch {
    return false
  }
}

/** Where links that leave the phone should point. */
export function appOrigin(): string {
  if (isNativeApp()) return PUBLIC_ORIGIN
  return typeof window !== 'undefined' ? window.location.origin : PUBLIC_ORIGIN
}

const BackgroundGeolocation =
  registerPlugin<BackgroundGeolocationPlugin>('BackgroundGeolocation')

/**
 * Watch the position through the native foreground service. Delivers
 * browser-shaped positions so the tracker's filter cannot tell the difference.
 * Returns a function that stops the watch.
 */
export function watchNativePosition(
  onPosition: (pos: GeolocationPosition) => void,
  onError: (message: string) => void,
): () => void {
  let id: string | null = null
  let stopped = false

  void BackgroundGeolocation.addWatcher(
    {
      backgroundTitle: 'NavMate is tracking your position',
      backgroundMessage: 'Your track keeps recording with the screen off.',
      requestPermissions: true,
      stale: false,
      distanceFilter: 0,
    },
    (loc, err) => {
      if (err) {
        if (err.code === 'NOT_AUTHORIZED') {
          onError(
            'Location permission denied. Allow NavMate to use your location in Settings.',
          )
          if (
            window.confirm(
              'NavMate needs your location to track. Open Settings to allow it?',
            )
          ) {
            void BackgroundGeolocation.openSettings()
          }
        } else {
          onError(err.message || 'Location error')
        }
        return
      }
      if (!loc) return
      onPosition({
        coords: {
          latitude: loc.latitude,
          longitude: loc.longitude,
          accuracy: loc.accuracy,
          altitude: loc.altitude,
          altitudeAccuracy: loc.altitudeAccuracy,
          heading: loc.bearing,
          speed: loc.speed,
        },
        timestamp: loc.time ?? Date.now(),
      } as GeolocationPosition)
    },
  ).then((watcherId) => {
    if (stopped) void BackgroundGeolocation.removeWatcher({ id: watcherId })
    else id = watcherId
  }, (e: unknown) => onError(e instanceof Error ? e.message : 'Location error'))

  return () => {
    stopped = true
    if (id) void BackgroundGeolocation.removeWatcher({ id })
    id = null
  }
}
