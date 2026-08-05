import { create } from 'zustand'

/**
 * Which way the device is pointing.
 *
 * Two sources, and they answer slightly different questions. The magnetometer
 * says where the phone is aimed and works standing still, which is what you
 * want when sighting along a bearing. GPS course says which way you are
 * actually travelling and is meaningless below walking pace. The store prefers
 * the magnetometer and says which one it is using, because a crew reading a
 * bearing off the screen needs to know whether turning the phone will change
 * it.
 */

export type HeadingPermission =
  | 'unknown'
  | 'granted'
  | 'denied'
  | 'unsupported'

interface HeadingState {
  /** Degrees clockwise from north, 0–360, or null with no compass reading. */
  heading: number | null
  permission: HeadingPermission
  /**
   * True when the reading is referenced to magnetic north rather than true
   * north, so bearings taken off it differ by the local declination.
   */
  magnetic: boolean
  listening: boolean

  /** Ask for the sensor. Safari needs this to come from a real tap. */
  enable: () => Promise<void>
  disable: () => void
}

/** Samples per second passed on to React. The sensor fires far faster. */
const UPDATE_HZ = 8
const MIN_INTERVAL_MS = 1000 / UPDATE_HZ
/** Weight of each new sample. Low enough to settle a shaking hand. */
const SMOOTHING = 0.25

let lastEmit = 0
let smoothX: number | null = null
let smoothY: number | null = null
let handler: ((e: DeviceOrientationEvent) => void) | null = null
let listeningTo: string[] = []

const RAD = Math.PI / 180

/**
 * Fold a new bearing into the running average as a unit vector.
 *
 * Averaging the numbers directly would swing to south every time the needle
 * crosses north, because 359 and 1 average to 180.
 */
function smooth(deg: number): number {
  const x = Math.cos(deg * RAD)
  const y = Math.sin(deg * RAD)
  smoothX = smoothX === null ? x : smoothX + (x - smoothX) * SMOOTHING
  smoothY = smoothY === null ? y : smoothY + (y - smoothY) * SMOOTHING
  return (Math.atan2(smoothY, smoothX) / RAD + 360) % 360
}

/** Keep the needle pointing north when the phone is turned on its side. */
function screenAngle(): number {
  const angle = window.screen?.orientation?.angle
  return typeof angle === 'number' ? angle : 0
}

interface CompassEvent extends DeviceOrientationEvent {
  /** Safari only: heading referenced to north, already screen-compensated. */
  webkitCompassHeading?: number
}

/** A north-referenced heading from an orientation event, or null. */
function headingFrom(e: CompassEvent): { deg: number; magnetic: boolean } | null {
  if (typeof e.webkitCompassHeading === 'number' && Number.isFinite(e.webkitCompassHeading)) {
    // Apple documents webkitCompassHeading as degrees relative to MAGNETIC
    // north. It was marked true here, which suppressed the declination
    // warning on exactly the platform that needed it.
    return { deg: e.webkitCompassHeading, magnetic: true }
  }
  // alpha runs anticlockwise from the reference direction, so it is subtracted
  // rather than used as-is.
  if (e.absolute && typeof e.alpha === 'number' && Number.isFinite(e.alpha)) {
    return { deg: (360 - e.alpha + screenAngle()) % 360, magnetic: true }
  }
  return null
}

export const useHeading = create<HeadingState>((set, get) => ({
  heading: null,
  permission: 'unknown',
  magnetic: false,
  listening: false,

  enable: async () => {
    if (get().listening) return

    if (typeof window === 'undefined' || !('DeviceOrientationEvent' in window)) {
      set({ permission: 'unsupported' })
      return
    }

    // iOS 13+ gates the sensor behind an explicit grant.
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

    handler = (e) => {
      const reading = headingFrom(e as CompassEvent)
      if (!reading) return

      const now = Date.now()
      const deg = smooth(reading.deg)
      if (now - lastEmit < MIN_INTERVAL_MS) return
      lastEmit = now

      set({ heading: deg, magnetic: reading.magnetic })
    }

    // Chrome exposes the Earth-referenced reading under its own event name and
    // leaves `absolute` false on the plain one; Safari does the opposite.
    listeningTo =
      'ondeviceorientationabsolute' in window
        ? ['deviceorientationabsolute', 'deviceorientation']
        : ['deviceorientation']
    for (const name of listeningTo) {
      window.addEventListener(name, handler as EventListener)
    }

    set({ permission: 'granted', listening: true })
  },

  disable: () => {
    if (handler) {
      for (const name of listeningTo) {
        window.removeEventListener(name, handler as EventListener)
      }
      handler = null
      listeningTo = []
    }
    smoothX = null
    smoothY = null
    set({ listening: false, heading: null })
  },
}))
