import { useMemo, useState, type ReactNode } from 'react'
import { Sheet } from '@/components/Sheet'
import { Button, Field } from '@/components/ui'
import { useTracker } from '@/store/useTracker'
import { toast } from '@/store/useToast'
import type { Answers } from '@/lib/wizard/rows'
import {
  INCIDENT_TYPE_CHOICES,
  VICTIM_FIELDS,
  emptyVictim,
  fieldShown,
  fieldsFor,
  missingAnswers,
  optionsFor,
  stepsFor,
  withPosition,
  type MissingAnswer,
  type WizardField,
} from '@/lib/wizard/answers'

/**
 * The new-incident wizard — the same questions, in the same order and with
 * the same choices, as command's wizard in RescueGPS (lib/wizard/
 * wizardSchema.json), saved the way command saves them (lib/wizard/rows.ts).
 * An incident started on a boat therefore opens in command with every answer
 * in its place, and command reopens the same wizard there to fill in what the
 * crew could not.
 *
 * Nothing blocks. A crew is often told half the story at the moment the
 * search starts, so each step shows what is still missing and carries on;
 * the summary lists it all before the incident opens.
 *
 * The answers live with the caller, so dismissing the sheet (a stray tap on
 * the backdrop) keeps them for when it is opened again.
 */
export function IncidentWizard({
  answers,
  onChange,
  onSubmit,
  onDismiss,
  onDiscard,
  busy,
}: {
  answers: Answers
  onChange: (next: Answers) => void
  onSubmit: () => void
  onDismiss: () => void
  onDiscard: () => void
  busy: boolean
}) {
  const [index, setIndex] = useState(0)
  const steps = stepsFor(answers.incidentType)
  const at = Math.min(index, steps.length - 1)
  const step = steps[at]
  const missing = useMemo(() => missingAnswers(answers), [answers])
  const missingHere = missing.filter((m) => m.step === step.id)
  const last = at === steps.length - 1 && !!answers.incidentType

  const set = (patch: Answers) => onChange({ ...answers, ...patch })

  return (
    <Sheet label="New search incident" onDismiss={onDismiss}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <div className="text-xs font-semibold tracking-wide text-slate-300 uppercase">New search incident</div>
          <div className="text-base font-semibold text-slate-50">{step.label}</div>
        </div>
        <div className="text-xs text-slate-400 tnum">
          {answers.incidentType ? `${at + 1} of ${steps.length}` : ''}
        </div>
      </div>
      {answers.incidentType ? (
        <div className="mb-4 flex gap-1" aria-hidden="true">
          {steps.map((s, i) => (
            <span key={s.id} className={'h-1 flex-1 rounded-full ' + (i <= at ? 'bg-sky-400' : 'bg-white/10')} />
          ))}
        </div>
      ) : null}

      <div className="space-y-3 pb-2">
        {step.id === 'type' ? (
          <TypeStep value={String(answers.incidentType ?? '')} onPick={(id) => { set({ incidentType: id }); setIndex(1) }} />
        ) : step.id === 'summary' ? (
          <SummaryStep answers={answers} missing={missing} />
        ) : (
          fieldsFor(step.id)
            .filter((f) => fieldShown(answers, f))
            .map((f, i) => (
              <FieldInput key={`${f.key}-${i}`} field={f} answers={answers} onChange={onChange} />
            ))
        )}
        {step.id === 'password' && (
          <p className="text-[11px] text-slate-400">
            Leave it empty and other crews ask to join instead; command can set one later.
          </p>
        )}
      </div>

      {missingHere.length > 0 && step.id !== 'summary' && (
        <p className="mb-2 rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          Not filled in yet: {missingHere.map((m) => m.label).join(', ')}. You can carry on — command can
          complete it in RescueGPS.
        </p>
      )}

      <div className="safe-bottom sticky bottom-0 -mx-4 flex gap-2 border-t border-white/10 bg-navy-900 px-4 py-3">
        {at > 0 ? (
          <Button onClick={() => setIndex(at - 1)} disabled={busy}>Back</Button>
        ) : (
          <Button variant="ghost" onClick={onDiscard} disabled={busy}>Discard</Button>
        )}
        {last ? (
          <Button variant="primary" className="flex-1" onClick={onSubmit} disabled={busy}>
            {busy ? 'Opening…' : 'Start search incident'}
          </Button>
        ) : (
          <Button
            variant="primary"
            className="flex-1"
            onClick={() => setIndex(at + 1)}
            disabled={busy || !answers.incidentType}
          >
            Next
          </Button>
        )}
      </div>
    </Sheet>
  )
}

function TypeStep({ value, onPick }: { value: string; onPick: (id: string) => void }) {
  return (
    <div className="grid gap-2">
      {INCIDENT_TYPE_CHOICES.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onPick(t.id)}
          aria-pressed={value === t.id}
          className={
            'min-h-14 rounded-xl border px-3 py-2 text-left transition-colors ' +
            (value === t.id ? 'border-sky-400/60 bg-sky-500/15' : 'border-white/10 hover:bg-white/5')
          }
        >
          <div className="text-sm font-semibold text-slate-100">{t.label}</div>
          <div className="text-xs text-slate-400">{t.description}</div>
        </button>
      ))}
    </div>
  )
}

const inputClass =
  'min-h-11 w-full rounded-xl border border-white/10 bg-navy-950/60 px-3 text-slate-100 ' +
  'placeholder:text-slate-400 focus:border-sky-400/60 focus:outline-none'

function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="block text-xs font-semibold text-slate-300">{label}</span>
      {children}
    </label>
  )
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex min-h-9 items-center gap-2 text-xs text-slate-300">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-4" />
      {label}
    </label>
  )
}

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v))

/** One question, rendered by its kind. Victim questions get the person's answers. */
function FieldInput({
  field,
  answers,
  onChange,
}: {
  field: WizardField
  answers: Answers
  onChange: (next: Answers) => void
}) {
  const set = (patch: Answers) => onChange({ ...answers, ...patch })
  const k = field.key
  switch (field.kind) {
    case 'yesno':
      return (
        <Labelled label={field.label}>
          <div className="flex gap-2">
            {[true, false].map((v) => (
              <button
                key={String(v)}
                type="button"
                aria-pressed={answers[k] === v}
                onClick={() => set({ [k]: v })}
                className={
                  'min-h-11 flex-1 rounded-xl border px-3 text-sm font-semibold ' +
                  (answers[k] === v ? 'border-sky-400/60 bg-sky-500/15 text-sky-200' : 'border-white/10 text-slate-300')
                }
              >
                {v ? field.yes ?? 'Yes' : field.no ?? 'No'}
              </button>
            ))}
          </div>
        </Labelled>
      )
    case 'position':
      return <PositionInput field={field} answers={answers} onChange={onChange} />
    case 'select':
      return (
        <Labelled label={field.label}>
          <select value={str(answers[k])} onChange={(e) => set({ [k]: e.target.value })} className={inputClass}>
            <option value="">Not recorded</option>
            {optionsFor(field.options).map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </Labelled>
      )
    case 'textarea':
      return (
        <Labelled label={field.label}>
          <textarea value={str(answers[k])} rows={3} onChange={(e) => set({ [k]: e.target.value })} className={inputClass + ' py-2'} />
        </Labelled>
      )
    case 'number':
      return (
        <div className="space-y-1">
          <Field
            label={field.label}
            inputMode="decimal"
            value={str(answers[k])}
            onChange={(e) => set({ [k]: e.target.value })}
          />
          {field.estimate && (
            <Check label="Estimate" checked={answers[field.estimate] === true} onChange={(v) => set({ [field.estimate!]: v })} />
          )}
        </div>
      )
    case 'datetime':
      return (
        <Labelled label={field.label}>
          <input type="datetime-local" value={str(answers[k])} onChange={(e) => set({ [k]: e.target.value })} className={inputClass} />
        </Labelled>
      )
    case 'dateparts': {
      const h = str(answers[field.hour!])
      const m = str(answers[field.minute!])
      const time = h !== '' && m !== '' ? `${h.padStart(2, '0')}:${m.padStart(2, '0')}` : ''
      return (
        <div className="space-y-1">
          <span className="block text-xs font-semibold text-slate-300">{field.label}</span>
          <div className="flex gap-2">
            <input
              type="date"
              aria-label={`${field.label} date`}
              value={str(answers[field.date!])}
              onChange={(e) => set({ [field.date!]: e.target.value })}
              className={inputClass}
            />
            <input
              type="time"
              aria-label={`${field.label} time`}
              value={time}
              onChange={(e) => {
                const [hh, mm] = e.target.value.split(':')
                set({ [field.hour!]: hh ?? '', [field.minute!]: mm ?? '' })
              }}
              className={inputClass}
            />
          </div>
          {field.estimate && (
            <Check label="Estimate" checked={answers[field.estimate] === true} onChange={(v) => set({ [field.estimate!]: v })} />
          )}
        </div>
      )
    }
    case 'victims':
      return <PeopleInput answers={answers} onChange={onChange} />
    case 'checkbox':
      return <Check label={field.label} checked={answers[k] === true} onChange={(v) => set({ [k]: v })} />
    case 'height':
      return (
        <div className="space-y-1">
          <span className="block text-xs font-semibold text-slate-300">{field.label}</span>
          <div className="flex gap-2">
            <input aria-label="Feet" inputMode="numeric" placeholder="ft" value={str(answers[field.feet!])} onChange={(e) => set({ [field.feet!]: e.target.value })} className={inputClass} />
            <input aria-label="Inches" inputMode="numeric" placeholder="in" value={str(answers[field.inches!])} onChange={(e) => set({ [field.inches!]: e.target.value })} className={inputClass} />
          </div>
          {field.estimate && (
            <Check label="Estimate" checked={answers[field.estimate] === true} onChange={(v) => set({ [field.estimate!]: v })} />
          )}
        </div>
      )
    case 'multiselect': {
      const picked = Array.isArray(answers[k]) ? (answers[k] as string[]) : []
      const opts = optionsFor(field.options)
      return (
        <div className="space-y-1">
          <span className="block text-xs font-semibold text-slate-300">{field.label}</span>
          <div className="flex flex-wrap gap-1.5">
            {opts.map((o) => {
              const on = picked.includes(o.value)
              return (
                <button
                  key={o.value}
                  type="button"
                  aria-pressed={on}
                  onClick={() => {
                    const codes = on ? picked.filter((c) => c !== o.value) : [...picked, o.value]
                    // RescueGPS keeps the names as text beside the codes.
                    const names = opts.filter((x) => codes.includes(x.value)).map((x) => x.label).join('; ')
                    set({ [k]: codes, medicalConditions: names })
                  }}
                  className={
                    'rounded-lg border px-2 py-1 text-xs ' +
                    (on ? 'border-sky-400/60 bg-sky-500/15 text-sky-200' : 'border-white/10 text-slate-300')
                  }
                >
                  {o.label}
                </button>
              )
            })}
          </div>
        </div>
      )
    }
    case 'password':
      return (
        <Field label={field.label} type="password" autoComplete="new-password" value={str(answers[k])} onChange={(e) => set({ [k]: e.target.value })} />
      )
    default:
      return (
        <Field
          label={field.label}
          type={field.kind === 'tel' ? 'tel' : 'text'}
          value={str(answers[k])}
          onChange={(e) => set({ [k]: e.target.value })}
        />
      )
  }
}

/** A position: typed in decimal degrees, or this phone's GPS fix. */
function PositionInput({ field, answers, onChange }: { field: WizardField; answers: Answers; onChange: (next: Answers) => void }) {
  const fix = useTracker((s) => s.fix)
  const lat = str(answers[field.lat!])
  const lng = str(answers[field.lng!])
  const setTyped = (la: string, ln: string) => {
    const a = parseFloat(la)
    const b = parseFloat(ln)
    if (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180) {
      onChange(withPosition(answers, field, a, b))
    } else {
      // Keep what is being typed; it becomes a position once both parse.
      onChange({ ...answers, [field.lat!]: la, [field.lng!]: ln })
    }
  }
  return (
    <div className="space-y-1">
      <span className="block text-xs font-semibold text-slate-300">{field.label}</span>
      <div className="flex gap-2">
        <input aria-label="Latitude" inputMode="decimal" placeholder="Lat e.g. 29.7035" value={lat} onChange={(e) => setTyped(e.target.value, lng)} className={inputClass} />
        <input aria-label="Longitude" inputMode="decimal" placeholder="Lon e.g. -95.0163" value={lng} onChange={(e) => setTyped(lat, e.target.value)} className={inputClass} />
      </div>
      <button
        type="button"
        onClick={() => {
          if (!fix) {
            toast('No GPS fix yet — type the position or try again in a moment', 'error')
            return
          }
          const next = withPosition(answers, field, fix.lat, fix.lon)
          // Where the crew is standing: say so, unless a source was given.
          if (field.lat === 'lkpLat' && !next.positionSource) next.positionSource = 'gps_device'
          onChange(next)
        }}
        className="min-h-9 rounded-lg border border-white/10 px-3 text-xs text-slate-200 hover:bg-white/5"
      >
        Use my GPS position{fix?.accuracy != null ? ` (±${Math.round(fix.accuracy)} m)` : ''}
      </button>
    </div>
  )
}

/** The people being searched for (or aboard), one card each. */
function PeopleInput({ answers, onChange }: { answers: Answers; onChange: (next: Answers) => void }) {
  const people = answers.victims ?? []
  const setPerson = (i: number, v: Answers) => {
    const next = people.slice()
    next[i] = v
    onChange({ ...answers, victims: next })
  }
  return (
    <div className="space-y-3">
      {people.map((p, i) => (
        <div key={i} className="space-y-2 rounded-xl border border-white/10 p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-slate-100">Person {i + 1}</span>
            {i > 0 && (
              <button
                type="button"
                onClick={() => onChange({ ...answers, victims: people.filter((_, j) => j !== i) })}
                className="min-h-9 rounded-lg border border-white/10 px-2 text-xs text-slate-300"
              >
                Remove
              </button>
            )}
          </div>
          {VICTIM_FIELDS.filter((f) => fieldShown(p, f, answers.incidentType)).map((f) => (
            <FieldInput key={f.key} field={f} answers={p} onChange={(v) => setPerson(i, v)} />
          ))}
        </div>
      ))}
      <Button className="w-full" onClick={() => onChange({ ...answers, victims: [...people, emptyVictim()] })}>
        Add another person
      </Button>
    </div>
  )
}

/** Everything answered, and everything still missing, before the incident opens. */
function SummaryStep({ answers, missing }: { answers: Answers; missing: MissingAnswer[] }) {
  const rows: { label: string; value: string }[] = []
  const add = (label: string, value: unknown) => {
    const v = str(value).trim()
    if (v) rows.push({ label, value: v })
  }
  const type = INCIDENT_TYPE_CHOICES.find((t) => t.id === answers.incidentType)
  add('Incident type', type?.label)
  for (const s of stepsFor(answers.incidentType)) {
    if (s.id === 'type') continue
    for (const f of fieldsFor(s.id)) {
      if (!fieldShown(answers, f) || f.kind === 'victims' || f.kind === 'password') continue
      if (f.kind === 'position') add(f.label, answers[f.lat!] !== '' && answers[f.lng!] !== '' ? `${str(answers[f.lat!])}, ${str(answers[f.lng!])}` : '')
      else if (f.kind === 'dateparts') add(f.label, answers[f.hour!] !== '' ? `${str(answers[f.date!])} ${str(answers[f.hour!]).padStart(2, '0')}:${str(answers[f.minute!]).padStart(2, '0')}` : '')
      else if (f.kind === 'yesno') add(f.label, answers[f.key] === true ? f.yes ?? 'Yes' : answers[f.key] === false ? f.no ?? 'No' : '')
      else if (f.kind === 'select') add(f.label, optionsFor(f.options).find((o) => o.value === answers[f.key])?.label)
      else add(f.label, answers[f.key])
    }
  }
  const people = (answers.victims ?? []).length
  if (people) rows.push({ label: 'People entered', value: String(people) })
  return (
    <div className="space-y-3">
      <dl className="space-y-1 text-sm">
        {rows.map((r, i) => (
          <div key={`${i}-${r.label}`} className="flex justify-between gap-3">
            <dt className="text-slate-400">{r.label}</dt>
            <dd className="text-right text-slate-100">{r.value}</dd>
          </div>
        ))}
      </dl>
      {missing.length > 0 ? (
        <div className="rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          <div className="mb-1 font-semibold">Still missing ({missing.length})</div>
          <ul className="list-disc pl-4">
            {missing.map((m, i) => (
              <li key={i}>{m.stepLabel}: {m.label}</li>
            ))}
          </ul>
          <div className="mt-1">The incident opens anyway; command can complete these in RescueGPS.</div>
        </div>
      ) : (
        <p className="text-xs text-emerald-300">Every required answer is in.</p>
      )}
    </div>
  )
}
