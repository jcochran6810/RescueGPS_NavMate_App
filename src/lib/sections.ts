import type { LucideIcon } from 'lucide-react'
import {
  ArrowLeftRight,
  ArrowUpDown,
  CircleHelp,
  Compass,
  Flag,
  Footprints,
  House,
  LifeBuoy,
  Map,
  MapPin,
  Radar,
  ScanSearch,
  Settings,
  ShieldCheck,
  Timer,
  Users,
  Waves,
} from 'lucide-react'

/**
 * Every section of the app, in one list: its name, a one-line hint, the icon
 * it is drawn with, and the job it belongs to. The bottom bar, the More grid,
 * Home's tool tiles and the search steps all read from here, so a section has
 * one name everywhere it appears.
 */
export const SECTIONS = [
  { id: 'home', label: 'Home', hint: 'Position, daylight and nearby waypoints', group: 'Navigate', icon: House },
  { id: 'chart', label: 'Chart plotter', short: 'Chart', hint: 'Charted depths, and a course to steer', group: 'Navigate', icon: Map },
  { id: 'compass', label: 'Compass', hint: 'Heading and bearings to waypoints', group: 'Navigate', icon: Compass },
  { id: 'track', label: 'Live tracking', short: 'Tracking', hint: 'Live position and your path', group: 'Navigate', icon: Footprints },
  { id: 'eta', label: 'ETA to waypoint', short: 'ETA', hint: 'Time to run, and 60 D = S × T', group: 'Navigate', icon: Timer },
  { id: 'tides', label: 'Tides', hint: 'High and low water near you', group: 'Navigate', icon: Waves },
  { id: 'convert', label: 'Convert', hint: 'Coordinate formats and UTM', group: 'Navigate', icon: ArrowLeftRight },
  { id: 'incident', label: 'Incident', hint: 'Open or join a search, victim, orders from command', group: 'Search', icon: LifeBuoy },
  { id: 'datum', label: 'Search datum', short: 'Datum', hint: 'LKP, conditions, drift and where to search', group: 'Search', icon: Radar },
  { id: 'search', label: 'Search pattern', short: 'Pattern', hint: 'Run a pattern, spacing, survival clock', group: 'Search', icon: ScanSearch },
  { id: 'clues', label: 'Clue log', short: 'Clues', hint: 'What you found, where, with a photo', group: 'Search', icon: Flag },
  { id: 'waypoints', label: 'Waypoints', hint: 'Everything saved, with photos', group: 'Records', icon: MapPin },
  { id: 'team', label: 'Team', hint: 'Members, join codes and roles', group: 'Records', icon: Users },
  { id: 'data', label: 'Data', hint: 'Import, export and email', group: 'Records', icon: ArrowUpDown },
  { id: 'settings', label: 'Settings', hint: 'Units, coordinates and navigation', group: 'App', icon: Settings },
  { id: 'help', label: 'Help / Contact', short: 'Help', hint: 'Send the platform admin a request', group: 'App', icon: CircleHelp },
  // Only shown to platform admins — and that is cosmetic; the database
  // enforces it whether or not the entry shows.
  { id: 'admin', label: 'Platform admin', short: 'Admin', hint: 'Metrics, requests and accounts', group: 'App', icon: ShieldCheck, adminOnly: true },
] as const satisfies readonly {
  id: string
  label: string
  short?: string
  hint: string
  group: string
  icon: LucideIcon
  adminOnly?: boolean
}[]

export type TabId = (typeof SECTIONS)[number]['id']
export type Section = (typeof SECTIONS)[number]

export const GROUP_ORDER = ['Navigate', 'Search', 'Records', 'App'] as const

export function isTabId(id: string): id is TabId {
  return SECTIONS.some((s) => s.id === id)
}

export function section(id: TabId): Section {
  return SECTIONS.find((s) => s.id === id)!
}

/** The short name, for a button with room for one word. */
export function shortLabel(s: Section): string {
  return 'short' in s ? s.short : s.label
}

/**
 * The search, as the four steps it is actually worked in: open the incident,
 * fix the datum, run the pattern, log what turns up. Each is its own screen,
 * so no one screen is a twelve-card scroll.
 */
export const SEARCH_STEPS = ['incident', 'datum', 'search', 'clues'] as const satisfies readonly TabId[]
export type SearchStep = (typeof SEARCH_STEPS)[number]

export function isSearchStep(id: TabId): id is SearchStep {
  return (SEARCH_STEPS as readonly string[]).includes(id)
}

/** The bottom bar's tab that owns a section — what lights up while it is open. */
export function barTabFor(id: TabId): 'home' | 'chart' | 'search' | 'more' {
  if (id === 'home') return 'home'
  if (id === 'chart') return 'chart'
  if (isSearchStep(id)) return 'search'
  return 'more'
}
