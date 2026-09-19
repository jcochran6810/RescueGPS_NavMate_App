import { useEffect, useState } from 'react'
import { Button, Card, Field, Label } from '@/components/ui'
import { Sheet } from '@/components/Sheet'
import { useVictims } from '@/store/useVictims'
import { toast } from '@/store/useToast'
import {
  BODY_TYPES,
  CLOTHING_TYPES,
  EMPTY_VICTIM,
  GENDERS,
  INTOXICATION,
  SWIMMING_ABILITY,
  VICTIM_STATUS,
  victimIsEmpty,
  victimSummary,
  type VictimDraft,
  type VictimOption,
} from '@/lib/victim'

/**
 * Who is being looked for, on the screen the search is run from.
 *
 * It sits under the incident because that is what it belongs to — the command
 * system keys `victims` on `incident_id`, and this writes that table directly,
 * so a description typed on a boat is the description the command dashboard
 * shows without anyone retyping it.
 *
 * The summary line is the point of the card. What a searcher needs at a glance
 * is the colour of the clothing and whether there is a life jacket; everything
 * else is detail they can open. So the line reads like a radio call, and the
 * life jacket is always in it — including when the answer is that nobody has
 * said, which is itself worth seeing.
 */
export function VictimCard({ incidentId }: { incidentId: string }) {
  const stored = useVictims((s) => s.drafts[incidentId] ?? null)
  const load = useVictims((s) => s.load)
  const save = useVictims((s) => s.save)
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    void load(incidentId)
  }, [incidentId, load])

  const has = stored && !victimIsEmpty(stored)

  return (
    <Card>
      <div className="flex items-start justify-between gap-2">
        <Label>Who we are looking for</Label>
        {has && (
          <button
            onClick={() => setEditing(true)}
            className="mb-1.5 shrink-0 rounded-lg border border-white/10 px-2 py-1 text-xs text-slate-300 hover:bg-white/5"
          >
            Edit
          </button>
        )}
      </div>

      {has ? (
        <p className="text-sm text-slate-100">{victimSummary(stored)}</p>
      ) : (
        <>
          <p className="mb-2 text-xs text-slate-400">
            Clothing colour and whether there is a life jacket are what a
            searcher scans for; build, clothing weight and swimming ability are
            what the survival estimate runs on.
          </p>
          <Button variant="primary" className="w-full" onClick={() => setEditing(true)}>
            Add victim details
          </Button>
        </>
      )}

      {editing && (
        <VictimSheet
          initial={stored ?? EMPTY_VICTIM}
          onSave={async (draft) => {
            await save(incidentId, draft)
            toast('Victim details saved', 'success')
          }}
          onDismiss={() => setEditing(false)}
        />
      )}
    </Card>
  )
}

/**
 * The form on its own.
 *
 * `onSave` rather than a hard-wired store write, because this is filled in
 * twice in different circumstances: against an incident that exists, and —
 * more often, since it is what the caller is being asked — while one is being
 * opened, where there is no id to key it on yet. The second case keeps the
 * draft and writes it the moment the incident has an id.
 */
export function VictimSheet({
  initial,
  onSave,
  onDismiss,
}: {
  initial: VictimDraft
  onSave: (draft: VictimDraft) => void | Promise<void>
  onDismiss: () => void
}) {
  const [v, setV] = useState<VictimDraft>(initial)
  const set = <K extends keyof VictimDraft>(k: K, value: VictimDraft[K]) =>
    setV((d) => ({ ...d, [k]: value }))

  return (
    <Sheet label="Victim details" onDismiss={onDismiss}>
      <Label>Description</Label>
      <div className="space-y-2">
        <Field
          label="Name"
          value={v.name}
          onChange={(e) => set('name', e.target.value)}
          placeholder="If known"
          maxLength={120}
        />
        <div className="grid grid-cols-2 gap-2">
          <Field
            label="Age"
            value={v.age}
            onChange={(e) => set('age', e.target.value)}
            inputMode="numeric"
            placeholder="years"
          />
          <Choice
            label="Sex"
            value={v.gender}
            options={GENDERS}
            onChange={(x) => set('gender', x)}
          />
        </div>

        <div className="grid grid-cols-3 gap-2">
          <Field
            label="Height (ft)"
            value={v.height_ft}
            onChange={(e) => set('height_ft', e.target.value)}
            inputMode="numeric"
            placeholder="5"
          />
          <Field
            label="(in)"
            value={v.height_in}
            onChange={(e) => set('height_in', e.target.value)}
            inputMode="numeric"
            placeholder="10"
          />
          <Field
            label="Weight (lb)"
            value={v.weight_lbs}
            onChange={(e) => set('weight_lbs', e.target.value)}
            inputMode="numeric"
            placeholder="180"
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Check
            label="Height estimated"
            checked={v.height_estimated}
            onChange={(x) => set('height_estimated', x)}
          />
          <Check
            label="Weight estimated"
            checked={v.weight_estimated}
            onChange={(x) => set('weight_estimated', x)}
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Choice
            label="Build"
            value={v.body_type}
            options={BODY_TYPES}
            onChange={(x) => set('body_type', x)}
          />
          <Field
            label="Hair"
            value={v.hair_color}
            onChange={(e) => set('hair_color', e.target.value)}
            placeholder="dark, grey…"
            maxLength={60}
          />
        </div>
      </div>

      <Label>What they are wearing</Label>
      <div className="space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <Field
            label="Top colour"
            value={v.upper_clothing_color}
            onChange={(e) => set('upper_clothing_color', e.target.value)}
            placeholder="red"
            maxLength={60}
          />
          <Field
            label="Top"
            value={v.upper_clothing}
            onChange={(e) => set('upper_clothing', e.target.value)}
            placeholder="t-shirt"
            maxLength={60}
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field
            label="Bottom colour"
            value={v.lower_clothing_color}
            onChange={(e) => set('lower_clothing_color', e.target.value)}
            placeholder="blue"
            maxLength={60}
          />
          <Field
            label="Bottom"
            value={v.lower_clothing}
            onChange={(e) => set('lower_clothing', e.target.value)}
            placeholder="jeans"
            maxLength={60}
          />
        </div>
        <Choice
          label="Clothing weight in the water"
          value={v.clothing_type}
          options={CLOTHING_TYPES}
          onChange={(x) => set('clothing_type', x)}
          hint="Heavy clothing shortens the survival window; an immersion suit lengthens it."
        />
      </div>

      <Label>Flotation and condition</Label>
      <div className="space-y-2">
        <Check
          label="Wearing a life jacket"
          checked={v.has_life_jacket}
          onChange={(x) => set('has_life_jacket', x)}
        />
        {v.has_life_jacket && (
          <div className="grid grid-cols-2 gap-2">
            <Field
              label="Life jacket colour"
              value={v.life_jacket_color}
              onChange={(e) => set('life_jacket_color', e.target.value)}
              placeholder="orange"
              maxLength={60}
            />
            <Check
              label="Reflective tape"
              checked={v.life_jacket_has_reflective}
              onChange={(x) => set('life_jacket_has_reflective', x)}
            />
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          <Choice
            label="Swimming ability"
            value={v.swimming_ability}
            options={SWIMMING_ABILITY}
            onChange={(x) => set('swimming_ability', x)}
          />
          <Choice
            label="Alcohol or drugs"
            value={v.intoxication_level}
            options={INTOXICATION}
            onChange={(x) => set('intoxication_level', x)}
          />
        </div>
        <Field
          label="Injuries or medical"
          value={v.injuries}
          onChange={(e) => set('injuries', e.target.value)}
          placeholder="Anything that changes how they will cope"
          maxLength={400}
        />
        <Choice
          label="Status"
          value={v.status}
          options={VICTIM_STATUS}
          onChange={(x) => set('status', x)}
        />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button variant="ghost" onClick={onDismiss}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={async () => {
            await onSave(v)
            onDismiss()
          }}
        >
          Save details
        </Button>
      </div>
    </Sheet>
  )
}

function Choice({
  label,
  value,
  options,
  onChange,
  hint,
}: {
  label: string
  value: string
  options: VictimOption[]
  onChange: (v: string) => void
  hint?: string
}) {
  return (
    <div className="space-y-1">
      <label className="block text-xs font-semibold text-slate-300">{label}</label>
      <select
        value={value}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-11 w-full rounded-xl border border-white/10 bg-navy-950/60 px-3 text-slate-100 focus:border-sky-400/60 focus:outline-none"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint ? <p className="text-[11px] text-slate-400">{hint}</p> : null}
    </div>
  )
}

function Check({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="flex min-h-11 items-center gap-2 rounded-xl border border-white/10 bg-navy-950/60 px-3 text-sm text-slate-100">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 accent-sky-400"
      />
      {label}
    </label>
  )
}
