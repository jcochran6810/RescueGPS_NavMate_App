import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import {
  headingFromOrientation,
  headingWander,
  HeadingSmoother,
  type HoldMode,
} from '@/lib/heading'
import { declinationAt, modelValidity, trueFromMagnetic } from '@/lib/geomag'

/**
 * Which way the device is pointing, in degrees a crew can act on.
 *
 * Three things this store does that a bare `deviceorientation` listener does
 * not, and each of them is the difference between a decoration and an
 * instrument:
 *
 *   - it reads the sensor through `heading.ts`, so the number survives the
 *     phone being tilted or turned on its side;
 *   - it corrects to **true** north through the magnetic model, because every
 *     other bearing in this app is true and two conventions on one screen is
 *     how a crew ends up 15° off;
 *   - it says how much to trust the reading — a magnetometer near a radio, an
 *     engine block or a steel wheelhouse is wrong by tens of degrees and the
 *     only warning is that the numbers scatter.
 *
 * The GPS-course fallback lives in the compass card rather than here, because
 * it is a different measurement answering a different question: course over
 * ground is where the boat is going, not where the phone is aimed.
 */

export type HeadingPermission = 'unknown' | 'granted' | 'denied' | 'unsupported'

/** What the user asked the dial to show. */
export type HeadingReference = 'true' | 'magnetic'

/**
 * How much the reading can be trusted.
 *
 * `poor` means the magnetometer needs the figure-of-eight, or the phone is
 * sitting next to something ferrous. Either way the bearing is not usable.
 */
export type Calibration = 'unknown' | 'good' | 'fair' | 'poor'

/** Which event the reading came from — they are not equally trustworthy. */
export type HeadingSensor = 'ios' | 'absolute'

export interface HeadingState {
  /** Degrees from magnetic north, 0–360, smoothed. */
  magnetic: number | null
  /** Degrees from true north, once a position is known. */
  trueHeading: number | null
  /** Whichever of the two the dial should show; null with no reading. */
  heading: number | null
  /** What `heading` actually is, which is not always what was asked for. */
  shownReference: HeadingReference
  /** What the crew asked for. Persisted. */
  reference: HeadingReference

  /** Degrees east of true north, from the model, or null with no position. */
  declination: number | null
  /** True when the model is outside its five-year window. */
  declinationStale: boolean

  /** How the device is being held, and how far off level it is. */
  mode: HoldMode | null
  tilt: number | null
  level: { x: number; y: number } | null

  calibration: Calibration
  /** iOS reports its own figure, in degrees. Nothing else does. */
  accuracyDeg: number | null
  sensor: HeadingSensor | null

  permission: HeadingPermission
  listening: boolean
  /**
   * True once the sensor has been running a moment with nothing to show for
   * it — a device with no magnetometer, which is most laptops and some cheap
   * phones. Without this the card would sit on "waiting" forever.
   */
  silent: boolean

  enable: () => Promise<void>
  disable: () => void
  setReference: (r: HeadingReference) => void
  /** Where the device is, so declination can be worked out. Metres for alt. */
  setPosition: (lat: number, lon: number, altM?: number | null) => void
}

/**
 * Does this platform require a tap before it will hand over the sensor?
 *
 * iOS 13+ gates `DeviceOrientationEvent` behind `requestPermission()`, and
 * that call is only honoured from a real user gesture — calling it on mount
 * is rejected. Everywhere else the sensor just starts, so a button there is a
 * step asked of a crew for nothing.
 *
 * Checked as "does the gate exist" rather than by sniffing for iOS: the gate
 * is the thing that matters, and a user agent string is a guess about it.
 */
export function headingNeedsTap(): boolean {
  if (typeof window === 'undefined' || !('DeviceOrientationEvent' in window)) {
    return false
  }
  const ctor = window.DeviceOrientationEvent as typeof DeviceOrientationEvent & {
    requestPermission?: () => Promise<'granted' | 'denied'>
  }
  return typeof ctor.requestPermission === 'function'
}

/** Samples per second passed on to React. The sensor fires far faster. */
const UPDATE_HZ = 12
const MIN_INTERVAL_MS = 1000 / UPDATE_HZ

/** How long to wait for a first reading before calling the device silent. */
const SILENT_AFTER_MS = 2500

/**
 * Recomputing declination is a 12th-degree spherical harmonic expansion. It
 * changes by a degree over roughly 100 km, so a fix that has moved less than
 * this does not need a new one.
 */
const DECLINATION_REFRESH_KM = 25

const smoother = new HeadingSmoother()
let lastEmit = 0
let handler: ((e: DeviceOrientationEvent) => void) | null = null
let listeningTo: string[] = []
let silentTimer: ReturnType<typeof setTimeout> | null = null
let declinationAt_: { lat: number; lon: number } | null = null

/** Recent raw readings, for the steadiness test below. */
let recent: { deg: number; t: number }[] = []
const STEADINESS_WINDOW_MS = 1200

/** Kilometres between two positions, near enough for a refresh test. */
function roughKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = (bLat - aLat) * 111
  const dLon = (bLon - aLon) * 111 * Math.cos((aLat * Math.PI) / 180)
  return Math.hypot(dLat, dLon)
}

interface CompassEvent extends DeviceOrientationEvent {
  /** Safari only: heading relative to magnetic north, already compensated. */
  webkitCompassHeading?: number
  /** Safari only: its own error estimate in degrees; negative means unusable. */
  webkitCompassAccuracy?: number
}

/** Whichever way round the page currently is. */
function screenAngle(): number {
  const angle = window.screen?.orientation?.angle
  return typeof angle === 'number' ? angle : 0
}

export const useHeading = create<HeadingState>()(
  persist(
    (set, get) => ({
      magnetic: null,
      trueHeading: null,
      heading: null,
      shownReference: 'magnetic',
      reference: 'true',
      declination: null,
      declinationStale: false,
      mode: null,
      tilt: null,
      level: null,
      calibration: 'unknown',
      accuracyDeg: null,
      sensor: null,
      permission: 'unknown',
      listening: false,
      silent: false,

      setReference: (reference) => {
        const { magnetic, declination } = get()
        set({ reference, ...project(magnetic, declination, reference) })
      },

      setPosition: (lat, lon, altM) => {
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return
        const had = declinationAt_
        if (had && roughKm(had.lat, had.lon, lat, lon) < DECLINATION_REFRESH_KM) return
        declinationAt_ = { lat, lon }
        const declination = declinationAt(lat, lon, altM ?? 0)
        if (!Number.isFinite(declination)) return
        const { magnetic, reference } = get()
        set({
          declination,
          declinationStale: modelValidity() !== 'valid',
          ...project(magnetic, declination, reference),
        })
      },

      enable: async () => {
        if (get().listening) return

        if (typeof window === 'undefined' || !('DeviceOrientationEvent' in window)) {
          set({ permission: 'unsupported' })
          return
        }

        // iOS 13+ gates the sensor behind an explicit grant, and the request
        // has to come from a real tap.
        const ctor = window.DeviceOrientationEvent as typeof DeviceOrientationEvent & {
          requestPermission?: () => Promise<'granted' | 'denied'>
        }
        if (typeof ctor.requestPermission === 'function') {
          try {
            const result = await ctor.requestPermission()
            if (result !== 'granted') {
              set({ permission: 'denied' })
              return
            }
          } catch {
            set({ permission: 'denied' })
            return
          }
        }

        smoother.reset()
        recent = []

        handler = (raw) => {
          const e = raw as CompassEvent
          const now = Date.now()

          let magneticDeg: number | null = null
          let sensor: HeadingSensor | null = null
          let mode: HoldMode | null = null
          let tilt: number | null = null
          let level: { x: number; y: number } | null = null
          let accuracyDeg: number | null = null

          if (
            typeof e.webkitCompassHeading === 'number' &&
            Number.isFinite(e.webkitCompassHeading)
          ) {
            // Core Motion has already done the tilt compensation and the screen
            // rotation, and does both with a gyroscope this code cannot reach,
            // so its number is taken as given. Apple documents it as relative
            // to MAGNETIC north — it was once labelled true here, which
            // suppressed the declination warning on the one platform that
            // needed it.
            magneticDeg = e.webkitCompassHeading
            sensor = 'ios'
            accuracyDeg =
              typeof e.webkitCompassAccuracy === 'number'
                ? e.webkitCompassAccuracy
                : null
            // The attitude is still wanted, for the level and the hold, but it
            // must not be allowed to override Apple's heading.
            const attitude = headingFromOrientation(
              e.alpha,
              e.beta,
              e.gamma,
              screenAngle(),
            )
            if (attitude) {
              mode = attitude.mode
              tilt = attitude.tilt
              level = attitude.level
            }
          } else if (e.absolute) {
            // Everything else: Earth-referenced Euler angles, which are only a
            // heading after the work in `heading.ts`.
            const attitude = headingFromOrientation(
              e.alpha,
              e.beta,
              e.gamma,
              screenAngle(),
            )
            // A vanishing horizontal projection is a direction made of rounding
            // error. Better to hold the last good reading than to print it.
            if (!attitude || attitude.confidence < 0.03) return
            magneticDeg = attitude.heading
            sensor = 'absolute'
            mode = attitude.mode
            tilt = attitude.tilt
            level = attitude.level
          } else {
            // A relative reading is referenced to wherever the device happened
            // to be pointing when it started, so it is not a compass at all.
            return
          }

          if (silentTimer) {
            clearTimeout(silentTimer)
            silentTimer = null
          }

          recent.push({ deg: magneticDeg, t: now })
          const smoothed = smoother.update(magneticDeg, now)

          if (now - lastEmit < MIN_INTERVAL_MS) return
          lastEmit = now

          recent = recent.filter((r) => now - r.t < STEADINESS_WINDOW_MS)
          const wander = headingWander(recent)
          const calibration: Calibration =
            accuracyDeg != null
              ? accuracyDeg < 0
                ? 'poor'
                : accuracyDeg <= 15
                  ? 'good'
                  : accuracyDeg <= 30
                    ? 'fair'
                    : 'poor'
              : wander == null
                ? get().calibration
                : wander > 8
                  ? 'poor'
                  : wander > 4
                    ? 'fair'
                    : 'good'

          const { declination, reference } = get()
          set({
            silent: false,
            sensor,
            mode,
            tilt,
            level,
            accuracyDeg,
            calibration,
            ...project(smoothed, declination, reference),
          })
        }

        // Chrome exposes the Earth-referenced reading under its own event name
        // and leaves `absolute` false on the plain one; Safari does the
        // opposite and carries its heading on the plain one.
        listeningTo =
          'ondeviceorientationabsolute' in window
            ? ['deviceorientationabsolute', 'deviceorientation']
            : ['deviceorientation']
        for (const name of listeningTo) {
          window.addEventListener(name, handler as EventListener)
        }

        silentTimer = setTimeout(() => set({ silent: true }), SILENT_AFTER_MS)

        set({ permission: 'granted', listening: true, silent: false })
      },

      disable: () => {
        if (handler) {
          for (const name of listeningTo) {
            window.removeEventListener(name, handler as EventListener)
          }
          handler = null
          listeningTo = []
        }
        if (silentTimer) {
          clearTimeout(silentTimer)
          silentTimer = null
        }
        smoother.reset()
        recent = []
        set({
          listening: false,
          silent: false,
          magnetic: null,
          trueHeading: null,
          heading: null,
          mode: null,
          tilt: null,
          level: null,
          sensor: null,
          accuracyDeg: null,
          calibration: 'unknown',
        })
      },
    }),
    {
      name: 'navmate.heading',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      // Only the preference survives a reload. A heading is a live reading and
      // a stale one restored from disk would be a lie the moment it appeared.
      partialize: (s) => ({ reference: s.reference }),
    },
  ),
)

/**
 * Work out the three headings the UI reads from one magnetic reading.
 *
 * True north is only offered when the model has actually been given a
 * position: a dial labelled "true" that is quietly still magnetic is worse
 * than one labelled magnetic, because the label is what a crew trusts.
 */
function project(
  magnetic: number | null,
  declination: number | null,
  reference: HeadingReference,
): Pick<HeadingState, 'magnetic' | 'trueHeading' | 'heading' | 'shownReference'> {
  if (magnetic === null) {
    return {
      magnetic: null,
      trueHeading: null,
      heading: null,
      shownReference: reference === 'true' && declination !== null ? 'true' : 'magnetic',
    }
  }
  const trueHeading =
    declination === null ? null : trueFromMagnetic(magnetic, declination)
  const useTrue = reference === 'true' && trueHeading !== null
  return {
    magnetic,
    trueHeading,
    heading: useTrue ? trueHeading : magnetic,
    shownReference: useTrue ? 'true' : 'magnetic',
  }
}
