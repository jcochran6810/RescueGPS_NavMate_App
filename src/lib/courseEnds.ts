/** The two ends of a course and the colour each is drawn in — see components/CourseEnds.tsx. */
export type CourseEnd = 'start' | 'dest'

export const END_STYLE: Record<CourseEnd, { letter: string; badge: string; ring: string; text: string }> = {
  start: {
    letter: 'A',
    badge: 'bg-emerald-400 text-navy-950',
    ring: 'border-emerald-400/50 bg-emerald-500/10',
    text: 'text-emerald-300',
  },
  dest: {
    letter: 'B',
    badge: 'bg-violet-400 text-navy-950',
    ring: 'border-violet-400/50 bg-violet-500/10',
    text: 'text-violet-300',
  },
}

export function endText(end: CourseEnd): string {
  return END_STYLE[end].text
}
