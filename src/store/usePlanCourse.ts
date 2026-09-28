import { create } from 'zustand'
import { CLOSED, planCourseReducer, type PlanAction, type PlanCourseState } from '@/lib/planCourse'

/**
 * The "Plan a course" stepper's state (see `lib/planCourse.ts`), shared by
 * the sheet and the chart it picks points on. Not persisted: a flow half
 * done is not worth keeping across a reload, and cancelling it never touches
 * the passage.
 */
export const usePlanCourse = create<PlanCourseState & { dispatch: (a: PlanAction) => void }>()((set, get) => ({
  ...CLOSED,
  dispatch: (a) => {
    const { dispatch, ...state } = get()
    void dispatch
    set(planCourseReducer(state, a))
  },
}))
